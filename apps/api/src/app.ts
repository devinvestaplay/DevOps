import express, { type ErrorRequestHandler } from "express";
import bcrypt from "bcryptjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  createEnvironmentSchema, createProjectSchema, createUserSchema, idSchema,
  createIntegrationSchema, updateIntegrationSchema, createSecretReferenceSchema, updateSecretReferenceSchema,
  githubConfigurationSchema, expoConfigurationSchema,
  awsConfigurationSchema, createAwsServerSchema, updateAwsServerSchema, awsActionRequestSchema,
  updateEnvironmentSchema, updateProjectSchema, updateUserSchema,
} from "@investaplay/devops-contracts";
import type { ZodType } from "zod";
import {
  archiveProject, createEnvironment, createProject, getEnvironment, getProject,
  listEnvironments, listProjects, updateEnvironment, updateProject,
} from "./store";
import { recordSecurityEvent } from "./auth/events";
import { createIntegration, createSecretReference, getIntegration, getSecretReference, listIntegrations, listSecretReferences, updateIntegration, updateSecretReference } from "./integration-store";
import { safeConfiguration, validReferenceLocator } from "./integration-validation";
import { GitHubClient, GitHubError, type GitHubReadKind } from "./github/client";
import { resolveGitHubAppKey } from "./github/secret-resolver";
import { ExpoClient } from "./expo/client";
import { ExpoError } from "./expo/errors";
import { resolveExpoToken } from "./expo/secret-resolver";
import { withExpoWorkspace } from "./expo/workspace";
import { createBuildRecord, listBuildRecords, findBuildRecordByExternalId, syncBuildRecord, updateBuildRecord } from "./expo/build-store";
import { AwsClient, AwsError, sanitizeCommandOutput, type AwsConfig, type AwsProvider } from "./aws/client";
import { createAwsServer, getAwsServer, listAwsServers, updateAwsServer, createAwsCommandRecord, getAwsCommandRecord, listAwsCommandRecords, updateAwsCommandRecord } from "./aws/store";
import { deploymentRouter } from "./deploy-api/router";
import { currentUser, requireAuth, requirePermission, SESSION_COOKIE } from "./auth/policy";
import {
  createSession, createUser, deleteSession, getSessionUser, getUser, LastAdminError, listUsers,
  PasswordError, updateUser, verifyLogin,
} from "./auth/store";

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

function validId(value: string | string[]): string {
  if (typeof value !== "string" || !idSchema.safeParse(value).success) throw new HttpError(400, "INVALID_ID", "Invalid resource ID");
  return value;
}

function validBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "VALIDATION_ERROR", "Invalid request data");
  return parsed.data;
}

async function requiredProject(id: string | string[]) {
  const project = await getProject(validId(id));
  if (!project) throw new HttpError(404, "PROJECT_NOT_FOUND", "Project not found");
  return project;
}

function requireActive(status: string) {
  if (status !== "active") throw new HttpError(409, "PROJECT_ARCHIVED", "Archived projects cannot be changed");
}

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());
app.use("/api", (_request, response, next) => {
  response.set("Cache-Control", "no-store");
  next();
});
app.use((request, response, next) => {
  if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) {
    const origin = request.get("Origin");
    const allowed = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000";
    if (origin && origin !== allowed) {
      response.status(403).json({ error: { code: "ORIGIN_FORBIDDEN", message: "Request origin not allowed" } });
      return;
    }
  }
  next();
});

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "investaplay-devops-api" });
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: { code: "LOGIN_LIMITED", message: "Too many login attempts. Try again later." } },
});
const loginSchema = z.strictObject({ email: z.string().max(254), password: z.string().max(256) });
const cookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

app.post("/api/auth/login", loginLimiter, async (request, response) => {
  const input = loginSchema.safeParse(request.body);
  const failure = { error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } };
  if (!input.success || bcrypt.truncates(input.data.password)) {
    recordSecurityEvent({ actorId: null, action: "auth.login", targetId: null, result: "denied" });
    response.status(401).json(failure);
    return;
  }
  const user = await verifyLogin(input.data.email, input.data.password);
  if (!user) {
    recordSecurityEvent({ actorId: null, action: "auth.login", targetId: null, result: "denied" });
    response.status(401).json(failure);
    return;
  }
  const priorToken = request.cookies?.[SESSION_COOKIE] as string | undefined;
  if (priorToken) await deleteSession(priorToken);
  const session = await createSession(user.id);
  response.cookie(SESSION_COOKIE, session.token, { ...cookieOptions, maxAge: session.maxAge });
  recordSecurityEvent({ actorId: user.id, action: "auth.login", targetId: user.id, result: "allowed" });
  response.json({ data: await getUser(user.id) });
});

