import { Router, type ErrorRequestHandler } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  createDeploymentConfigurationSchema, updateDeploymentConfigurationSchema, createDeploymentSchema,
  confirmDeploymentSchema, githubConfigurationSchema, idSchema, type DeploymentConfiguration, type DeploymentRecord,
} from "@investaplay/devops-contracts";
import { currentUser, requirePermission } from "../auth/policy";
import { recordSecurityEvent } from "../auth/events";
import { db } from "../db/client";
import { deploymentRecords } from "../db/schema";
import { getProject, getEnvironment } from "../store";
import { getAwsServer } from "../aws/store";
import { getIntegration } from "../integration-store";
import { AwsError, sanitizeCommandOutput } from "../aws/client";
import { GitHubClient, GitHubError, type GitHubConfig } from "../github/client";
import { resolveGitHubAppKey } from "../github/secret-resolver";
import { validateSha } from "../deploy-executor/template";
import {
  listDeploymentConfigurations, getDeploymentConfiguration, createDeploymentConfiguration, updateDeploymentConfiguration,
  listDeploymentRecords, getDeploymentRecord, createDeploymentRecord, transitionDeploymentRecord,
  createDeploymentStep, updateDeploymentStep, listDeploymentSteps,
} from "../deploy-store";
import { deploymentContext, executionConfig, executionTarget, DeploymentError } from "./context";
import { deploymentAwsProvider, runProbe, runDeployment, runRollback } from "./service";

const githubClient = new GitHubClient();
let resolveHead = async (projectId: string, integrationId: string, config: GitHubConfig, referenceId: string, branch: string) => {
  const key = await resolveGitHubAppKey(projectId, referenceId);
  return githubClient.branchHead(config, key, branch);
};
export function setDeploymentHeadResolverForTests(resolver: typeof resolveHead | null): void {
  resolveHead = resolver ?? (async (projectId, _integrationId, config, referenceId, branch) =>
    githubClient.branchHead(config, await resolveGitHubAppKey(projectId, referenceId), branch));
}

function id(value: unknown): string {
  if (typeof value !== "string" || !idSchema.safeParse(value).success) throw new DeploymentError(400, "INVALID_ID", "Invalid resource ID");
  return value;
}
function body<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new DeploymentError(400, "VALIDATION_ERROR", "Invalid request data");
  return parsed.data;
}
function projectId(value: unknown): string { return id(value); }

async function validateConfiguration(project: string, input: DeploymentConfiguration | z.infer<typeof createDeploymentConfigurationSchema>) {
  const p = await getProject(project);
  const env = await getEnvironment(project, input.environmentId);
  const server = await getAwsServer(project, input.serverId);
  const github = await getIntegration(project, input.githubIntegrationId);
  if (!p || p.status !== "active" || !env || env.status !== "active" || !server || !server.enabled || !github || github.provider !== "github" || github.status === "disabled") {
    throw new DeploymentError(409, "DEPLOYMENT_MAPPING_INVALID", "Deployment configuration references an inactive or unrelated resource");
  }
  if (server.environmentId !== env.id || (github.environmentId && github.environmentId !== env.id)) {
    throw new DeploymentError(409, "DEPLOYMENT_MAPPING_INVALID", "Deployment configuration environment does not match server or GitHub integration");
  }
  const githubConfig = githubConfigurationSchema.safeParse(github.configuration);
  if (!githubConfig.success || githubConfig.data.defaultBranch !== input.allowedBranch) {
    throw new DeploymentError(409, "DEPLOYMENT_BRANCH_NOT_ALLOWED", "Allowed branch must match linked GitHub integration");
  }
}

async function checkTarget(context: Awaited<ReturnType<typeof deploymentContext>>) {
  const { awsConfig, server } = context;
  await deploymentAwsProvider().testConnection(awsConfig);
  const ec2 = await deploymentAwsProvider().describeInstance(awsConfig, server.instanceId);
  if (ec2.state !== "running") throw new DeploymentError(409, "DEPLOYMENT_EC2_NOT_RUNNING", "Mapped EC2 instance is not running");
  const ssm = await deploymentAwsProvider().describeSsmTarget(awsConfig, server.managedInstanceId);
  if (!ssm.managed || ssm.pingStatus !== "Online" || ssm.platform !== "Linux") {
    throw new DeploymentError(409, "DEPLOYMENT_SSM_NOT_READY", "Mapped Linux server is not online in SSM");
  }
  return executionTarget(awsConfig.region, awsConfig.accountId, server.managedInstanceId);
}

