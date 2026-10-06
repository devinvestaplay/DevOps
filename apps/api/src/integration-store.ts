import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Integration, IntegrationProvider, SecretReference } from "@investaplay/devops-contracts";
import { integrationConfigurationSchema } from "@investaplay/devops-contracts";
import { db } from "./db/client";
import { integrations, secretReferences } from "./db/schema";

type IntegrationRow = typeof integrations.$inferSelect;
type SecretReferenceRow = typeof secretReferences.$inferSelect;

function publicIntegration(row: IntegrationRow): Integration {
  const checked = integrationConfigurationSchema.safeParse({ provider: row.provider, configuration: row.configuration });
  return {
    id: row.id, projectId: row.projectId, environmentId: row.environmentId,
    provider: row.provider as IntegrationProvider, displayName: row.displayName,
    status: row.status, configuration: checked.success ? checked.data.configuration : null,
    secretReferenceId: row.secretReferenceId,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastVerificationResult: row.lastVerificationResult,
    lastVerificationReason: row.lastVerificationReason,
  };
}

function publicReference(row: SecretReferenceRow): SecretReference {
  return {
    id: row.id, projectId: row.projectId, environmentId: row.environmentId,
    provider: row.provider as IntegrationProvider, displayName: row.displayName,
    purpose: row.purpose, referenceType: row.referenceType as SecretReference["referenceType"],
    hasReferenceKey: true,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listIntegrations(projectId: string): Promise<Integration[]> {
  return (await db.select().from(integrations).where(eq(integrations.projectId, projectId)).orderBy(asc(integrations.displayName))).map(publicIntegration);
}
export async function getIntegration(projectId: string, id: string): Promise<Integration | null> {
  const [row] = await db.select().from(integrations).where(and(eq(integrations.projectId, projectId), eq(integrations.id, id))).limit(1);
  return row ? publicIntegration(row) : null;
}
export async function createIntegration(projectId: string, input: Omit<typeof integrations.$inferInsert, "id" | "projectId">): Promise<Integration> {
  const id = randomUUID();
  await db.insert(integrations).values({ id, projectId, ...input });
  return (await getIntegration(projectId, id))!;
}
export async function updateIntegration(projectId: string, id: string, input: Partial<Omit<IntegrationRow, "id" | "projectId" | "provider" | "createdAt" | "updatedAt">>): Promise<Integration | null> {
  if (!await getIntegration(projectId, id)) return null;
  await db.update(integrations).set({ ...input, updatedAt: new Date() }).where(and(eq(integrations.projectId, projectId), eq(integrations.id, id)));
  return getIntegration(projectId, id);
}
export async function listSecretReferences(projectId: string): Promise<SecretReference[]> {
  return (await db.select().from(secretReferences).where(eq(secretReferences.projectId, projectId)).orderBy(asc(secretReferences.displayName))).map(publicReference);
}
export async function getSecretReference(projectId: string, id: string): Promise<SecretReference | null> {
  const [row] = await db.select().from(secretReferences).where(and(eq(secretReferences.projectId, projectId), eq(secretReferences.id, id))).limit(1);
  return row ? publicReference(row) : null;
}
export async function createSecretReference(projectId: string, input: Omit<SecretReferenceRow, "id" | "projectId" | "createdAt" | "updatedAt">): Promise<SecretReference> {
  const id = randomUUID();
  await db.insert(secretReferences).values({ id, projectId, ...input });
  return (await getSecretReference(projectId, id))!;
}
export async function updateSecretReference(projectId: string, id: string, input: Partial<Pick<SecretReferenceRow, "displayName" | "purpose" | "referenceType" | "referenceKey">>): Promise<SecretReference | null> {
  if (!await getSecretReference(projectId, id)) return null;
  await db.update(secretReferences).set({ ...input, updatedAt: new Date() }).where(and(eq(secretReferences.projectId, projectId), eq(secretReferences.id, id)));
  return getSecretReference(projectId, id);
}