app.post("/api/auth/logout", async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE] as string | undefined;
  const user = token ? await getSessionUser(token) : null;
  if (token) await deleteSession(token);
  response.clearCookie(SESSION_COOKIE, cookieOptions);
  recordSecurityEvent({ actorId: user?.id ?? null, action: "auth.logout", targetId: user?.id ?? null, result: "allowed" });
  response.status(204).end();
});

app.get("/api/auth/me", requireAuth, (_request, response) => {
  response.json({ data: currentUser(response) });
});

app.use("/api/projects", requireAuth);
app.use("/api/users", requireAuth, requirePermission("usersManage"));

app.get("/api/projects", requirePermission("projectsRead"), async (_request, response) => {
  response.json({ data: await listProjects() });
});

app.post("/api/projects", requirePermission("projectsWrite"), async (request, response) => {
  const input = validBody(createProjectSchema, request.body);
  const project = await createProject(input);
  response.status(201).json({ data: project });
});

app.get("/api/projects/:projectId", requirePermission("projectsRead"), async (request, response) => {
  response.json({ data: await requiredProject(request.params.projectId) });
});

app.patch("/api/projects/:projectId", requirePermission("projectsWrite"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  const input = validBody(updateProjectSchema, request.body);
  if (project.status === "archived" && input.status !== "active") requireActive(project.status);
  response.json({ data: await updateProject(project.id, input) });
});

app.delete("/api/projects/:projectId", requirePermission("projectsWrite"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  response.json({ data: await archiveProject(project.id) });
});

app.get("/api/projects/:projectId/environments", requirePermission("environmentsRead"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  response.json({ data: await listEnvironments(project.id) });
});

app.post("/api/projects/:projectId/environments", requirePermission("environmentsWrite"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  requireActive(project.status);
  const input = validBody(createEnvironmentSchema, request.body);
  response.status(201).json({ data: await createEnvironment(project.id, input) });
});

app.get("/api/projects/:projectId/environments/:environmentId", requirePermission("environmentsRead"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  const environment = await getEnvironment(project.id, validId(request.params.environmentId));
  if (!environment) throw new HttpError(404, "ENVIRONMENT_NOT_FOUND", "Environment not found");
  response.json({ data: environment });
});

app.patch("/api/projects/:projectId/environments/:environmentId", requirePermission("environmentsWrite"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  requireActive(project.status);
  const id = validId(request.params.environmentId);
  const input = validBody(updateEnvironmentSchema, request.body);
  const environment = await updateEnvironment(project.id, id, input);
  if (!environment) throw new HttpError(404, "ENVIRONMENT_NOT_FOUND", "Environment not found");
  response.json({ data: environment });
});

async function checkedEnvironment(projectId: string, environmentId: string | null) {
  if (environmentId && !await getEnvironment(projectId, environmentId)) {
    throw new HttpError(400, "INVALID_ENVIRONMENT", "Environment must belong to this project");
  }
}

async function checkedReference(projectId: string, referenceId: string | null, provider: string, environmentId: string | null) {
  if (!referenceId) return;
  const reference = await getSecretReference(projectId, referenceId);
  if (!reference || reference.provider !== provider || (reference.environmentId !== null && reference.environmentId !== environmentId)) {
    throw new HttpError(400, "INVALID_SECRET_REFERENCE", "Secret reference must match provider and project/environment scope");
  }
}

