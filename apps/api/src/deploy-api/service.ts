import type { DeploymentRecord, DeploymentStepStatus } from "@investaplay/devops-contracts";
import { AwsClient, AwsError, sanitizeCommandOutput, type AwsProvider, type InvocationInfo } from "../aws/client";
import { DeploymentSsmClient } from "../deploy-executor/client";
import type { DeploymentExecutionConfig, DeploymentSsmProvider, DeploymentStepType, DeploymentTarget, PreflightProbeType } from "../deploy-executor/types";
import { validateSha } from "../deploy-executor/template";
import { createDeploymentStep, getDeploymentRecord, transitionDeploymentRecord, updateDeploymentStep } from "../deploy-store";
import { DeploymentError } from "./context";

let ssmProvider: DeploymentSsmProvider = new DeploymentSsmClient();
let awsProvider: AwsProvider = new AwsClient();
export function setDeploymentProvidersForTests(ssm: DeploymentSsmProvider | null, aws: AwsProvider | null): void {
  ssmProvider = ssm ?? new DeploymentSsmClient();
  awsProvider = aws ?? new AwsClient();
}
export function deploymentSsmProvider(): DeploymentSsmProvider { return ssmProvider; }
export function deploymentAwsProvider(): AwsProvider { return awsProvider; }

