import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { secretReferences } from "../db/schema";
import { GitHubError } from "./client";

// This is intentionally not exposed through HTTP. Only the GitHub App path can use it.
export async function resolveGitHubAppKey(projectId: string, referenceId: string): Promise<string> {
  const [reference] = await db.select().from(secretReferences).where(and(
    eq(secretReferences.id, referenceId), eq(secretReferences.projectId, projectId),
    eq(secretReferences.provider, "github"), eq(secretReferences.purpose, "github_app_private_key"),
    eq(secretReferences.referenceType, "environment_variable"), isNull(secretReferences.environmentId),
  )).limit(1);
  if (!reference || !/^GITHUB_APP_[A-Z0-9_]*PRIVATE_KEY$/.test(reference.referenceKey)) {
    throw new GitHubError("GITHUB_KEY_NOT_CONFIGURED", 409, "GitHub App private key reference is not configured");
  }
  const value = process.env[reference.referenceKey];
  if (!value) throw new GitHubError("GITHUB_KEY_UNAVAILABLE", 503, "GitHub App private key is unavailable on the server");
  return value.replace(/\\n/g, "\n");
}