app.get("/api/projects/:projectId/integrations", requirePermission("integrationsRead"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  response.json({ data: await listIntegrations(project.id) });
});
app.post("/api/projects/:projectId/integrations", requirePermission("integrationsWrite"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  requireActive(project.status);
  const input = validBody(createIntegrationSchema, request.body);
  const configuration = safeConfiguration(input.provider, input.configuration);
  if (!configuration) throw new HttpError(400, "INVALID_CONFIGURATION", "Only non-secret provider configuration is allowed");
  await checkedEnvironment(project.id, input.environmentId);
  await checkedReference(project.id, input.secretReferenceId, input.provider, input.environmentId);
  const integration = await createIntegration(project.id, { ...input, configuration, status: "configured" });
  recordSecurityEvent({ actorId: currentUser(response).id, action: "integration.create", targetId: integration.id, result: "allowed" });
  response.status(201).json({ data: integration });
});
app.get("/api/projects/:projectId/integrations/:integrationId", requirePermission("integrationsRead"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  const integration = await getIntegration(project.id, validId(request.params.integrationId));
  if (!integration) throw new HttpError(404, "INTEGRATION_NOT_FOUND", "Integration not found");
  response.json({ data: integration });
});
app.patch("/api/projects/:projectId/integrations/:integrationId", requirePermission("integrationsWrite"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  requireActive(project.status);
  const id = validId(request.params.integrationId);
  const existing = await getIntegration(project.id, id);
  if (!existing) throw new HttpError(404, "INTEGRATION_NOT_FOUND", "Integration not found");
  const input = validBody(updateIntegrationSchema, request.body);
  const environmentId = input.environmentId === undefined ? existing.environmentId : input.environmentId;
  const secretReferenceId = input.secretReferenceId === undefined ? existing.secretReferenceId : input.secretReferenceId;
  await checkedEnvironment(project.id, environmentId);
  await checkedReference(project.id, secretReferenceId, existing.provider, environmentId);
  const configuration = input.configuration === undefined ? undefined : safeConfiguration(existing.provider, input.configuration);
  if (configuration === null) throw new HttpError(400, "INVALID_CONFIGURATION", "Only non-secret provider configuration is allowed");
  const changedConnection = configuration !== undefined || environmentId !== existing.environmentId || secretReferenceId !== existing.secretReferenceId;
  const integration = await updateIntegration(project.id, id, { ...input, configuration, environmentId, secretReferenceId,
    ...(changedConnection ? { status: input.status ?? "configured", lastVerifiedAt: null, lastVerificationResult: null, lastVerificationReason: null } : {}),
  });
  recordSecurityEvent({ actorId: currentUser(response).id, action: "integration.update", targetId: id, result: "allowed" });
  response.json({ data: integration });
});
app.delete("/api/projects/:projectId/integrations/:integrationId", requirePermission("integrationsWrite"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  requireActive(project.status);
  const id = validId(request.params.integrationId);
  const integration = await updateIntegration(project.id, id, { status: "disabled" });
  if (!integration) throw new HttpError(404, "INTEGRATION_NOT_FOUND", "Integration not found");
  recordSecurityEvent({ actorId: currentUser(response).id, action: "integration.disable", targetId: id, result: "allowed" });
  response.json({ data: integration });
});

app.get("/api/projects/:projectId/secret-references", requirePermission("secretReferencesManage"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  response.json({ data: await listSecretReferences(project.id) });
});
app.post("/api/projects/:projectId/secret-references", requirePermission("secretReferencesManage"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  requireActive(project.status);
  const input = validBody(createSecretReferenceSchema, request.body);
  await checkedEnvironment(project.id, input.environmentId);
  if (!validReferenceLocator(input.referenceType, input.referenceKey)) throw new HttpError(400, "INVALID_REFERENCE_KEY", "Expected a secret-store locator, not a secret value");
  const reference = await createSecretReference(project.id, input);
  recordSecurityEvent({ actorId: currentUser(response).id, action: "secret_reference.create", targetId: reference.id, result: "allowed" });
  response.status(201).json({ data: reference });
});
app.get("/api/projects/:projectId/secret-references/:secretReferenceId", requirePermission("secretReferencesManage"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  const reference = await getSecretReference(project.id, validId(request.params.secretReferenceId));
  if (!reference) throw new HttpError(404, "SECRET_REFERENCE_NOT_FOUND", "Secret reference not found");
  response.json({ data: reference });
});

const githubClient = new GitHubClient();
const expoClient = new ExpoClient();
let awsProvider: AwsProvider = new AwsClient();
export function setAwsProviderForTests(provider: AwsProvider | null): void { awsProvider = provider ?? new AwsClient(); }
const execFileAsync = promisify(execFile);
const githubReadKinds = new Set<GitHubReadKind>(["repository", "branches", "commits", "pull-requests", "workflow-runs"]);

async function githubContext(projectId: string | string[], integrationId: unknown) {
  const project = await requiredProject(projectId);
  const integration = await getIntegration(project.id, validId(integrationId as string));
  if (!integration || integration.provider !== "github" || integration.environmentId !== null) {
    throw new HttpError(404, "GITHUB_INTEGRATION_NOT_FOUND", "Project GitHub integration not found");
  }
  if (integration.status === "disabled") throw new HttpError(409, "INTEGRATION_DISABLED", "GitHub integration is disabled");
  const parsed = githubConfigurationSchema.safeParse(integration.configuration);
  if (!parsed.success || !parsed.data.appId || !parsed.data.installationId || !integration.secretReferenceId) {
    throw new HttpError(409, "GITHUB_NOT_CONFIGURED", "GitHub App configuration is incomplete");
  }
  return { project, integration, config: { ...parsed.data, appId: parsed.data.appId, installationId: parsed.data.installationId } };
}