const finished = new Set(["succeeded", "failed", "canceled", "timed_out"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function awaitInvocation(target: DeploymentTarget, commandId: string): Promise<InvocationInfo> {
  for (let attempt = 0; attempt < 180; attempt++) {
    const invocation = await ssmProvider.getInvocation(target, commandId);
    if (finished.has(invocation.status)) return invocation;
    await sleep(2000);
  }
  throw new DeploymentError(504, "DEPLOYMENT_SSM_TIMEOUT", "SSM command did not finish before the polling limit");
}

export async function runProbe(target: DeploymentTarget, probe: PreflightProbeType, config: DeploymentExecutionConfig) {
  const submitted = await ssmProvider.sendProbe(target, probe, config);
  const result = await awaitInvocation(target, submitted.commandId);
  if (result.status !== "succeeded" || result.exitCode !== 0) {
    const markers = new Set(["APPLICATION_PATH_MISSING", "REPOSITORY_NOT_GIT", "REPOSITORY_ROOT_MISMATCH", "REMOTE_MISSING",
      "REMOTE_MISMATCH", "SSH_ALIAS_NOT_GITHUB", "EXECUTION_ACCOUNT_MISMATCH", "EXECUTION_HOME_MISMATCH",
      "REVISION_MISSING", "BRANCH_UNKNOWN", "BRANCH_MISMATCH", "STATUS_UNAVAILABLE", "WORKTREE_DIRTY", "PM2_DAEMON_UNAVAILABLE"]);
    const marker = (result.output ?? "").split(/\r?\n/).find((line) => markers.has(line));
    throw new DeploymentError(409, `DEPLOYMENT_${probe.toUpperCase()}_PREFLIGHT_FAILED`,
      `${probe} preflight check failed${marker ? `: ${marker}` : ""}; SSM command ${submitted.commandId}`);
  }
  return { commandId: submitted.commandId, result };
}

function stepFailure(type: DeploymentStepType, status: string): DeploymentError {
  return new DeploymentError(502, "DEPLOYMENT_STEP_FAILED", `Deployment ${type} step ${status}`);
}

async function executeStep(record: DeploymentRecord, sequence: number, type: DeploymentStepType, target: DeploymentTarget, config: DeploymentExecutionConfig): Promise<InvocationInfo> {
  const step = await createDeploymentStep(record.projectId, record.id, sequence, type);
  await updateDeploymentStep(record.projectId, step.id, { status: "in_progress", startedAt: new Date() });
  try {
    const submitted = await ssmProvider.sendStep(target, type, config);
    await updateDeploymentStep(record.projectId, step.id, { externalCommandId: submitted.commandId });
    const result = await awaitInvocation(target, submitted.commandId);
    const status: DeploymentStepStatus = result.status === "succeeded" ? "succeeded" : result.status === "timed_out" ? "timed_out" : "failed";
    await updateDeploymentStep(record.projectId, step.id, { status, completedAt: new Date(), exitCode: result.exitCode,
      sanitizedOutput: sanitizeCommandOutput(result.output ?? undefined), sanitizedError: sanitizeCommandOutput(result.error ?? undefined) });
    if (status !== "succeeded" || result.exitCode !== 0) throw stepFailure(type, result.status);
    return result;
  } catch (error) {
    if (!(error instanceof DeploymentError && error.code === "DEPLOYMENT_STEP_FAILED")) {
      await updateDeploymentStep(record.projectId, step.id, { status: error instanceof DeploymentError && error.code === "DEPLOYMENT_SSM_TIMEOUT" ? "timed_out" : "failed",
        completedAt: new Date(), sanitizedError: error instanceof AwsError ? error.code : error instanceof DeploymentError ? error.code : "DEPLOYMENT_STEP_ERROR" });
    }
    throw error;
  }
}

function healthFields(output: string | null): { status: number; latencyMs: number } {
  const match = /^HTTP (\d{3}); duration (\d+(?:\.\d+)?)s/.exec(output?.trim() ?? "");
  if (!match) throw new DeploymentError(502, "DEPLOYMENT_HEALTH_INVALID", "Health check returned an invalid result");
  const status = Number(match[1]), latencyMs = Math.round(Number(match[2]) * 1000);
  if (status < 200 || status >= 300) throw new DeploymentError(502, "DEPLOYMENT_HEALTH_FAILED", "Application health check failed");
  return { status, latencyMs };
}

export async function runDeployment(record: DeploymentRecord, target: DeploymentTarget, config: DeploymentExecutionConfig): Promise<void> {
  let stage: "queued" | "in_progress" | "verifying" = "queued";
  let sourceMayHaveChanged = false;
  let targetHealthUnverified = false;
  try {
    if (!await transitionDeploymentRecord(record.projectId, record.id, "queued", "in_progress", { startedAt: new Date() })) return;
    stage = "in_progress";
    let sequence = 1;
    const captured = await executeStep(record, sequence++, "capture_current_revision", target, config);
    if (validateSha(captured.output?.trim() ?? "") !== record.previousSha) throw new DeploymentError(409, "DEPLOYMENT_SOURCE_CHANGED", "Server revision changed after preflight");
    await executeStep(record, sequence++, "fetch_source", target, config);
    // Once checkout is submitted, an uncertain result must retain the target lock.
    sourceMayHaveChanged = true;
    await executeStep(record, sequence++, "checkout_revision", target, config);
    if (config.installStrategy === "npm_ci") await executeStep(record, sequence++, "install_dependencies", target, config);
    if (config.buildStrategy === "npm_build") await executeStep(record, sequence++, "build", target, config);
    await executeStep(record, sequence++, "restart_service", target, config);
    if (!await transitionDeploymentRecord(record.projectId, record.id, "in_progress", "verifying")) throw new DeploymentError(409, "DEPLOYMENT_STATE_CHANGED", "Deployment state changed unexpectedly");
    stage = "verifying";
    targetHealthUnverified = true;
    const checked = await executeStep(record, sequence++, "health_check", target, config);
    const health = healthFields(checked.output);
    targetHealthUnverified = false;
    await transitionDeploymentRecord(record.projectId, record.id, "verifying", "succeeded", { completedAt: new Date(),
      healthHttpStatus: health.status, healthLatencyMs: health.latencyMs, healthCheckedAt: new Date(), healthResponse: sanitizeCommandOutput(checked.output ?? undefined) });
  } catch (error) {
    const code = error instanceof DeploymentError || error instanceof AwsError ? error.code : "DEPLOYMENT_FAILED";
    const pending = await transitionDeploymentRecord(record.projectId, record.id, stage, sourceMayHaveChanged ? "rollback_pending" : "failed",
      { completedAt: new Date(), sanitizedError: code });
    // A failed post-restart health check must restore the recorded known-good
    // revision. Other uncertain failures retain the lock for manual review.
    if (targetHealthUnverified && pending?.status === "rollback_pending") await runRollback(pending, target, config);
  }
}

export async function runRollback(record: DeploymentRecord, target: DeploymentTarget, config: DeploymentExecutionConfig): Promise<void> {
  let started = false;
  try {
    if (!await transitionDeploymentRecord(record.projectId, record.id, "rollback_pending", "rolling_back")) return;
    started = true;
    if (!record.previousSha) throw new DeploymentError(409, "ROLLBACK_SHA_MISSING", "No recorded previous revision is available");
    if (config.previousSha !== record.previousSha || config.targetSha !== record.targetSha) {
      throw new DeploymentError(409, "ROLLBACK_REVISION_MISMATCH", "Rollback configuration does not match the recorded revisions");
    }
    let sequence = 20;
    const captured = await executeStep(record, sequence++, "capture_current_revision", target, config);
    if (validateSha(captured.output?.trim() ?? "") !== record.targetSha) throw new DeploymentError(409, "ROLLBACK_SOURCE_CHANGED", "Server revision changed before rollback");
    await executeStep(record, sequence++, "rollback_checkout", target, config);
    if (config.installStrategy === "npm_ci") await executeStep(record, sequence++, "rollback_install", target, config);
    if (config.buildStrategy === "npm_build") await executeStep(record, sequence++, "rollback_build", target, config);
    await executeStep(record, sequence++, "rollback_restart", target, config);
    const checked = await executeStep(record, sequence++, "rollback_health_check", target, config);
    const health = healthFields(checked.output);
    await transitionDeploymentRecord(record.projectId, record.id, "rolling_back", "rolled_back", { completedAt: new Date(),
      healthHttpStatus: health.status, healthLatencyMs: health.latencyMs, healthCheckedAt: new Date(), healthResponse: sanitizeCommandOutput(checked.output ?? undefined) });
  } catch (error) {
    const code = error instanceof DeploymentError || error instanceof AwsError ? error.code : "ROLLBACK_FAILED";
    if (started) await transitionDeploymentRecord(record.projectId, record.id, "rolling_back", "rollback_failed", {
      completedAt: new Date(), sanitizedError: `${record.sanitizedError ? `${record.sanitizedError}; ` : ""}ROLLBACK_${code}; MANUAL_INTERVENTION_REQUIRED`,
    });
  }
}

export async function deploymentStatus(projectId: string, id: string): Promise<DeploymentRecord | null> { return getDeploymentRecord(projectId, id); }
