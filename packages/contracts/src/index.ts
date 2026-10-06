import { z } from "zod";

export const projectStatusSchema = z.enum(["active", "archived"]);
export const environmentTypeSchema = z.enum(["development", "staging", "production"]);
export const environmentStatusSchema = z.enum(["active", "disabled"]);
export const idSchema = z.uuid();
export const sessionCookieName = "investaplay_session";
export const roleSchema = z.enum(["developer", "release_manager", "admin"]);
export const userStatusSchema = z.enum(["active", "disabled"]);

const nameSchema = z.string().trim().min(1).max(120);
const slugSchema = z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const createProjectSchema = z.strictObject({
  name: nameSchema,
  slug: slugSchema,
  description: z.string().trim().max(2000).default(""),
});

export const updateProjectSchema = z.strictObject({
  name: nameSchema.optional(),
  slug: slugSchema.optional(),
  description: z.string().trim().max(2000).optional(),
  status: projectStatusSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const createEnvironmentSchema = z.strictObject({
  name: nameSchema,
  type: environmentTypeSchema,
});

export const updateEnvironmentSchema = z.strictObject({
  name: nameSchema.optional(),
  type: environmentTypeSchema.optional(),
  status: environmentStatusSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type EnvironmentType = z.infer<typeof environmentTypeSchema>;
export type EnvironmentStatus = z.infer<typeof environmentStatusSchema>;
export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateEnvironmentInput = z.input<typeof createEnvironmentSchema>;
export type UpdateEnvironmentInput = z.infer<typeof updateEnvironmentSchema>;

export type Project = {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
};

export type Environment = {
  id: string;
  projectId: string;
  name: string;
  type: EnvironmentType;
  status: EnvironmentStatus;
  createdAt: string;
  updatedAt: string;
};

export type ApiError = { error: { code: string; message: string } };
export type ApiData<T> = { data: T };

export const createUserSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  name: nameSchema,
  password: z.string().min(12).max(128),
  role: roleSchema,
});

export const updateUserSchema = z.strictObject({
  name: nameSchema.optional(),
  role: roleSchema.optional(),
  status: userStatusSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export type Role = z.infer<typeof roleSchema>;
export type UserStatus = z.infer<typeof userStatusSchema>;
export type CreateUserInput = z.output<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

export const integrationProviderSchema = z.enum(["github", "expo", "aws"]);
export const integrationStatusSchema = z.enum(["configured", "disabled", "error"]);
const labelSchema = z.string().trim().min(1).max(120);
const pathPart = z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._/-]+$/);
export const githubConfigurationSchema = z.strictObject({
  owner: pathPart, repository: pathPart, defaultBranch: pathPart,
  repositoryType: z.enum(["frontend", "backend", "monorepo", "other"]),
  appId: z.string().regex(/^[1-9][0-9]{0,18}$/).optional(),
  installationId: z.string().regex(/^[1-9][0-9]{0,18}$/).optional(),
});
export const expoConfigurationSchema = z.strictObject({
  expoAccount: pathPart, projectSlug: pathPart, projectId: z.uuid(),
  workingDirectory: pathPart, previewProfile: pathPart, productionProfile: pathPart,
  androidEnabled: z.boolean().default(true),
});
export const awsConfigurationSchema = z.strictObject({
  region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  accountId: z.string().regex(/^\d{12}$/),
  controlStrategy: z.enum(["ssm", "manual"]),
});
export const awsActionSchema = z.enum(["server_identity", "disk_usage", "memory_usage"]);
export const awsCommandStatusSchema = z.enum(["queued", "in_progress", "succeeded", "failed", "canceled", "timed_out"]);
const awsInstanceIdSchema = z.string().regex(/^i-[0-9a-f]{8,17}$/);
const awsManagedInstanceIdSchema = z.string().regex(/^(?:i-[0-9a-f]{8,17}|mi-[0-9a-f]{17})$/);
export const createAwsServerSchema = z.strictObject({
  environmentId: idSchema, integrationId: idSchema, displayName: labelSchema,
  role: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/),
  instanceId: awsInstanceIdSchema,
  managedInstanceId: awsManagedInstanceIdSchema.optional(),
});
export const updateAwsServerSchema = z.strictObject({
  displayName: labelSchema.optional(),
  role: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/).optional(),
  managedInstanceId: awsManagedInstanceIdSchema.optional(),
  enabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const awsActionRequestSchema = z.strictObject({ action: awsActionSchema });
export type CreateAwsServerInput = z.infer<typeof createAwsServerSchema>;
export type UpdateAwsServerInput = z.infer<typeof updateAwsServerSchema>;
export type AwsAction = z.infer<typeof awsActionSchema>;
export type AwsCommandStatus = z.infer<typeof awsCommandStatusSchema>;
export type AwsServer = {
  id: string; projectId: string; environmentId: string; integrationId: string;
  displayName: string; role: string; region: string; instanceId: string;
  managedInstanceId: string; enabled: boolean; createdAt: string; updatedAt: string;
};
export type AwsCommandRecord = {
  id: string; projectId: string; environmentId: string; integrationId: string;
  serverId: string; provider: "aws"; action: AwsAction;
  externalCommandId: string | null; status: AwsCommandStatus;
  providerStatus: string | null;
  requestedByUserId: string; requestedAt: string; startedAt: string | null;
  completedAt: string | null; exitCode: number | null;
  sanitizedOutput: string | null; sanitizedError: string | null;
};
export type AwsServerStatus = {
  server: AwsServer;
  ec2: { state: string; instanceType: string | null; availabilityZone: string | null; privateIp: string | null; publicIp: string | null; launchTime: string | null } | null;
  ssm: { managed: boolean; pingStatus: string | null; platform: string | null; agentVersion: string | null; lastPingAt: string | null };
};
export const integrationConfigurationSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("github"), configuration: githubConfigurationSchema }),
  z.strictObject({ provider: z.literal("expo"), configuration: expoConfigurationSchema }),
  z.strictObject({ provider: z.literal("aws"), configuration: awsConfigurationSchema }),
]);
export const createIntegrationSchema = z.strictObject({
  provider: integrationProviderSchema, displayName: labelSchema,
  environmentId: idSchema.nullable().default(null),
  secretReferenceId: idSchema.nullable().default(null),
  configuration: z.unknown(),
});
export const updateIntegrationSchema = z.strictObject({
  displayName: labelSchema.optional(), environmentId: idSchema.nullable().optional(),
  secretReferenceId: idSchema.nullable().optional(),
  status: integrationStatusSchema.optional(), configuration: z.unknown().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const secretReferenceTypeSchema = z.enum(["environment_variable", "aws_secrets_manager", "aws_ssm_parameter"]);
export const createSecretReferenceSchema = z.strictObject({
  displayName: labelSchema, provider: integrationProviderSchema, purpose: labelSchema,
  environmentId: idSchema.nullable().default(null), referenceType: secretReferenceTypeSchema,
  referenceKey: z.string().trim().min(1).max(512),
});
export const updateSecretReferenceSchema = z.strictObject({
  displayName: labelSchema.optional(), purpose: labelSchema.optional(),
  referenceType: secretReferenceTypeSchema.optional(), referenceKey: z.string().trim().min(1).max(512).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;
export type Integration = {
  id: string; projectId: string; environmentId: string | null; provider: IntegrationProvider;
  displayName: string; status: IntegrationStatus; configuration: Record<string, unknown> | null;
  secretReferenceId: string | null; createdAt: string; updatedAt: string;
  lastVerifiedAt: string | null; lastVerificationResult: "connected" | "error" | null;
  lastVerificationReason: string | null;
};
export type SecretReference = {
  id: string; projectId: string; environmentId: string | null; provider: IntegrationProvider;
  displayName: string; purpose: string; referenceType: z.infer<typeof secretReferenceTypeSchema>;
  hasReferenceKey: true; createdAt: string; updatedAt: string;
};

export const buildStatusSchema = z.enum(["queued", "in_progress", "succeeded", "failed", "canceled"]);
export type BuildStatus = z.infer<typeof buildStatusSchema>;
export type BuildRecord = {
  id: string; projectId: string; integrationId: string; environmentId: string | null;
  provider: "expo"; externalBuildId: string | null; platform: "android";
  profile: string; status: BuildStatus; providerStatus: string | null;
  appVersion: string | null; appBuildVersion: string | null;
  gitCommitSha: string | null; gitBranch: string | null; requestedByUserId: string | null;
  requestedAt: string; startedAt: string | null; completedAt: string | null;
  artifactAvailable: boolean; errorCode: string | null;
};
export type ExpoProjectInfo = { account: string; slug: string; projectId: string; previewProfile: string; androidEnabled: boolean };
export type ExpoBuildInfo = {
  id: string; platform: "android" | "ios"; profile: string | null; status: BuildStatus;
  providerStatus: string; appVersion: string | null; appBuildVersion: string | null;
  gitCommitSha: string | null; createdAt: string; completedAt: string | null;
  artifactAvailable: boolean; errorCode: string | null; requestedByUserId: string | null;
};

// Deployment requests refer only to saved configuration; command text and paths never come from the browser.
export const deploymentStatusSchema = z.enum(["awaiting_confirmation", "queued", "in_progress", "verifying", "succeeded", "failed", "rollback_pending", "rolling_back", "rolled_back", "rollback_failed", "canceled"]);
export const deploymentStepTypeSchema = z.enum(["preflight", "capture_current_revision", "fetch_source", "checkout_revision", "install_dependencies", "build", "restart_service", "health_check", "rollback_checkout", "rollback_install", "rollback_build", "rollback_restart", "rollback_health_check"]);
export const deploymentStepStatusSchema = z.enum(["pending", "in_progress", "succeeded", "failed", "skipped", "timed_out"]);
export const deploymentBranchSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine((branch) => !branch.includes("..") && !branch.includes("//") && !branch.split("/").some((part) => part.startsWith(".") || part.startsWith("-")) && !branch.endsWith("/"), "Invalid branch");
export const deploymentPathSchema = z.string().min(2).max(240).regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/).refine((path) => !path.split("/").some((part) => part.startsWith("-")), "Path segment cannot begin with a hyphen");
export const deploymentServiceSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const deploymentExecutionAccountSchema = z.string().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*$/);
export const deploymentSshHostAliasSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const deploymentHealthUrlSchema = z.url().max(512).refine((value) => { try { const url = new URL(value); return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(value) && !url.username && !url.password && !url.hash && !url.search && /^[A-Za-z0-9/_-]*$/.test(url.pathname); } catch { return false; } }, "Health URL must use local HTTP with explicit port and safe path");
export const deploymentConfigurationFieldsSchema = z.strictObject({
  environmentId: idSchema, serverId: idSchema, githubIntegrationId: idSchema,
  allowedBranch: deploymentBranchSchema, repositoryPath: deploymentPathSchema, applicationPath: deploymentPathSchema,
  executionAccount: deploymentExecutionAccountSchema.nullable(), repositorySshHostAlias: deploymentSshHostAliasSchema.nullable(),
  packageManager: z.enum(["none", "npm"]),
  installStrategy: z.enum(["none", "npm_ci"]),
  buildStrategy: z.enum(["none", "npm_build"]),
  processManager: z.literal("pm2"), serviceName: deploymentServiceSchema,
  healthUrl: deploymentHealthUrlSchema, healthTimeoutSeconds: z.number().int().min(2).max(30),
  rollbackStrategy: z.literal("manual"), enabled: z.boolean(),
});
export const createDeploymentConfigurationSchema = deploymentConfigurationFieldsSchema.superRefine((value, ctx) => {
  if (value.packageManager === "none" && (value.installStrategy !== "none" || value.buildStrategy !== "none")) ctx.addIssue({ code: "custom", path: ["packageManager"], message: "Package manager is required for install/build" });
  const prefix = { npm: "npm_", none: "none" }[value.packageManager];
  if (value.installStrategy !== "none" && !value.installStrategy.startsWith(prefix)) ctx.addIssue({ code: "custom", path: ["installStrategy"], message: "Install strategy must match package manager" });
  if (value.buildStrategy !== "none" && !value.buildStrategy.startsWith(prefix)) ctx.addIssue({ code: "custom", path: ["buildStrategy"], message: "Build strategy must match package manager" });
  if (value.applicationPath !== value.repositoryPath && !value.applicationPath.startsWith(`${value.repositoryPath}/`)) ctx.addIssue({ code: "custom", path: ["applicationPath"], message: "Application path must be inside repository path" });
});
export const updateDeploymentConfigurationSchema = deploymentConfigurationFieldsSchema.partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");
export const createDeploymentSchema = z.strictObject({ configurationId: idSchema, sourceRef: deploymentBranchSchema });
export const confirmDeploymentSchema = z.strictObject({ challenge: z.string().min(1).max(300) });
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;
export type DeploymentStepType = z.infer<typeof deploymentStepTypeSchema>;
export type DeploymentStepStatus = z.infer<typeof deploymentStepStatusSchema>;
export type CreateDeploymentConfigurationInput = z.infer<typeof createDeploymentConfigurationSchema>;
export type UpdateDeploymentConfigurationInput = z.infer<typeof updateDeploymentConfigurationSchema>;
export type DeploymentConfiguration = CreateDeploymentConfigurationInput & { id: string; projectId: string; createdAt: string; updatedAt: string };
export type DeploymentRecord = {
  id: string; projectId: string; environmentId: string; serverId: string; configurationId: string;
  githubIntegrationId: string; repositoryOwner: string; repositoryName: string; requestedRef: string;
  targetSha: string; previousSha: string | null; status: DeploymentStatus;
  configurationSnapshot: DeploymentConfiguration; preflightedAt: string;
  requestedByUserId: string; requestedAt: string; startedAt: string | null; completedAt: string | null;
  healthHttpStatus: number | null; healthLatencyMs: number | null; healthCheckedAt: string | null;
  healthResponse: string | null; sanitizedError: string | null;
};
export type DeploymentStepRecord = {
  id: string; projectId: string; deploymentId: string; sequence: number; stepType: DeploymentStepType;
  status: DeploymentStepStatus; startedAt: string | null; completedAt: string | null;
  externalCommandId: string | null; exitCode: number | null; sanitizedOutput: string | null; sanitizedError: string | null;
};