async function awsContext(projectId: string | string[], integrationId: unknown) {
  const project = await requiredProject(projectId);
  const integration = await getIntegration(project.id, validId(integrationId as string));
  if (!integration || integration.provider !== "aws") throw new HttpError(404, "AWS_INTEGRATION_NOT_FOUND", "Project AWS integration not found");
  if (integration.status === "disabled") throw new HttpError(409, "INTEGRATION_DISABLED", "AWS integration is disabled");
  const parsed = awsConfigurationSchema.safeParse(integration.configuration);
  if (!parsed.success) throw new HttpError(409, "AWS_NOT_CONFIGURED", "AWS integration is incomplete");
  return { project, integration, config: parsed.data as AwsConfig };
}

async function awsServerContext(projectId: string | string[], serverId: unknown) {
  const project = await requiredProject(projectId);
  const server = await getAwsServer(project.id, validId(serverId as string));
  if (!server) throw new HttpError(404, "AWS_SERVER_NOT_FOUND", "Mapped server not found");
  const context = await awsContext(project.id, server.integrationId);
  if (context.integration.environmentId !== null && context.integration.environmentId !== server.environmentId) {
    throw new HttpError(409, "AWS_MAPPING_INVALID", "AWS integration environment does not match server");
  }
  if (context.config.region !== server.region) throw new HttpError(409, "AWS_MAPPING_INVALID", "AWS server region no longer matches integration");
  return { ...context, server };
}

app.post("/api/projects/:projectId/integrations/:integrationId/test", requirePermission("integrationsWrite"), async (request, response) => {
  const targetProject = await requiredProject(request.params.projectId);
  const target = await getIntegration(targetProject.id, validId(request.params.integrationId));
  if (!target) throw new HttpError(404, "INTEGRATION_NOT_FOUND", "Integration not found");
  if (target.provider === "aws") {
    const { project, integration, config } = await awsContext(request.params.projectId, request.params.integrationId);
    requireActive(project.status);
    const mapped = (await listAwsServers(project.id)).find((server) => server.integrationId === integration.id && server.enabled);
    try {
      const result = await awsProvider.testConnection(config, mapped ? { instanceId: mapped.instanceId, managedInstanceId: mapped.managedInstanceId } : undefined);
      const verifiedAt = new Date();
      await updateIntegration(project.id, integration.id, { status: "configured", lastVerifiedAt: verifiedAt, lastVerificationResult: "connected", lastVerificationReason: null });
      response.json({ data: { ...result, lastVerifiedAt: verifiedAt.toISOString() } });
    } catch (error) {
      if (error instanceof AwsError) await updateIntegration(project.id, integration.id, { status: "error", lastVerifiedAt: new Date(), lastVerificationResult: "error", lastVerificationReason: error.code });
      throw error;
    }
    return;
  }
  if (target.provider === "expo") {
    const context = await expoContext(request.params.projectId, request.params.integrationId);
    requireActive(context.project.status);
    try {
      const token = await resolveExpoToken(context.project.id, context.integration.secretReferenceId!);
      const result = await withExpoWorkspace(context.config.workingDirectory, (cwd) => expoClient.testConnection(context.config, token, cwd));
      const verifiedAt = new Date();
      await updateIntegration(context.project.id, context.integration.id, { status: "configured", lastVerifiedAt: verifiedAt, lastVerificationResult: "connected", lastVerificationReason: null });
      response.json({ data: { ...result, lastVerifiedAt: verifiedAt.toISOString() } });
    } catch (error) {
      if (error instanceof ExpoError) await updateIntegration(context.project.id, context.integration.id, { status: "error", lastVerifiedAt: new Date(), lastVerificationResult: "error", lastVerificationReason: error.code });
      throw error;
    }
    return;
  }
  const { project, integration, config } = await githubContext(request.params.projectId, request.params.integrationId);
  requireActive(project.status);
  try {
    const privateKey = await resolveGitHubAppKey(project.id, integration.secretReferenceId!);
    const result = await githubClient.testConnection(config, privateKey);
    await updateIntegration(project.id, integration.id, { status: "configured", lastVerifiedAt: new Date(), lastVerificationResult: "connected", lastVerificationReason: null });
    response.json({ data: result });
  } catch (error) {
    if (error instanceof GitHubError) {
      await updateIntegration(project.id, integration.id, { status: "error", lastVerifiedAt: new Date(), lastVerificationResult: "error", lastVerificationReason: error.code });
    }
    throw error;
  }
});