function currentSha(output: string | null): string {
  const lines = output?.trim().split(/\r?\n/) ?? [];
  if (lines[0] !== "REMOTE_OK") throw new DeploymentError(409, "DEPLOYMENT_REPOSITORY_MISMATCH", "Server Git origin does not match the linked repository");
  if (!lines.includes("WORKTREE_CLEAN")) throw new DeploymentError(409, "DEPLOYMENT_WORKTREE_NOT_CLEAN", "Server Git working tree is not verified clean");
  try { return validateSha(lines[1] ?? ""); } catch { throw new DeploymentError(409, "DEPLOYMENT_REVISION_INVALID", "Server current revision is invalid"); }
}
const runtimeSchema = z.strictObject({ node: z.string().max(40), packageJson: z.boolean(), lockfile: z.boolean(),
  packageManager: z.string().max(80), scripts: z.array(z.string().max(80)).max(20) });
function runtimeSummary(output: string | null): string {
  try {
    const parsed = runtimeSchema.parse(JSON.parse(output ?? ""));
    return JSON.stringify(parsed);
  } catch { throw new DeploymentError(409, "DEPLOYMENT_RUNTIME_INVALID", "Server runtime probe returned an invalid result"); }
}
function parseHealth(output: string | null): { status: number; latencyMs: number } {
  const match = /^HTTP (\d{3}); duration (\d+(?:\.\d+)?)s/.exec(output?.trim() ?? "");
  if (!match || Number(match[1]) < 200 || Number(match[1]) >= 300) throw new DeploymentError(409, "DEPLOYMENT_HEALTH_NOT_READY", "Configured health endpoint is not healthy");
  return { status: Number(match[1]), latencyMs: Math.round(Number(match[2]) * 1000) };
}
function challengeFor(record: DeploymentRecord, projectSlug: string, environmentName: string, serverName: string): string {
  return `DEPLOY ${projectSlug} ${environmentName} ${serverName} ${record.targetSha}`;
}
function rollbackChallenge(record: DeploymentRecord): string { return `ROLLBACK ${record.id} ${record.previousSha}`; }

export const deploymentRouter = Router({ mergeParams: true });

