import { randomUUID } from "node:crypto";
import type { CreateEnvironmentInput, Environment, Project, UpdateEnvironmentInput, UpdateProjectInput } from "@investaplay/devops-contracts";
import { and, asc, eq } from "drizzle-orm";
import { db } from "./db/client";
import { environments, projects } from "./db/schema";

type ProjectRow = typeof projects.$inferSelect;
type EnvironmentRow = typeof environments.$inferSelect;

function toProject(row: ProjectRow): Project {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toEnvironment(row: EnvironmentRow): Environment {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export async function listProjects(): Promise<Project[]> {
  return (await db.select().from(projects).orderBy(asc(projects.name))).map(toProject);
}

export async function getProject(id: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row ? toProject(row) : null;
}

export async function createProject(input: { name: string; slug: string; description: string }): Promise<Project> {
  const id = randomUUID();
  await db.insert(projects).values({ id, ...input });
  return (await getProject(id))!;
}

export async function updateProject(id: string, input: UpdateProjectInput): Promise<Project | null> {
  const existing = await getProject(id);
  if (!existing) return null;
  await db.update(projects).set({ ...input, updatedAt: new Date() }).where(eq(projects.id, id));
  return getProject(id);
}

export async function archiveProject(id: string): Promise<Project | null> {
  return updateProject(id, { status: "archived" });
}

export async function listEnvironments(projectId: string): Promise<Environment[]> {
  return (await db.select().from(environments).where(eq(environments.projectId, projectId)).orderBy(asc(environments.name))).map(toEnvironment);
}

export async function getEnvironment(projectId: string, id: string): Promise<Environment | null> {
  const [row] = await db.select().from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.id, id))).limit(1);
  return row ? toEnvironment(row) : null;
}

export async function createEnvironment(projectId: string, input: CreateEnvironmentInput): Promise<Environment> {
  const id = randomUUID();
  await db.insert(environments).values({ id, projectId, ...input });
  return (await getEnvironment(projectId, id))!;
}

export async function updateEnvironment(projectId: string, id: string, input: UpdateEnvironmentInput): Promise<Environment | null> {
  const existing = await getEnvironment(projectId, id);
  if (!existing) return null;
  await db.update(environments).set({ ...input, updatedAt: new Date() })
    .where(and(eq(environments.projectId, projectId), eq(environments.id, id)));
  return getEnvironment(projectId, id);
}