async function expoContext(projectId: string | string[], integrationId: unknown) {
  const project = await requiredProject(projectId);
  const integration = await getIntegration(project.id, validId(integrationId as string));
  if (!integration || integration.provider !== "expo" || integration.environmentId !== null) {
    throw new HttpError(404, "EXPO_INTEGRATION_NOT_FOUND", "Project Expo integration not found");
  }
  if (integration.status === "disabled") throw new HttpError(409, "INTEGRATION_DISABLED", "Expo integration is disabled");
  const parsed = expoConfigurationSchema.safeParse(integration.configuration);
  if (!parsed.success || !integration.secretReferenceId) throw new HttpError(409, "EXPO_NOT_CONFIGURED", "Expo integration is incomplete");
  return { project, integration, config: parsed.data };
}

function expoQuery(query: unknown) {
  const parsed = z.strictObject({ integrationId: idSchema }).safeParse(query);
  if (!parsed.success) throw new HttpError(400, "INVALID_QUERY", "A scoped Expo integration ID is required");
  return parsed.data;
}

app.get("/api/projects/:projectId/expo/project", requirePermission("expoRead"), async (request, response) => {
  const { project, integration, config } = await expoContext(request.params.projectId, expoQuery(request.query).integrationId);
  const token = await resolveExpoToken(project.id, integration.secretReferenceId!);
  const data = await withExpoWorkspace(config.workingDirectory, (cwd) => expoClient.project(config, token, cwd));
  response.json({ data });
});

app.get("/api/projects/:projectId/expo/builds", requirePermission("expoRead"), async (request, response) => {
  const query = z.strictObject({ integrationId: idSchema, limit: z.coerce.number().int().min(1).max(30).default(10), offset: z.coerce.number().int().min(0).max(3000).default(0) }).safeParse(request.query);
  if (!query.success) throw new HttpError(400, "INVALID_QUERY", "Invalid Expo build query");
  const { project, integration, config } = await expoContext(request.params.projectId, query.data.integrationId);
  const token = await resolveExpoToken(project.id, integration.secretReferenceId!);
  const builds = await withExpoWorkspace(config.workingDirectory, async (cwd) => {
    await expoClient.project(config, token, cwd);
    return expoClient.listBuilds(config, token, cwd, query.data.limit, query.data.offset);
  });
  for (const build of builds) {
    const record = await syncBuildRecord(project.id, integration.id, build);
    if (record) build.requestedByUserId = record.requestedByUserId;
  }
  response.json({ data: { builds, records: await listBuildRecords(project.id, integration.id) } });
});

app.get("/api/projects/:projectId/expo/builds/:buildId", requirePermission("expoRead"), async (request, response) => {
  const { project, integration, config } = await expoContext(request.params.projectId, expoQuery(request.query).integrationId);
  const token = await resolveExpoToken(project.id, integration.secretReferenceId!);
  const buildId = validId(request.params.buildId);
  const build = await withExpoWorkspace(config.workingDirectory, async (cwd) => {
    await expoClient.project(config, token, cwd);
    return expoClient.getBuild(config, token, cwd, buildId);
  });
  const record = await syncBuildRecord(project.id, integration.id, build);
  if (record) build.requestedByUserId = record.requestedByUserId;
  response.json({ data: { build, record: record ?? await findBuildRecordByExternalId(project.id, integration.id, buildId) } });
});

