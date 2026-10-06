import { awsConfigurationSchema, githubConfigurationSchema, type DeploymentConfiguration } from "@investaplay/devops-contracts";
import { getProject, getEnvironment } from "../store";
import { getAwsServer } from "../aws/store";
import { getIntegration } from "../integration-store";
import { getDeploymentConfiguration } from "../deploy-store";
import { validateBranch, validateExecutionConfig, validateRepositoryPart } from "../deploy-executor/template";
import type { DeploymentExecutionConfig, DeploymentTarget } from "../deploy-executor/types";

export class DeploymentError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function deploymentContext(projectId: string, configurationId: string, requireEnabled = true) {
  const project = await getProject(projectId);
  if (!project) throw new DeploymentError(404, "PROJECT_NOT_FOUND", "Project not found");
  const config = await getDeploymentConfiguration(projectId, configurationId);
  if (!config) throw new DeploymentError(404, "DEPLOYMENT_CONFIG_NOT_FOUND", "Deployment configuration not found");
  if (requireEnabled && !config.enabled) throw new DeploymentError(409, "DEPLOYMENT_CONFIG_DISABLED", "Deployment configuration is disabled");
  const environment = await getEnvironment(projectId, config.environmentId);
  const server = await getAwsServer(projectId, config.serverId);
  const github = await getIntegration(projectId, config.githubIntegrationId);
  if (!environment || !server || !github) throw new DeploymentError(409, "DEPLOYMENT_MAPPING_INVALID", "Deployment mapping is incomplete");
  const aws = await getIntegration(projectId, server.integrationId);
  if (!aws || aws.provider !== "aws" || github.provider !== "github") throw new DeploymentError(409, "DEPLOYMENT_MAPPING_INVALID", "Deployment integrations are invalid");
  if (project.status !== "active" || environment.status !== "active" || !server.enabled || github.status !== "configured" || aws.status !== "configured") {
    throw new DeploymentError(409, "DEPLOYMENT_TARGET_INACTIVE", "Project or deployment target is inactive");
  }
  if (server.environmentId !== environment.id || (aws.environmentId && aws.environmentId !== environment.id) || (github.environmentId && github.environmentId !== environment.id)) {
    throw new DeploymentError(409, "DEPLOYMENT_MAPPING_INVALID", "Environment mapping does not match the target");
  }
  const awsConfig = awsConfigurationSchema.safeParse(aws.configuration);
  const githubConfig = githubConfigurationSchema.safeParse(github.configuration);
  if (!awsConfig.success || !githubConfig.success || awsConfig.data.controlStrategy !== "ssm" || awsConfig.data.region !== server.region ||
      !githubConfig.data.appId || !githubConfig.data.installationId || !github.secretReferenceId) {
    throw new DeploymentError(409, "DEPLOYMENT_INTEGRATION_INCOMPLETE", "Linked integration is incomplete");
  }
  if (aws.lastVerificationResult !== "connected" || github.lastVerificationResult !== "connected") {
    throw new DeploymentError(409, "DEPLOYMENT_INTEGRATION_UNVERIFIED", "Linked integrations must be verified");
  }
  if (config.allowedBranch !== githubConfig.data.defaultBranch) throw new DeploymentError(409, "DEPLOYMENT_BRANCH_NOT_ALLOWED", "Configured branch does not match GitHub integration");
  validateBranch(config.allowedBranch);
  validateRepositoryPart(githubConfig.data.owner);
  validateRepositoryPart(githubConfig.data.repository);
  return { project, config, environment, server, aws, awsConfig: awsConfig.data, github, githubConfig: {
    ...githubConfig.data, appId: githubConfig.data.appId, installationId: githubConfig.data.installationId,
  } };
}

export function executionConfig(config: DeploymentConfiguration, owner: string, repository: string, targetSha: string, previousSha?: string): DeploymentExecutionConfig {
  return validateExecutionConfig({ repositoryPath: config.repositoryPath, applicationPath: config.applicationPath,
    executionAccount: config.executionAccount ?? "", repositorySshHostAlias: config.repositorySshHostAlias,
    allowedBranch: config.allowedBranch, targetSha, previousSha, expectedRepositoryOwner: owner, expectedRepositoryName: repository,
    packageManager: "npm", installStrategy: config.installStrategy, buildStrategy: config.buildStrategy,
    processManager: "pm2", processName: config.serviceName, healthUrl: config.healthUrl, healthTimeoutSeconds: config.healthTimeoutSeconds });
}

export function executionTarget(region: string, accountId: string, managedInstanceId: string): DeploymentTarget {
  return { region, accountId, managedInstanceId };
}
