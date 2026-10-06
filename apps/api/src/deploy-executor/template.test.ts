import assert from "node:assert/strict";
import test from "node:test";
import { buildProbeCommand, buildStepCommand, validateBranch, validateExecutionAccount, validateExecutionConfig, validateHealthUrl, validateProcessName, validateServerPath } from "./template";
import type { DeploymentExecutionConfig } from "./types";

const config: DeploymentExecutionConfig = {
  repositoryPath: "/srv/example-app", applicationPath: "/srv/example-app/backend",
  executionAccount: "example", repositorySshHostAlias: "github-example",
  expectedRepositoryOwner: "example-owner", expectedRepositoryName: "example-repo",
  allowedBranch: "release/main", targetSha: "a".repeat(40), previousSha: "b".repeat(40),
  packageManager: "npm", installStrategy: "npm_ci", buildStrategy: "npm_build",
  processManager: "pm2", processName: "example-api", healthUrl: "http://127.0.0.1:4000/health", healthTimeoutSeconds: 10,
};

test("deployment templates permit only fixed reviewed steps", () => {
  const fetch = buildStepCommand("fetch_source", config);
  assert.match(fetch, /^runuser -u 'example' -- env -u PM2_HOME sh -c /);
  assert.match(fetch, /git -C .*\/srv\/example-app.* fetch --no-tags origin .*release\/main/);
  assert.match(fetch, /rev-parse FETCH_HEAD/);
  assert.match(buildStepCommand("capture_current_revision", config), /WORKTREE_DIRTY.*git -C .*rev-parse --verify HEAD/);
  assert.match(buildStepCommand("restart_service", config), /test -S .*rpc\.sock.* && pm2 restart/);
  assert.match(buildStepCommand("rollback_restart", config), /pm2 restart .*example-api/);
  assert.doesNotMatch(buildStepCommand("rollback_restart", config), /pm2 restart all/);
  assert.match(buildStepCommand("install_dependencies", config), /npm ci --ignore-scripts/);
  assert.equal(buildStepCommand("rollback_install", config), buildStepCommand("install_dependencies", config));
  assert.equal(buildStepCommand("rollback_build", config), buildStepCommand("build", config));
  assert.match(buildStepCommand("build", config), /npm --ignore-scripts run build/);
  assert.match(buildStepCommand("rollback_checkout", config), new RegExp(config.previousSha!));
  assert.throws(() => buildStepCommand("migrate" as never, config));
  assert.throws(() => buildStepCommand("rollback_checkout", { ...config, previousSha: undefined }));
});

test("preflight verifies remote identity without printing origin URL", () => {
  const probe = buildProbeCommand("repository", config);
  assert.match(probe, /^runuser -u 'example' -- env -u PM2_HOME sh -c /);
  assert.match(probe, /SSH_ALIAS_NOT_GITHUB/);
  assert.match(probe, /EXECUTION_ACCOUNT_MISMATCH/);
  assert.match(probe, /remote="\$\(git -C .* config --get remote.origin.url/);
  assert.match(probe, /REMOTE_OK/);
  assert.match(probe, /REMOTE_MISMATCH/);
  assert.match(probe, /APPLICATION_PATH_MISSING/);
  assert.match(probe, /REPOSITORY_NOT_GIT/);
  assert.match(probe, /GIT_OPTIONAL_LOCKS=0 git -C/);
  assert.match(probe, /WORKTREE_CLEAN/);
  assert.doesNotMatch(probe, /echo \$remote/);
  const runtime = buildProbeCommand("runtime", config);
  assert.match(runtime, /package-lock\.json/);
  assert.match(runtime, /packageManager/);
  assert.doesNotMatch(runtime, /npm (?:install|ci|run)/);
  assert.match(buildProbeCommand("service", config), /test -S .*rpc\.sock.*PM2_DAEMON_UNAVAILABLE.*pm2 jlist \| node -e/);
  assert.match(buildProbeCommand("service", config), /x.name===process.argv\[1\]/);
  assert.match(buildProbeCommand("service", config), /^runuser -u 'example' -- env -u PM2_HOME sh -c /);
  assert.match(buildProbeCommand("runtime", config), /^runuser -u 'example' -- env -u PM2_HOME sh -c /);
});

test("shell metacharacters, traversal, nonlocal health targets and mismatched paths are rejected", () => {
  for (const path of ["/srv/app;id", "/srv/../root", "/srv/$(id)", "relative/path", "/srv/a b"]) assert.throws(() => validateServerPath(path));
  for (const branch of ["main;id", "../main", "main && id", "-branch", "main@{0}"]) assert.throws(() => validateBranch(branch));
  for (const process of ["api;id", "$(id)", "api other", "-all"]) assert.throws(() => validateProcessName(process));
  for (const url of ["http://169.254.169.254/latest/meta-data", "https://127.0.0.1:4000/health", "http://localhost:4000/health?token=x", "http://user:pass@localhost:4000/health"]) assert.throws(() => validateHealthUrl(url));
  assert.throws(() => validateExecutionConfig({ ...config, applicationPath: "/srv/other-app" }));
  assert.throws(() => validateExecutionConfig({ ...config, expectedRepositoryOwner: "owner;id" }));
  for (const account of ["", "root;id", "ubuntu $(id)", "-root", "UPPER", "a".repeat(33)]) assert.throws(() => validateExecutionAccount(account));
  assert.throws(() => validateExecutionConfig({ ...config, repositorySshHostAlias: "host;id" }));
  assert.throws(() => buildStepCommand("build", { ...config, buildStrategy: "none" }));
  assert.throws(() => buildStepCommand("rollback_install", { ...config, installStrategy: "none" }));
  assert.throws(() => buildStepCommand("install_dependencies", { ...config, installStrategy: "none" }));
  assert.throws(() => buildStepCommand("rollback_build", { ...config, buildStrategy: "none" }));
});