app.post("/api/projects/:projectId/expo/builds/preview", requirePermission("expoBuildPreview"), async (request, response) => {
  const input = validBody(z.strictObject({ integrationId: idSchema }), request.body);
  const { project, integration, config } = await expoContext(request.params.projectId, input.integrationId);
  requireActive(project.status);
  const token = await resolveExpoToken(project.id, integration.secretReferenceId!);
  const record = await withExpoWorkspace(config.workingDirectory, async (cwd) => {
    await expoClient.ensurePreviewApk(config, token, cwd);
    const recent = await expoClient.listBuilds(config, token, cwd, 30, 0);
    for (const build of recent) await syncBuildRecord(project.id, integration.id, build);
    if ((await listBuildRecords(project.id, integration.id)).some((item) => item.status === "queued" || item.status === "in_progress")) {
      throw new HttpError(409, "PREVIEW_BUILD_ACTIVE", "A preview build is already active for this integration");
    }
    let gitCommitSha: string | null = null, gitBranch: string | null = null;
    try {
      gitCommitSha = (await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 10000, windowsHide: true })).stdout.trim();
      gitBranch = (await execFileAsync("git", ["-C", cwd, "branch", "--show-current"], { timeout: 10000, windowsHide: true })).stdout.trim() || null;
    } catch { /* Source metadata is optional. */ }
    const created = await createBuildRecord(project.id, integration.id, config.previewProfile, currentUser(response).id, null, gitCommitSha, gitBranch);
    try {
      const submitted = await expoClient.startPreview(config, token, cwd);
      return (await updateBuildRecord(project.id, created.id, {
        externalBuildId: submitted.id, status: submitted.status, providerStatus: submitted.providerStatus,
        appVersion: submitted.appVersion, appBuildVersion: submitted.appBuildVersion,
        gitCommitSha: submitted.gitCommitSha ?? gitCommitSha, artifactAvailable: submitted.artifactAvailable,
        errorCode: submitted.errorCode, completedAt: submitted.completedAt ? new Date(submitted.completedAt) : null,
      }))!;
    } catch (error) {
      await updateBuildRecord(project.id, created.id, { status: "failed", errorCode: error instanceof ExpoError ? error.code : "EXPO_SUBMISSION_FAILED", completedAt: new Date() });
      throw error;
    }
  });
  recordSecurityEvent({ actorId: currentUser(response).id, action: "build.preview.request", targetId: record.id, result: "allowed" });
  response.status(201).json({ data: record });
});

app.get("/api/projects/:projectId/github/:kind", requirePermission("integrationsRead"), async (request, response) => {
  const kind = request.params.kind;
  if (typeof kind !== "string" || !githubReadKinds.has(kind as GitHubReadKind)) throw new HttpError(404, "NOT_FOUND", "Route not found");
  const input = z.strictObject({ integrationId: idSchema, page: z.coerce.number().int().min(1).max(100).default(1), perPage: z.coerce.number().int().min(1).max(30).default(10) }).safeParse(request.query);
  if (!input.success) throw new HttpError(400, "INVALID_QUERY", "Invalid GitHub query");
  const { project, integration, config } = await githubContext(request.params.projectId, input.data.integrationId);
  const privateKey = await resolveGitHubAppKey(project.id, integration.secretReferenceId!);
  const data = await githubClient.read(config, privateKey, kind as GitHubReadKind, input.data.page, input.data.perPage);
  response.json({ data });
});

