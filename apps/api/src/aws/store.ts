import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { AwsAction, AwsCommandRecord, AwsCommandStatus, AwsServer, CreateAwsServerInput, UpdateAwsServerInput } from "@investaplay/devops-contracts";
import { db } from "../db/client";
import { awsCommandRecords, awsServers } from "../db/schema";

type ServerRow = typeof awsServers.$inferSelect;
type CommandRow = typeof awsCommandRecords.$inferSelect;

function publicServer(row: ServerRow): AwsServer {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function publicCommand(row: CommandRow): AwsCommandRecord {
  return { ...row, provider: "aws", exitCode: row.exitCode === null ? null : Number(row.exitCode),
    requestedAt: row.requestedAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null };
}

export async function listAwsServers(projectId: string): Promise<AwsServer[]> {
  return (await db.select().from(awsServers).where(eq(awsServers.projectId, projectId)).orderBy(desc(awsServers.createdAt)).limit(100)).map(publicServer);
}
export async function getAwsServer(projectId: string, id: string): Promise<AwsServer | null> {
  const [row] = await db.select().from(awsServers).where(and(eq(awsServers.projectId, projectId), eq(awsServers.id, id))).limit(1);
  return row ? publicServer(row) : null;
}
export async function createAwsServer(projectId: string, input: CreateAwsServerInput, region: string): Promise<AwsServer> {
  const id = randomUUID();
  await db.insert(awsServers).values({ id, projectId, environmentId: input.environmentId, integrationId: input.integrationId,
    displayName: input.displayName, role: input.role, region, instanceId: input.instanceId,
    managedInstanceId: input.managedInstanceId ?? input.instanceId, createdAt: new Date(), updatedAt: new Date() });
  return (await getAwsServer(projectId, id))!;
}
export async function updateAwsServer(projectId: string, id: string, input: UpdateAwsServerInput): Promise<AwsServer | null> {
  if (!await getAwsServer(projectId, id)) return null;
  await db.update(awsServers).set({ ...input, updatedAt: new Date() }).where(and(eq(awsServers.projectId, projectId), eq(awsServers.id, id)));
  return getAwsServer(projectId, id);
}

export async function createAwsCommandRecord(projectId: string, server: AwsServer, action: AwsAction, requestedByUserId: string): Promise<AwsCommandRecord> {
  const id = randomUUID();
  await db.insert(awsCommandRecords).values({ id, projectId, environmentId: server.environmentId, integrationId: server.integrationId,
    serverId: server.id, action, requestedByUserId, requestedAt: new Date() });
  return (await getAwsCommandRecord(projectId, id))!;
}
export async function getAwsCommandRecord(projectId: string, id: string): Promise<AwsCommandRecord | null> {
  const [row] = await db.select().from(awsCommandRecords).where(and(eq(awsCommandRecords.projectId, projectId), eq(awsCommandRecords.id, id))).limit(1);
  return row ? publicCommand(row) : null;
}
export async function listAwsCommandRecords(projectId: string, serverId: string): Promise<AwsCommandRecord[]> {
  return (await db.select().from(awsCommandRecords).where(and(eq(awsCommandRecords.projectId, projectId), eq(awsCommandRecords.serverId, serverId)))
    .orderBy(desc(awsCommandRecords.requestedAt)).limit(30)).map(publicCommand);
}
export async function updateAwsCommandRecord(projectId: string, id: string, input: {
  externalCommandId?: string; status?: AwsCommandStatus; providerStatus?: string; startedAt?: Date | null; completedAt?: Date | null;
  exitCode?: number | null; sanitizedOutput?: string | null; sanitizedError?: string | null;
}): Promise<AwsCommandRecord | null> {
  if (!await getAwsCommandRecord(projectId, id)) return null;
  await db.update(awsCommandRecords).set({ ...input, exitCode: input.exitCode === undefined ? undefined : input.exitCode === null ? null : String(input.exitCode) })
    .where(and(eq(awsCommandRecords.projectId, projectId), eq(awsCommandRecords.id, id)));
  return getAwsCommandRecord(projectId, id);
}
