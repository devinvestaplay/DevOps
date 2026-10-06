import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { CreateDeploymentConfigurationInput, DeploymentConfiguration, DeploymentRecord, DeploymentStatus, DeploymentStepRecord, DeploymentStepStatus, DeploymentStepType, UpdateDeploymentConfigurationInput } from "@investaplay/devops-contracts";
import { db } from "../db/client";
import { deploymentConfigurations, deploymentRecords, deploymentStepRecords } from "../db/schema";

type ConfigRow = typeof deploymentConfigurations.$inferSelect;
type RecordRow = typeof deploymentRecords.$inferSelect;
type StepRow = typeof deploymentStepRecords.$inferSelect;
// A failed rollback keeps the database target lock until an operator resolves the server state.
const terminal = new Set<DeploymentStatus>(["succeeded", "failed", "rolled_back", "canceled"]);
const transitions: Record<DeploymentStatus, DeploymentStatus[]> = {
  awaiting_confirmation: ["queued", "canceled"], queued: ["in_progress", "failed", "canceled"],
  in_progress: ["verifying", "failed", "rollback_pending"], verifying: ["succeeded", "failed", "rollback_pending"],
  succeeded: [], failed: ["rollback_pending"], rollback_pending: ["rolling_back", "canceled"],
  rolling_back: ["rolled_back", "rollback_failed"], rolled_back: [], rollback_failed: [], canceled: [],
};
function publicConfig(row: ConfigRow): DeploymentConfiguration {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function publicRecord(row: RecordRow): DeploymentRecord {
  return { ...row, configurationSnapshot: row.configurationSnapshot as DeploymentConfiguration, preflightedAt: row.preflightedAt.toISOString(),
    requestedAt: row.requestedAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null, healthCheckedAt: row.healthCheckedAt?.toISOString() ?? null };
}
function publicStep(row: StepRow): DeploymentStepRecord {
  return { ...row,
    startedAt: row.startedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null };
}
export async function listDeploymentConfigurations(projectId: string): Promise<DeploymentConfiguration[]> {
  return (await db.select().from(deploymentConfigurations).where(eq(deploymentConfigurations.projectId, projectId)).orderBy(desc(deploymentConfigurations.createdAt)).limit(100)).map(publicConfig);
}
export async function getDeploymentConfiguration(projectId: string, id: string): Promise<DeploymentConfiguration | null> {
  const [row] = await db.select().from(deploymentConfigurations).where(and(eq(deploymentConfigurations.projectId, projectId), eq(deploymentConfigurations.id, id))).limit(1);
  return row ? publicConfig(row) : null;
}
export async function createDeploymentConfiguration(projectId: string, input: CreateDeploymentConfigurationInput): Promise<DeploymentConfiguration> {
  const id = randomUUID();
  await db.insert(deploymentConfigurations).values({ ...input, id, projectId, createdAt: new Date(), updatedAt: new Date() });
  return (await getDeploymentConfiguration(projectId, id))!;
}
export async function updateDeploymentConfiguration(projectId: string, id: string, input: UpdateDeploymentConfigurationInput): Promise<DeploymentConfiguration | null> {
  if (!await getDeploymentConfiguration(projectId, id)) return null;
  await db.update(deploymentConfigurations).set({ ...input, updatedAt: new Date() })
    .where(and(eq(deploymentConfigurations.projectId, projectId), eq(deploymentConfigurations.id, id)));
  return getDeploymentConfiguration(projectId, id);
}
export async function listDeploymentRecords(projectId: string): Promise<DeploymentRecord[]> {
  return (await db.select().from(deploymentRecords).where(eq(deploymentRecords.projectId, projectId)).orderBy(desc(deploymentRecords.requestedAt)).limit(100)).map(publicRecord);
}
export async function getDeploymentRecord(projectId: string, id: string): Promise<DeploymentRecord | null> {
  const [row] = await db.select().from(deploymentRecords).where(and(eq(deploymentRecords.projectId, projectId), eq(deploymentRecords.id, id))).limit(1);
  return row ? publicRecord(row) : null;
}
export async function createDeploymentRecord(projectId: string, config: DeploymentConfiguration, input: {
  repositoryOwner: string; repositoryName: string; requestedRef: string; targetSha: string; previousSha: string | null; requestedByUserId: string;
}): Promise<DeploymentRecord> {
  const id = randomUUID();
  if (config.projectId !== projectId) throw new Error("Deployment configuration project mismatch");
  // The unique active-target key is acquired only on explicit confirmation.
  await db.insert(deploymentRecords).values({ ...input, id, projectId, environmentId: config.environmentId, serverId: config.serverId,
    configurationId: config.id, githubIntegrationId: config.githubIntegrationId, status: "awaiting_confirmation", activeTargetKey: null,
    configurationSnapshot: config, preflightedAt: new Date(), requestedAt: new Date() });
  return (await getDeploymentRecord(projectId, id))!;
}
export async function transitionDeploymentRecord(projectId: string, id: string, from: DeploymentStatus, to: DeploymentStatus, patch: {
  previousSha?: string | null; startedAt?: Date | null; completedAt?: Date | null; healthHttpStatus?: number | null;
  healthLatencyMs?: number | null; healthCheckedAt?: Date | null; healthResponse?: string | null; sanitizedError?: string | null;
} = {}): Promise<DeploymentRecord | null> {
  if (!transitions[from].includes(to)) throw new Error(`Invalid deployment transition ${from} -> ${to}`);
  const current = await getDeploymentRecord(projectId, id);
  if (!current || current.status !== from) return null;
  const result = await db.update(deploymentRecords).set({ status: to, ...patch,
    activeTargetKey: to === "queued" || to === "rollback_pending" ? `${projectId}:${current.environmentId}:${current.serverId}` : terminal.has(to) ? null : undefined,
  }).where(and(eq(deploymentRecords.projectId, projectId), eq(deploymentRecords.id, id), eq(deploymentRecords.status, from)));
  if (result[0].affectedRows !== 1) return null;
  return getDeploymentRecord(projectId, id);
}
export async function createDeploymentStep(projectId: string, deploymentId: string, sequence: number, stepType: DeploymentStepType): Promise<DeploymentStepRecord> {
  const id = randomUUID();
  await db.insert(deploymentStepRecords).values({ id, projectId, deploymentId, sequence, stepType, status: "pending" });
  return (await getDeploymentStep(projectId, id))!;
}
export async function getDeploymentStep(projectId: string, id: string): Promise<DeploymentStepRecord | null> {
  const [row] = await db.select().from(deploymentStepRecords).where(and(eq(deploymentStepRecords.projectId, projectId), eq(deploymentStepRecords.id, id))).limit(1);
  return row ? publicStep(row) : null;
}
export async function listDeploymentSteps(projectId: string, deploymentId: string): Promise<DeploymentStepRecord[]> {
  return (await db.select().from(deploymentStepRecords).where(and(eq(deploymentStepRecords.projectId, projectId), eq(deploymentStepRecords.deploymentId, deploymentId))).orderBy(deploymentStepRecords.sequence).limit(30)).map(publicStep);
}
export async function updateDeploymentStep(projectId: string, id: string, patch: {
  status?: DeploymentStepStatus; startedAt?: Date | null; completedAt?: Date | null; externalCommandId?: string | null;
  exitCode?: number | null; sanitizedOutput?: string | null; sanitizedError?: string | null;
}): Promise<DeploymentStepRecord | null> {
  if (!await getDeploymentStep(projectId, id)) return null;
  await db.update(deploymentStepRecords).set(patch).where(and(eq(deploymentStepRecords.projectId, projectId), eq(deploymentStepRecords.id, id)));
  return getDeploymentStep(projectId, id);
}
