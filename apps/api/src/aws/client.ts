import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { SSMClient, DescribeInstanceInformationCommand, GetCommandInvocationCommand, SendCommandCommand } from "@aws-sdk/client-ssm";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { AwsAction, AwsCommandStatus } from "@investaplay/devops-contracts";

export type AwsConfig = { region: string; accountId: string; controlStrategy: "ssm" | "manual" };
export type Ec2Info = { id: string; state: string; instanceType: string | null; availabilityZone: string | null; privateIp: string | null; publicIp: string | null; launchTime: string | null };
export type SsmInfo = { managed: boolean; pingStatus: string | null; platform: string | null; agentVersion: string | null; lastPingAt: string | null };
export type InvocationInfo = { status: AwsCommandStatus; providerStatus: string; exitCode: number | null; output: string | null; error: string | null };
export type AwsConnection = { connected: true; provider: "aws"; accountId: string; region: string; instanceId: string | null; ssmManaged: boolean | null; ssmOnline: boolean | null };

export class AwsError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}

export function mappedError(error: unknown): AwsError {
  if (error instanceof AwsError) return error;
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (/ExpiredToken|InvalidClientTokenId|UnrecognizedClient|CredentialsProvider|CredentialsError/i.test(name)) return new AwsError("AWS_AUTH_FAILED", 502, "AWS authentication failed");
  if (/AccessDenied|UnauthorizedOperation/i.test(name)) return new AwsError("AWS_ACCESS_DENIED", 502, "AWS access denied");
  if (/Throttl|TooManyRequests|RequestLimitExceeded/i.test(name)) return new AwsError("AWS_RATE_LIMITED", 503, "AWS request rate limit reached");
  if (/Timeout|Abort|Networking|ECONN|ENOTFOUND/i.test(name)) return new AwsError("AWS_UNAVAILABLE", 503, "AWS request timed out or is unavailable");
  if (/InvalidInstanceID|InvalidCommandId|InvalidDocument/i.test(name)) return new AwsError("AWS_RESOURCE_NOT_FOUND", 404, "AWS resource was not found");
  return new AwsError("AWS_PROVIDER_ERROR", 502, "AWS operation failed");
}

async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw mappedError(error); }
}

const fixedCommands: Record<AwsAction, string> = {
  server_identity: "hostname; uname -s",
  disk_usage: "df -hP",
  memory_usage: "free -m",
};