app.get("/api/projects/:projectId/aws/instances", requirePermission("awsRead"), async (request, response) => {
  const query = z.strictObject({ integrationId: idSchema }).safeParse(request.query);
  if (!query.success) throw new HttpError(400, "INVALID_QUERY", "A scoped AWS integration ID is required");
  const { project, config } = await awsContext(request.params.projectId, query.data.integrationId);
  const mapped = (await listAwsServers(project.id)).filter((server) => server.integrationId === query.data.integrationId).slice(0, 20);
  const data = await Promise.all(mapped.map(async (server) => ({ serverId: server.id, environmentId: server.environmentId,
    instance: await awsProvider.describeInstance(config, server.instanceId),
    ssm: await awsProvider.describeSsmTarget(config, server.managedInstanceId) })));
  response.json({ data });
});
app.get("/api/projects/:projectId/aws/instances/:instanceId", requirePermission("awsRead"), async (request, response) => {
  const query = z.strictObject({ integrationId: idSchema }).safeParse(request.query);
  if (!query.success) throw new HttpError(400, "INVALID_QUERY", "A scoped AWS integration ID is required");
  const { project } = await awsContext(request.params.projectId, query.data.integrationId);
  const server = (await listAwsServers(project.id)).find((item) => item.integrationId === query.data.integrationId && item.instanceId === request.params.instanceId);
  if (!server) throw new HttpError(404, "AWS_INSTANCE_NOT_MAPPED", "EC2 instance is not mapped to this project");
  const context = await awsServerContext(project.id, server.id);
  const [instance, ssm] = await Promise.all([awsProvider.describeInstance(context.config, server.instanceId), awsProvider.describeSsmTarget(context.config, server.managedInstanceId)]);
  response.json({ data: { serverId: server.id, environmentId: server.environmentId, instance, ssm } });
});
app.get("/api/projects/:projectId/aws/servers", requirePermission("awsRead"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  response.json({ data: await listAwsServers(project.id) });
});
app.post("/api/projects/:projectId/aws/servers", requirePermission("awsManage"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  requireActive(project.status);
  const input = validBody(createAwsServerSchema, request.body);
  const environment = await getEnvironment(project.id, input.environmentId);
  if (!environment || environment.status !== "active") throw new HttpError(400, "INVALID_ENVIRONMENT", "Active project environment is required");
  const { integration, config } = await awsContext(project.id, input.integrationId);
  if (integration.environmentId !== null && integration.environmentId !== environment.id) throw new HttpError(400, "AWS_MAPPING_INVALID", "Integration belongs to a different environment");
  const server = await createAwsServer(project.id, input, config.region);
  recordSecurityEvent({ actorId: currentUser(response).id, action: "aws.server.map", targetId: server.id, result: "allowed" });
  response.status(201).json({ data: server });
});
app.get("/api/projects/:projectId/aws/servers/:serverId", requirePermission("awsRead"), async (request, response) => {
  const { server, config } = await awsServerContext(request.params.projectId, request.params.serverId);
  const [ec2, ssm] = await Promise.all([
    awsProvider.describeInstance(config, server.instanceId), awsProvider.describeSsmTarget(config, server.managedInstanceId),
  ]);
  response.json({ data: { server, ec2: { ...ec2, id: undefined }, ssm } });
});
app.patch("/api/projects/:projectId/aws/servers/:serverId", requirePermission("awsManage"), async (request, response) => {
  const { project, server } = await awsServerContext(request.params.projectId, request.params.serverId);
  requireActive(project.status);
  const input = validBody(updateAwsServerSchema, request.body);
  const updated = await updateAwsServer(project.id, server.id, input);
  recordSecurityEvent({ actorId: currentUser(response).id, action: "aws.server.update", targetId: server.id, result: "allowed" });
  response.json({ data: updated });
});
app.get("/api/projects/:projectId/aws/servers/:serverId/commands", requirePermission("awsRead"), async (request, response) => {
  const { project, server } = await awsServerContext(request.params.projectId, request.params.serverId);
  response.json({ data: await listAwsCommandRecords(project.id, server.id) });
});
app.post("/api/projects/:projectId/aws/servers/:serverId/actions", requirePermission("awsDiagnostic"), async (request, response) => {
  const { project, server, config } = await awsServerContext(request.params.projectId, request.params.serverId);
  requireActive(project.status);
  const input = validBody(awsActionRequestSchema, request.body);
  if (!server.enabled || config.controlStrategy !== "ssm") throw new HttpError(409, "AWS_ACTION_NOT_ALLOWED", "Server diagnostics are disabled");
  await awsProvider.testConnection(config);
  const ec2 = await awsProvider.describeInstance(config, server.instanceId);
  if (ec2.state !== "running") throw new HttpError(409, "AWS_INSTANCE_NOT_RUNNING", "Mapped EC2 instance is not running");
  const ssm = await awsProvider.describeSsmTarget(config, server.managedInstanceId);
  if (!ssm.managed) throw new HttpError(409, "AWS_SSM_NOT_MANAGED", "Mapped server is not registered with SSM");
  if (ssm.pingStatus !== "Online") throw new HttpError(409, "AWS_SSM_OFFLINE", "Mapped server is not online in SSM");
  if (ssm.platform !== "Linux") throw new HttpError(409, "AWS_PLATFORM_UNSUPPORTED", "Diagnostic actions require a Linux server");
  const record = await createAwsCommandRecord(project.id, server, input.action, currentUser(response).id);
  try {
    const submitted = await awsProvider.sendDiagnostic(config, server.managedInstanceId, input.action);
    const updated = await updateAwsCommandRecord(project.id, record.id, { externalCommandId: submitted.commandId,
      status: submitted.status, providerStatus: submitted.providerStatus,
      startedAt: submitted.status === "in_progress" ? new Date() : null });
    recordSecurityEvent({ actorId: currentUser(response).id, action: "aws.diagnostic.request", targetId: record.id, result: "allowed" });
    response.status(201).json({ data: updated });
  } catch (error) {
    await updateAwsCommandRecord(project.id, record.id, { status: "failed", sanitizedError: error instanceof AwsError ? error.code : "AWS_COMMAND_SUBMISSION_FAILED", completedAt: new Date() });
    throw error;
  }
});
app.get("/api/projects/:projectId/aws/commands/:commandId", requirePermission("awsRead"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  const record = await getAwsCommandRecord(project.id, validId(request.params.commandId));
  if (!record) throw new HttpError(404, "AWS_COMMAND_NOT_FOUND", "Diagnostic command not found");
  const { server, config } = await awsServerContext(project.id, record.serverId);
  if (!record.externalCommandId || ["succeeded", "failed", "canceled", "timed_out"].includes(record.status)) { response.json({ data: record }); return; }
  const invocation = await awsProvider.getCommand(config, record.externalCommandId, server.managedInstanceId);
  const updated = await updateAwsCommandRecord(project.id, record.id, { status: invocation.status, providerStatus: invocation.providerStatus,
    startedAt: invocation.status === "in_progress" && !record.startedAt ? new Date() : record.startedAt ? new Date(record.startedAt) : null,
    completedAt: ["succeeded", "failed", "canceled", "timed_out"].includes(invocation.status) ? new Date() : null,
    exitCode: invocation.exitCode, sanitizedOutput: sanitizeCommandOutput(invocation.output ?? undefined), sanitizedError: sanitizeCommandOutput(invocation.error ?? undefined) });
  response.json({ data: updated });
});

