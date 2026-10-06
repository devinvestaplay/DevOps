import { AwsError } from "../aws/client";
import type { DeploymentExecutionConfig, DeploymentStepType, PreflightProbeType } from "./types";

function invalid(field: string): never { throw new AwsError("DEPLOYMENT_CONFIG_INVALID", 422, `Invalid deployment ${field}`); }

export function validateServerPath(value: string): string {
  if (typeof value !== "string" || value.length > 240 || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value)) invalid("path");
  if (value.split("/").some((part) => part === ".." || part === "." || part.startsWith("-"))) invalid("path");
  return value;
}

export function validateBranch(value: string): string {
  if (typeof value !== "string" || value.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) invalid("branch");
  if (value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".") || value.split("/").some((part) => part.startsWith("."))) invalid("branch");
  return value;
}

export function validateSha(value: string): string {
  if (typeof value !== "string" || !/^[a-fA-F0-9]{40}$/.test(value)) invalid("commit SHA");
  return value.toLowerCase();
}

export function validateProcessName(value: string): string {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) invalid("process name");
  return value;
}

export function validateHealthUrl(value: string): string {
  if (typeof value !== "string" || value.length > 300) invalid("health URL");
  let parsed: URL;
  try { parsed = new URL(value); } catch { invalid("health URL"); }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.port || parsed.pathname.includes("..")) invalid("health URL");
  if (!/^\/[A-Za-z0-9/_-]*$/.test(parsed.pathname)) invalid("health URL");
  return value;
}

export function validateRepositoryPart(value: string): string {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value === "." || value === "..") invalid("repository identity");
  return value;
}

export function validateExecutionAccount(value: string): string {
  if (typeof value !== "string" || value.length > 32 || !/^[a-z_][a-z0-9_-]*$/.test(value)) invalid("execution account");
  return value;
}

export function validateSshHostAlias(value: string): string {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) invalid("SSH host alias");
  return value;
}

export function validateExecutionConfig(config: DeploymentExecutionConfig): DeploymentExecutionConfig {
  const repositoryPath = validateServerPath(config.repositoryPath);
  const applicationPath = validateServerPath(config.applicationPath);
  if (applicationPath !== repositoryPath && !applicationPath.startsWith(`${repositoryPath}/`)) invalid("application path");
  validateBranch(config.allowedBranch);
  validateSha(config.targetSha);
  if (config.previousSha !== undefined) validateSha(config.previousSha);
  validateProcessName(config.processName);
  validateRepositoryPart(config.expectedRepositoryOwner);
  validateRepositoryPart(config.expectedRepositoryName);
  validateExecutionAccount(config.executionAccount);
  if (config.repositorySshHostAlias !== null) validateSshHostAlias(config.repositorySshHostAlias);
  validateHealthUrl(config.healthUrl);
  if (config.packageManager !== "npm" || !["none", "npm_ci"].includes(config.installStrategy) || !["none", "npm_build"].includes(config.buildStrategy) || config.processManager !== "pm2") invalid("strategy");
  if (!Number.isInteger(config.healthTimeoutSeconds) || config.healthTimeoutSeconds < 2 || config.healthTimeoutSeconds > 30) invalid("health timeout");
  return config;
}