export function sanitizeCommandOutput(value: string | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/\x1b\[[0-9;]*m/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\b(?:password|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*\S+/gi, "[REDACTED]");
  return clean.slice(0, 4096);
}

export function normalizeSsmStatus(value: string | undefined): AwsCommandStatus {
  switch (value) {
    case "Pending": case "Delayed": return "queued";
    case "InProgress": return "in_progress";
    case "Success": return "succeeded";
    case "Cancelled": case "Cancelling": return "canceled";
    case "TimedOut": case "Delivery Timed Out": case "Execution Timed Out": return "timed_out";
    default: return "failed";
  }
}

export interface AwsProvider {
  testConnection(config: AwsConfig, target?: { instanceId: string; managedInstanceId: string }): Promise<AwsConnection>;
  describeInstance(config: AwsConfig, instanceId: string): Promise<Ec2Info>;
  describeSsmTarget(config: AwsConfig, managedInstanceId: string): Promise<SsmInfo>;
  sendDiagnostic(config: AwsConfig, managedInstanceId: string, action: AwsAction): Promise<{ commandId: string; status: AwsCommandStatus; providerStatus: string }>;
  getCommand(config: AwsConfig, commandId: string, managedInstanceId: string): Promise<InvocationInfo>;
}

export class AwsClient implements AwsProvider {
  private readonly clients = new Map<string, { sts: STSClient; ec2: EC2Client; ssm: SSMClient }>();
  private forRegion(region: string) {
    let clients = this.clients.get(region);
    if (!clients) {
      // The STS global endpoint avoids dependence on the mapped region's STS network path.
      // EC2 and SSM still use the mapped region.
      clients = { sts: new STSClient({ region: "aws-global", maxAttempts: 2 }), ec2: new EC2Client({ region, maxAttempts: 2 }), ssm: new SSMClient({ region, maxAttempts: 2 }) };
      this.clients.set(region, clients);
    }
    return clients;
  }
  async testConnection(config: AwsConfig, target?: { instanceId: string; managedInstanceId: string }): Promise<AwsConnection> {
    const identity = await safe(() => this.forRegion(config.region).sts.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(15000) }));
    if (!identity.Account || identity.Account !== config.accountId) throw new AwsError("AWS_ACCOUNT_MISMATCH", 409, "AWS account does not match configuration");
    if (!target) return { connected: true, provider: "aws", accountId: identity.Account, region: config.region, instanceId: null, ssmManaged: null, ssmOnline: null };
    await this.describeInstance(config, target.instanceId);
    const ssm = await this.describeSsmTarget(config, target.managedInstanceId);
    return { connected: true, provider: "aws", accountId: identity.Account, region: config.region, instanceId: target.instanceId, ssmManaged: ssm.managed, ssmOnline: ssm.pingStatus === "Online" };
  }
  async describeInstance(config: AwsConfig, instanceId: string): Promise<Ec2Info> {
    const result = await safe(() => this.forRegion(config.region).ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }), { abortSignal: AbortSignal.timeout(15000) }));
    const instance = result.Reservations?.flatMap((reservation) => reservation.Instances ?? []).find((item) => item.InstanceId === instanceId);
    if (!instance) throw new AwsError("AWS_INSTANCE_NOT_FOUND", 404, "Mapped EC2 instance was not found");
    return { id: instanceId, state: instance.State?.Name ?? "unknown", instanceType: instance.InstanceType ?? null, availabilityZone: instance.Placement?.AvailabilityZone ?? null,
      privateIp: instance.PrivateIpAddress ?? null, publicIp: instance.PublicIpAddress ?? null, launchTime: instance.LaunchTime?.toISOString() ?? null };
  }
  async describeSsmTarget(config: AwsConfig, managedInstanceId: string): Promise<SsmInfo> {
    const result = await safe(() => this.forRegion(config.region).ssm.send(new DescribeInstanceInformationCommand({ Filters: [{ Key: "InstanceIds", Values: [managedInstanceId] }], MaxResults: 5 }), { abortSignal: AbortSignal.timeout(15000) }));
    const item = result.InstanceInformationList?.find((entry) => entry.InstanceId === managedInstanceId);
    return { managed: Boolean(item), pingStatus: item?.PingStatus ?? null, platform: item?.PlatformType ?? null, agentVersion: item?.AgentVersion ?? null, lastPingAt: item?.LastPingDateTime?.toISOString() ?? null };
  }
  async sendDiagnostic(config: AwsConfig, managedInstanceId: string, action: AwsAction) {
    if (config.controlStrategy !== "ssm" || !(action in fixedCommands)) throw new AwsError("AWS_ACTION_NOT_ALLOWED", 409, "Diagnostic action is unavailable");
    const result = await safe(() => this.forRegion(config.region).ssm.send(new SendCommandCommand({
      DocumentName: "AWS-RunShellScript", InstanceIds: [managedInstanceId], Parameters: { commands: [fixedCommands[action]] }, TimeoutSeconds: 60,
      Comment: `Investaplay DevOps diagnostic: ${action}`,
    }), { abortSignal: AbortSignal.timeout(15000) }));
    const commandId = result.Command?.CommandId;
    if (!commandId) throw new AwsError("AWS_COMMAND_NOT_CREATED", 502, "SSM did not return a command ID");
    const providerStatus = result.Command?.Status ?? "Pending";
    return { commandId, status: normalizeSsmStatus(providerStatus), providerStatus };
  }
  async getCommand(config: AwsConfig, commandId: string, managedInstanceId: string): Promise<InvocationInfo> {
    let result;
    try {
      result = await this.forRegion(config.region).ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: managedInstanceId }), { abortSignal: AbortSignal.timeout(15000) });
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
      // Run Command is eventually consistent immediately after SendCommand.
      if (name === "InvocationDoesNotExist") return { status: "queued", providerStatus: "Pending", exitCode: null, output: null, error: null };
      throw mappedError(error);
    }
    const providerStatus = result.Status ?? "Unknown";
    return { status: normalizeSsmStatus(providerStatus), providerStatus, exitCode: result.ResponseCode ?? null,
      output: sanitizeCommandOutput(result.StandardOutputContent), error: sanitizeCommandOutput(result.StandardErrorContent) };
  }
}
