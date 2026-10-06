import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import { AwsError, mappedError, normalizeSsmStatus, sanitizeCommandOutput } from "../aws/client";
import type { InvocationInfo } from "../aws/client";
import { buildProbeCommand, buildStepCommand } from "./template";
import type { DeploymentExecutionConfig, DeploymentSsmProvider, DeploymentStepResult, DeploymentStepType, DeploymentTarget, PreflightProbeType } from "./types";

function validateTarget(target: DeploymentTarget): void {
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(target.region) || !/^\d{12}$/.test(target.accountId) || !/^(?:i-[a-f0-9]{8,17}|mi-[a-f0-9]{17})$/.test(target.managedInstanceId))
    throw new AwsError("DEPLOYMENT_TARGET_INVALID", 422, "Invalid deployment target");
}

export class DeploymentSsmClient implements DeploymentSsmProvider {
  private readonly clients = new Map<string, SSMClient>();
  private forRegion(region: string): SSMClient {
    let client = this.clients.get(region);
    if (!client) { client = new SSMClient({ region, maxAttempts: 2 }); this.clients.set(region, client); }
    return client;
  }

  private async send(target: DeploymentTarget, command: string, label: string): Promise<DeploymentStepResult> {
    validateTarget(target);
    try {
      const result = await this.forRegion(target.region).send(new SendCommandCommand({
        DocumentName: "AWS-RunShellScript",
        InstanceIds: [target.managedInstanceId],
        Parameters: { commands: [command], executionTimeout: ["300"] },
        TimeoutSeconds: 60,
        Comment: `Investaplay DevOps ${label}`,
      }), { abortSignal: AbortSignal.timeout(15000) });
      const commandId = result.Command?.CommandId;
      if (!commandId) throw new AwsError("AWS_COMMAND_NOT_CREATED", 502, "SSM did not return a command ID");
      const providerStatus = result.Command?.Status ?? "Pending";
      return { commandId, providerStatus, status: normalizeSsmStatus(providerStatus) };
    } catch (error) { throw mappedError(error); }
  }

  sendStep(target: DeploymentTarget, step: DeploymentStepType, config: DeploymentExecutionConfig): Promise<DeploymentStepResult> {
    return this.send(target, buildStepCommand(step, config), `deployment step: ${step}`);
  }

  sendProbe(target: DeploymentTarget, probe: PreflightProbeType, config: DeploymentExecutionConfig): Promise<DeploymentStepResult> {
    return this.send(target, buildProbeCommand(probe, config), `read-only deployment preflight: ${probe}`);
  }

  async getInvocation(target: DeploymentTarget, commandId: string): Promise<InvocationInfo> {
    validateTarget(target);
    if (!/^[a-f0-9-]{36}$/i.test(commandId)) throw new AwsError("AWS_COMMAND_ID_INVALID", 422, "Invalid SSM command ID");
    let result;
    try {
      result = await this.forRegion(target.region).send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: target.managedInstanceId }), { abortSignal: AbortSignal.timeout(15000) });
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
      if (name === "InvocationDoesNotExist") return { status: "queued", providerStatus: "Pending", exitCode: null, output: null, error: null };
      throw mappedError(error);
    }
    const providerStatus = result.Status ?? "Unknown";
    return { status: normalizeSsmStatus(providerStatus), providerStatus, exitCode: result.ResponseCode ?? null,
      output: sanitizeCommandOutput(result.StandardOutputContent), error: sanitizeCommandOutput(result.StandardErrorContent) };
  }
}