// Every interpolated value is validated above and single-quoted. The allowed character
// sets exclude quotes, whitespace, shell metacharacters and command substitution.
function q(value: string): string { return `'${value}'`; }
function shellQuote(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
function asAccount(command: string, config: DeploymentExecutionConfig): string {
  // runuser resets HOME to the target user's passwd home. Remove any inherited
  // PM2_HOME so a probe cannot select the SSM caller's daemon.
  const homeCheck = `expected_home="$(getent passwd ${q(config.executionAccount)} | cut -d: -f6)"; if [ -z "$expected_home" ] || [ "$HOME" != "$expected_home" ]; then echo EXECUTION_HOME_MISMATCH; exit 1; fi; `;
  return `runuser -u ${q(config.executionAccount)} -- env -u PM2_HOME sh -c ${shellQuote(homeCheck + command)}`;
}

// PM2 CLI can start a new daemon while answering a list request. Require an
// already-running daemon and its existing RPC socket before any PM2 CLI call.
const existingPm2Daemon = 'test -S "${PM2_HOME:-$HOME/.pm2}/rpc.sock" && test -r "${PM2_HOME:-$HOME/.pm2}/pm2.pid" && kill -0 "$(cat "${PM2_HOME:-$HOME/.pm2}/pm2.pid")" && ps -p "$(cat "${PM2_HOME:-$HOME/.pm2}/pm2.pid")" -o args= | grep -Eq "PM2|Daemon.js"';

export function buildStepCommand(step: DeploymentStepType, config: DeploymentExecutionConfig): string {
  validateExecutionConfig(config);
  const repo = q(config.repositoryPath), app = q(config.applicationPath), sha = q(config.targetSha);
  const health = q(config.healthUrl), timeout = config.healthTimeoutSeconds;
  let command: string;
  switch (step) {
    case "capture_current_revision": command = `status="$(GIT_OPTIONAL_LOCKS=0 git -C ${repo} -c core.fsmonitor=false status --porcelain --untracked-files=no)" || { echo STATUS_UNAVAILABLE; exit 1; }; if [ -n "$status" ]; then echo WORKTREE_DIRTY; exit 1; fi; git -C ${repo} rev-parse --verify HEAD`; break;
    case "fetch_source": command = `git -C ${repo} fetch --no-tags origin ${q(config.allowedBranch)} && test "$(git -C ${repo} rev-parse FETCH_HEAD)" = ${sha}`; break;
    case "checkout_revision": command = `git -C ${repo} checkout --detach ${sha}`; break;
    case "install_dependencies": case "rollback_install":
      if (config.installStrategy !== "npm_ci") invalid("install step");
      command = `cd -- ${app} && npm ci --ignore-scripts`; break;
    case "build": case "rollback_build":
      if (config.buildStrategy !== "npm_build") invalid("build step");
      command = `cd -- ${app} && npm --ignore-scripts run build`; break;
    case "restart_service": command = `${existingPm2Daemon} && pm2 restart ${q(config.processName)}`; break;
    case "health_check": case "rollback_health_check":
      command = `curl --fail --silent --show-error --max-time ${timeout} --output /dev/null --write-out 'HTTP %{http_code}; duration %{time_total}s' ${health}`; break;
    case "rollback_checkout":
      if (!config.previousSha) invalid("rollback SHA");
      command = `git -C ${repo} checkout --detach ${q(config.previousSha)}`; break;
    case "rollback_restart": command = `${existingPm2Daemon} && pm2 restart ${q(config.processName)}`; break;
    default: return invalid("step");
  }
  return asAccount(command, config);
}

export function buildProbeCommand(probe: PreflightProbeType, config: DeploymentExecutionConfig): string {
  validateExecutionConfig(config);
  const repo = q(config.repositoryPath), app = q(config.applicationPath);
  switch (probe) {
    case "repository": {
      const owner = config.expectedRepositoryOwner, name = config.expectedRepositoryName;
      const https = q(`https://github.com/${owner}/${name}`), ssh = q(`git@github.com:${owner}/${name}`);
      const httpsGit = q(`https://github.com/${owner}/${name}.git`), sshGit = q(`git@github.com:${owner}/${name}.git`);
      const alias = config.repositorySshHostAlias;
      const aliasUrl = alias ? q(`git@${alias}:${owner}/${name}.git`) : null;
      const aliasCheck = alias ? `resolved="$(ssh -G ${q(alias)} 2>/dev/null | awk '$1=="hostname" {print $2; exit}')"; if [ "$resolved" != github.com ]; then echo SSH_ALIAS_NOT_GITHUB; exit 1; fi; ` : "";
      const accepted = aliasUrl ? `${https}|${httpsGit}|${ssh}|${sshGit}|${aliasUrl}` : `${https}|${httpsGit}|${ssh}|${sshGit}`;
      return asAccount(`if ! test -d ${app}; then echo APPLICATION_PATH_MISSING; exit 1; fi; if [ "$(stat -c %U ${repo})" != ${q(config.executionAccount)} ]; then echo EXECUTION_ACCOUNT_MISMATCH; exit 1; fi; top="$(git -C ${repo} rev-parse --show-toplevel 2>/dev/null)" || { echo REPOSITORY_NOT_GIT; exit 1; }; if [ "$top" != ${repo} ]; then echo REPOSITORY_ROOT_MISMATCH; exit 1; fi; remote="$(git -C ${repo} config --get remote.origin.url 2>/dev/null)" || { echo REMOTE_MISSING; exit 1; }; ${aliasCheck}case "$remote" in ${accepted}) echo REMOTE_OK;; *) echo REMOTE_MISMATCH; exit 1;; esac; sha="$(git -C ${repo} rev-parse --verify HEAD 2>/dev/null)" || { echo REVISION_MISSING; exit 1; }; echo "$sha"; branch="$(git -C ${repo} branch --show-current 2>/dev/null)" || { echo BRANCH_UNKNOWN; exit 1; }; echo "$branch"; status="$(GIT_OPTIONAL_LOCKS=0 git -C ${repo} -c core.fsmonitor=false status --porcelain --untracked-files=no 2>/dev/null)" || { echo STATUS_UNAVAILABLE; exit 1; }; if [ -z "$status" ]; then echo WORKTREE_CLEAN; else echo WORKTREE_DIRTY; exit 1; fi`, config);
    }
    case "runtime": return asAccount(`node -e 'const fs=require("fs");const file=process.argv[1];const present=fs.existsSync(file);const pkg=present?JSON.parse(fs.readFileSync(file,"utf8")):{};const raw=typeof pkg.packageManager==="string"?pkg.packageManager:"";const manager=/^[A-Za-z0-9@.+_-]{1,80}$/.test(raw)?raw:"unspecified";const scripts=Object.keys(pkg.scripts||{}).filter(x=>/^[A-Za-z0-9:_-]+$/.test(x)).slice(0,20);console.log(JSON.stringify({node:process.version,packageJson:present,lockfile:fs.existsSync(process.argv[2]),packageManager:manager,scripts}))' ${q(`${config.applicationPath}/package.json`)} ${q(`${config.applicationPath}/package-lock.json`)}`, config);
    case "service": return asAccount(`{ ${existingPm2Daemon}; } || { echo PM2_DAEMON_UNAVAILABLE; exit 1; }; pm2 jlist | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const hits=JSON.parse(s).filter(x=>x.name===process.argv[1]&&x.pm2_env?.status==="online"&&Number.isInteger(x.pid)&&x.pid>0);if(hits.length!==1)process.exit(1);console.log("SERVICE_OK")}catch{process.exit(1)}})' ${q(config.processName)}`, config);
    case "health": return buildStepCommand("health_check", config);
    default: return invalid("probe");
  }
}