app.patch("/api/projects/:projectId/secret-references/:secretReferenceId", requirePermission("secretReferencesManage"), async (request, response) => {
  const project = await requiredProject(request.params.projectId);
  requireActive(project.status);
  const id = validId(request.params.secretReferenceId);
  const existing = await getSecretReference(project.id, id);
  if (!existing) throw new HttpError(404, "SECRET_REFERENCE_NOT_FOUND", "Secret reference not found");
  const input = validBody(updateSecretReferenceSchema, request.body);
  if ((input.referenceType || input.referenceKey) && !validReferenceLocator(input.referenceType ?? existing.referenceType, input.referenceKey ?? "")) {
    throw new HttpError(400, "INVALID_REFERENCE_KEY", "Supply a valid locator with reference type changes");
  }
  const reference = await updateSecretReference(project.id, id, input);
  recordSecurityEvent({ actorId: currentUser(response).id, action: "secret_reference.update", targetId: id, result: "allowed" });
  response.json({ data: reference });
});

app.get("/api/users", async (_request, response) => {
  response.json({ data: await listUsers() });
});

app.post("/api/users", async (request, response) => {
  const input = validBody(createUserSchema, request.body);
  const user = await createUser(input);
  recordSecurityEvent({ actorId: currentUser(response).id, action: "user.create", targetId: user.id, result: "allowed" });
  response.status(201).json({ data: user });
});

app.get("/api/users/:userId", async (request, response) => {
  const user = await getUser(validId(request.params.userId));
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  response.json({ data: user });
});

app.patch("/api/users/:userId", async (request, response) => {
  const id = validId(request.params.userId);
  const input = validBody(updateUserSchema, request.body);
  const user = await updateUser(id, input);
  if (!user) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
  recordSecurityEvent({ actorId: currentUser(response).id, action: "user.update", targetId: id, result: "allowed" });
  response.json({ data: user });
});

app.use("/api/projects/:projectId", deploymentRouter);

app.use((_request, response) => {
  response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
});

const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof GitHubError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ExpoError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof AwsError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof LastAdminError) {
    response.status(409).json({ error: { code: "LAST_ADMIN", message: error.message } });
    return;
  }
  if (error instanceof PasswordError) {
    response.status(400).json({ error: { code: "INVALID_PASSWORD", message: error.message } });
    return;
  }
  if (error instanceof SyntaxError && "status" in error) {
    response.status(400).json({ error: { code: "INVALID_JSON", message: "Invalid JSON body" } });
    return;
  }
  const databaseError = error as { code?: string; cause?: { code?: string } };
  const code = databaseError?.code ?? databaseError?.cause?.code;
  if (code === "ER_DUP_ENTRY") {
    response.status(409).json({ error: { code: "DUPLICATE_RESOURCE", message: "A resource with this value already exists" } });
    return;
  }
  if (typeof code === "string" && ["ECONNREFUSED", "PROTOCOL_CONNECTION_LOST"].includes(code)) {
    response.status(503).json({ error: { code: "DATABASE_UNAVAILABLE", message: "Local database unavailable" } });
    return;
  }
  console.error("API operation failed");
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
};
app.use(errorHandler);
