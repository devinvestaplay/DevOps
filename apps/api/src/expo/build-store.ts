import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { BuildRecord, ExpoBuildInfo } from "@investaplay/devops-contracts";
import { db } from "../db/client";
import { buildRecords } from "../db/schema";

type Row = typeof buildRecords.$inferSelect;
function publicRecord(row: Row): BuildRecord {
  return {
    ...row, provider: "expo", platform: "android", requestedAt: row.requestedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export async function createBuildRecord(projectId: string, integrationId: string, profile: string, requestedByUserId: string, environmentId: string | null, gitCommitSha: string | null, gitBranch: string | null): Promise<BuildRecord> {
  const id = randomUUID();
  await db.insert(buildRecords).values({ id, projectId, integrationId, environmentId, provider: "expo", platform: "android", profile, requestedByUserId, gitCommitSha, gitBranch, requestedAt: new Date() });
  return (await getBuildRecord(projectId, id))!;
}
export async function getBuildRecord(projectId: string, id: string): Promise<BuildRecord | null> {
  const [row] = await db.select().from(buildRecords).where(and(eq(buildRecords.projectId, projectId), eq(buildRecords.id, id))).limit(1);
  return row ? publicRecord(row) : null;
}
export async function listBuildRecords(projectId: string, integrationId: string): Promise<BuildRecord[]> {
  return (await db.select().from(buildRecords).where(and(eq(buildRecords.projectId, projectId), eq(buildRecords.integrationId, integrationId))).orderBy(desc(buildRecords.requestedAt)).limit(30)).map(publicRecord);
}
export async function findBuildRecordByExternalId(projectId: string, integrationId: string, externalBuildId: string): Promise<BuildRecord | null> {
  const [row] = await db.select().from(buildRecords).where(and(eq(buildRecords.projectId, projectId), eq(buildRecords.integrationId, integrationId), eq(buildRecords.externalBuildId, externalBuildId))).limit(1);
  return row ? publicRecord(row) : null;
}
export async function updateBuildRecord(projectId: string, id: string, update: Partial<typeof buildRecords.$inferInsert>): Promise<BuildRecord | null> {
  if (!await getBuildRecord(projectId, id)) return null;
  await db.update(buildRecords).set(update).where(and(eq(buildRecords.projectId, projectId), eq(buildRecords.id, id)));
  return getBuildRecord(projectId, id);
}
export async function syncBuildRecord(projectId: string, integrationId: string, build: ExpoBuildInfo): Promise<BuildRecord | null> {
  const record = await findBuildRecordByExternalId(projectId, integrationId, build.id);
  if (!record) return null;
  return updateBuildRecord(projectId, record.id, {
    status: build.status, providerStatus: build.providerStatus, appVersion: build.appVersion,
    appBuildVersion: build.appBuildVersion, gitCommitSha: build.gitCommitSha ?? record.gitCommitSha,
    startedAt: build.status === "in_progress" && !record.startedAt ? new Date() : record.startedAt ? new Date(record.startedAt) : null,
    completedAt: build.completedAt ? new Date(build.completedAt) : null,
    artifactAvailable: build.artifactAvailable, errorCode: build.errorCode,
  });
}
