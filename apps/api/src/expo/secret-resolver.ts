import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { secretReferences } from "../db/schema";
import { ExpoError } from "./errors";

// The only Expo secret resolved in this milestone. No HTTP secret-reading route exists.
export async function resolveExpoToken(projectId: string, referenceId: string): Promise<string> {
  const [reference] = await db.select().from(secretReferences).where(and(
    eq(secretReferences.id, referenceId), eq(secretReferences.projectId, projectId),
    eq(secretReferences.provider, "expo"), eq(secretReferences.purpose, "expo_access_token"),
    eq(secretReferences.referenceType, "environment_variable"), isNull(secretReferences.environmentId),
  )).limit(1);
  if (!reference || !/^EXPO_[A-Z0-9_]*TOKEN$/.test(reference.referenceKey)) {
    throw new ExpoError("EXPO_TOKEN_NOT_CONFIGURED", 409, "Expo token reference is not configured");
  }
  const token = process.env[reference.referenceKey];
  if (!token) throw new ExpoError("EXPO_TOKEN_UNAVAILABLE", 503, "Expo token is unavailable on the server");
  return token;
}