deploymentRouter.get("/deployment-configs", requirePermission("deploymentsRead"), async (request, response) => {
  response.json({ data: await listDeploymentConfigurations(projectId(request.params.projectId)) });
});
deploymentRouter.post("/deployment-configs", requirePermission("deploymentsConfigure"), async (request, response) => {
  const project = projectId(request.params.projectId);
  const input = body(createDeploymentConfigurationSchema, request.body);
  await validateConfiguration(project, input);
  const config = await createDeploymentConfiguration(project, input);
  recordSecurityEvent({ actorId: currentUser(response).id, action: "deployment.config.create", targetId: config.id, result: "allowed" });
  response.status(201).json({ data: config });
});
deploymentRouter.patch("/deployment-configs/:configurationId", requirePermission("deploymentsConfigure"), async (request, response) => {
  const project = projectId(request.params.projectId), configId = id(request.params.configurationId);
  const existing = await getDeploymentConfiguration(project, configId);
  if (!existing) throw new DeploymentError(404, "DEPLOYMENT_CONFIG_NOT_FOUND", "Deployment configuration not found");
  const activeKey = `${project}:${existing.environmentId}:${existing.serverId}`;
  if ((await db.select({ id: deploymentRecords.id }).from(deploymentRecords).where(eq(deploymentRecords.activeTargetKey, activeKey)).limit(1)).length) {
    throw new DeploymentError(409, "DEPLOYMENT_ACTIVE", "Configuration cannot change during an active deployment");
  }
  const patch = body(updateDeploymentConfigurationSchema, request.body);
  const { id: _id, projectId: _projectId, createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = existing;
  const merged = body(createDeploymentConfigurationSchema, { ...fields, ...patch });
  await validateConfiguration(project, merged);
  const updated = await updateDeploymentConfiguration(project, configId, patch);
  response.json({ data: updated });
});

deploymentRouter.get("/deployments", requirePermission("deploymentsRead"), async (request, response) => {
  response.json({ data: await listDeploymentRecords(projectId(request.params.projectId)) });
});
deploymentRouter.get("/deployments/:deploymentId", requirePermission("deploymentsRead"), async (request, response) => {
  const project = projectId(request.params.projectId), deploymentId = id(request.params.deploymentId);
  const deployment = await getDeploymentRecord(project, deploymentId);
  if (!deployment) throw new DeploymentError(404, "DEPLOYMENT_NOT_FOUND", "Deployment not found");
  response.json({ data: { deployment, steps: await listDeploymentSteps(project, deploymentId) } });
});

deploymentRouter.post("/deployments/preflight", requirePermission("deploymentsPreflight"), async (request, response) => {
  const project = projectId(request.params.projectId);
  const input = body(createDeploymentSchema, request.body);
  const context = await deploymentContext(project, input.configurationId);
  if (context.environment.type === "production" && currentUser(response).role !== "admin") throw new DeploymentError(403, "PRODUCTION_ADMIN_REQUIRED", "Admin is required for production preflight");
  if (input.sourceRef !== context.config.allowedBranch) throw new DeploymentError(409, "DEPLOYMENT_BRANCH_NOT_ALLOWED", "Source ref differs from configured branch");
  const activeKey = `${project}:${context.environment.id}:${context.server.id}`;
  if ((await db.select({ id: deploymentRecords.id }).from(deploymentRecords).where(eq(deploymentRecords.activeTargetKey, activeKey)).limit(1)).length) {
    throw new DeploymentError(409, "DEPLOYMENT_ACTIVE", "A deployment is already active for this target");
  }
  const target = await checkTarget(context);
  const targetSha = validateSha(await resolveHead(project, context.github.id, context.githubConfig, context.github.secretReferenceId!, input.sourceRef));
  const template = executionConfig(context.config, context.githubConfig.owner, context.githubConfig.repository, targetSha);
  // Submit probes one at a time. A denied or failed first probe must not fan out
  // additional SSM commands against a production target.
  const repository = await runProbe(target, "repository", template);
  const runtime = await runProbe(target, "runtime", template);
  const service = await runProbe(target, "service", template);
  const health = await runProbe(target, "health", template);
  const previousSha = currentSha(repository.result.output);
  const runtimeInfo = runtimeSummary(runtime.result.output);
  const healthResult = parseHealth(health.result.output);
  const deployment = await createDeploymentRecord(project, context.config, { repositoryOwner: context.githubConfig.owner,
    repositoryName: context.githubConfig.repository, requestedRef: input.sourceRef, targetSha, previousSha, requestedByUserId: currentUser(response).id });
  const step = await createDeploymentStep(project, deployment.id, 0, "preflight");
  await updateDeploymentStep(project, step.id, { status: "succeeded", startedAt: new Date(), completedAt: new Date(), externalCommandId: repository.commandId,
    exitCode: 0, sanitizedOutput: sanitizeCommandOutput(`Current SHA: ${previousSha}; target SHA: ${targetSha}; worktree: clean; repository probe: ${repository.commandId}; runtime probe: ${runtime.commandId}; runtime: ${runtimeInfo}; service probe: ${service.commandId}; health probe: ${health.commandId}; health HTTP: ${healthResult.status}; latency ms: ${healthResult.latencyMs}`) });
  recordSecurityEvent({ actorId: currentUser(response).id, action: "deployment.preflight", targetId: deployment.id, result: "allowed" });
  response.status(201).json({ data: { deployment, challenge: challengeFor(deployment, context.project.slug, context.environment.name, context.server.displayName) } });
});

deploymentRouter.post("/deployments/:deploymentId/confirm", requirePermission("deploymentsExecute"), async (request, response) => {
  const project = projectId(request.params.projectId), deploymentId = id(request.params.deploymentId);
  const { challenge } = body(confirmDeploymentSchema, request.body);
  const record = await getDeploymentRecord(project, deploymentId);
  if (!record || record.status !== "awaiting_confirmation") throw new DeploymentError(409, "DEPLOYMENT_NOT_CONFIRMABLE", "Deployment is not awaiting confirmation");
  if (record.requestedByUserId !== currentUser(response).id) throw new DeploymentError(403, "DEPLOYMENT_REQUESTER_MISMATCH", "Only the preflight requester may confirm");
  if (Date.now() - new Date(record.preflightedAt).getTime() > 10 * 60_000) throw new DeploymentError(409, "DEPLOYMENT_PREFLIGHT_EXPIRED", "Preflight is older than ten minutes");
  const context = await deploymentContext(project, record.configurationId);
  if (context.config.updatedAt !== record.configurationSnapshot.updatedAt) throw new DeploymentError(409, "DEPLOYMENT_CONFIG_CHANGED", "Configuration changed after preflight");
  if (context.environment.type === "production" && currentUser(response).role !== "admin") throw new DeploymentError(403, "PRODUCTION_ADMIN_REQUIRED", "Admin is required for production deployment");
  if (challenge !== challengeFor(record, context.project.slug, context.environment.name, context.server.displayName)) {
    throw new DeploymentError(400, "DEPLOYMENT_CONFIRMATION_INVALID", "Confirmation challenge does not match deployment target");
  }
  if (record.previousSha === record.targetSha) throw new DeploymentError(409, "DEPLOYMENT_NO_SOURCE_CHANGE", "Current server revision already matches target commit");
  const target = await checkTarget(context);
  const liveTargetSha = validateSha(await resolveHead(project, context.github.id, context.githubConfig, context.github.secretReferenceId!, record.requestedRef));
  if (liveTargetSha !== record.targetSha) throw new DeploymentError(409, "DEPLOYMENT_TARGET_MOVED", "GitHub branch moved after preflight");
  const template = executionConfig(record.configurationSnapshot, record.repositoryOwner, record.repositoryName, record.targetSha, record.previousSha ?? undefined);
  const repository = await runProbe(target, "repository", template);
  if (currentSha(repository.result.output) !== record.previousSha) throw new DeploymentError(409, "DEPLOYMENT_SOURCE_CHANGED", "Server revision changed after preflight");
  let queued;
  try { queued = await transitionDeploymentRecord(project, record.id, "awaiting_confirmation", "queued"); }
  catch (error) { if ((error as { code?: string })?.code === "ER_DUP_ENTRY") throw new DeploymentError(409, "DEPLOYMENT_ACTIVE", "A deployment is already active for this target"); throw error; }
  if (!queued) throw new DeploymentError(409, "DEPLOYMENT_STATE_CHANGED", "Deployment state changed before confirmation");
  recordSecurityEvent({ actorId: currentUser(response).id, action: "deployment.start", targetId: record.id, result: "allowed" });
  response.status(202).json({ data: queued });
  void runDeployment(queued, target, template).catch(() => { /* The runner persists a sanitized failure; never retry automatically. */ });
});

deploymentRouter.post("/deployments/:deploymentId/rollback", requirePermission("deploymentsRollback"), async (request, response) => {
  const project = projectId(request.params.projectId), deploymentId = id(request.params.deploymentId);
  const { challenge } = body(confirmDeploymentSchema, request.body);
  const record = await getDeploymentRecord(project, deploymentId);
  if (!record || record.status !== "rollback_pending" || !record.previousSha) throw new DeploymentError(409, "ROLLBACK_NOT_AVAILABLE", "Deployment is not awaiting manual rollback");
  if (challenge !== rollbackChallenge(record)) throw new DeploymentError(400, "ROLLBACK_CONFIRMATION_INVALID", "Rollback confirmation does not match recorded revision");
  const context = await deploymentContext(project, record.configurationId);
  const target = await checkTarget(context);
  const template = executionConfig(record.configurationSnapshot, record.repositoryOwner, record.repositoryName, record.targetSha, record.previousSha);
  const repository = await runProbe(target, "repository", template);
  if (currentSha(repository.result.output) !== record.targetSha) throw new DeploymentError(409, "ROLLBACK_SERVER_REVISION_CHANGED", "Server revision differs from the failed deployment target; manual investigation is required");
  recordSecurityEvent({ actorId: currentUser(response).id, action: "deployment.rollback", targetId: record.id, result: "allowed" });
  response.status(202).json({ data: record });
  void runRollback(record, target, template).catch(() => { /* Persisted state remains visible; no automatic retry. */ });
});

const deploymentErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (error instanceof DeploymentError || error instanceof AwsError || error instanceof GitHubError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  next(error);
};
deploymentRouter.use(deploymentErrorHandler);
