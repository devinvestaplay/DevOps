import type { InvocationInfo } from "../aws/client";

export type DeploymentStepType =
  | "capture_current_revision" | "fetch_source" | "checkout_revision"
  | "install_dependencies" | "build" | "restart_service" | "health_check"
  | "rollback_checkout" | "rollback_install" | "rollback_build" | "rollback_restart" | "rollback_health_check";

export type PreflightProbeType = "repository" | "runtime" | "service" | "health";

export type DeploymentTarget = {
  region: string;
  accountId: string;
  managedInstanceId: string;
};

// Values come from persisted, Admin-controlled configuration or a resolved GitHub commit.
// No browser-supplied command or server path belongs in this structure.
export type DeploymentExecutionConfig = {
  repositoryPath: string;
  applicationPath: string;
  executionAccount: string;
  repositorySshHostAlias: string | null;
  expectedRepositoryOwner: string;
  expectedRepositoryName: string;
  allowedBranch: string;
  targetSha: string;
  previousSha?: string;
  packageManager: "npm";
  installStrategy: "none" | "npm_ci";
  buildStrategy: "none" | "npm_build";
  processManager: "pm2";
  processName: string;
  healthUrl: string;
  healthTimeoutSeconds: number;
};

export type DeploymentStepResult = { commandId: string; status: "queued" | "in_progress" | "succeeded" | "failed" | "canceled" | "timed_out"; providerStatus: string };

export interface DeploymentSsmProvider {
  sendStep(target: DeploymentTarget, step: DeploymentStepType, config: DeploymentExecutionConfig): Promise<DeploymentStepResult>;
  sendProbe(target: DeploymentTarget, probe: PreflightProbeType, config: DeploymentExecutionConfig): Promise<DeploymentStepResult>;
  getInvocation(target: DeploymentTarget, commandId: string): Promise<InvocationInfo>;
}
