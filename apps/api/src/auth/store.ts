import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { CreateUserInput, UpdateUserInput, User } from "@investaplay/devops-contracts";
import { db } from "../db/client";
import { sessions, users } from "../db/schema";

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_ROUNDS = 12;
const dummyHash = bcrypt.hash("not-a-real-account-password", PASSWORD_ROUNDS);
type UserRow = typeof users.$inferSelect;

export class LastAdminError extends Error {}
export class PasswordError extends Error {}

export function publicUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validPasswordLength(password: string): boolean {
  return password.length >= 12 && !bcrypt.truncates(password);
}

export async function getUser(id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ? publicUser(row) : null;
}

export async function listUsers(): Promise<User[]> {
  return (await db.select().from(users).orderBy(asc(users.email))).map(publicUser);
}

export async function countUsers(): Promise<number> {
  return (await db.select({ id: users.id }).from(users)).length;
}

export async function createUser(input: CreateUserInput): Promise<User> {
  if (!validPasswordLength(input.password)) throw new PasswordError("Password must be 12 to 72 UTF-8 bytes");
  const id = randomUUID();
  const passwordHash = await bcrypt.hash(input.password, PASSWORD_ROUNDS);
  await db.insert(users).values({
    id, email: normalizeEmail(input.email), name: input.name,
    passwordHash, role: input.role,
  });
  return (await getUser(id))!;
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<User | null> {
  const changed = await db.transaction(async (tx) => {
    const [target] = await tx.select().from(users).where(eq(users.id, id)).for("update").limit(1);
    if (!target) return false;
    const removingActiveAdmin = target.role === "admin" && target.status === "active" &&
      (input.role !== undefined && input.role !== "admin" || input.status === "disabled");
    if (removingActiveAdmin) {
      const activeAdmins = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.role, "admin"), eq(users.status, "active"))).for("update");
      if (activeAdmins.length <= 1) throw new LastAdminError("The last active administrator cannot be removed");
    }
    await tx.update(users).set({ ...input, updatedAt: new Date() }).where(eq(users.id, id));
    if (input.status === "disabled" || input.role !== undefined) {
      await tx.delete(sessions).where(eq(sessions.userId, id));
    }
    return true;
  });
  return changed ? getUser(id) : null;
}

export async function verifyLogin(email: string, password: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
  const valid = await bcrypt.compare(password, row?.passwordHash ?? await dummyHash);
  return valid && row?.status === "active" && !bcrypt.truncates(password) ? row : null;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<{ token: string; maxAge: number }> {
  const token = randomBytes(32).toString("base64url");
  await db.delete(sessions).where(lte(sessions.expiresAt, new Date()));
  await db.insert(sessions).values({
    tokenHash: hashSessionToken(token), userId,
    expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  return { token, maxAge: SESSION_DURATION_MS };
}

export async function getSessionUser(token: string): Promise<User | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await db.select({ user: users }).from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(
      eq(sessions.tokenHash, hashSessionToken(token)),
      gt(sessions.expiresAt, new Date()),
      eq(users.status, "active"),
    )).limit(1);
  return row ? publicUser(row.user) : null;
}

export async function deleteSession(token: string): Promise<void> {
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
  }
}
