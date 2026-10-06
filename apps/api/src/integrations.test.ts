import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { app } from "./app";
import { createUser } from "./auth/store";
import { db, pool } from "./db/client";
import { environments, integrations, projects, secretReferences, sessions, users } from "./db/schema";

test("integration framework: RBAC, ownership, configuration rejection and no secret leakage", async () => {
  const suffix = randomUUID().slice(0, 8);
  const password = `Test-Password-${randomUUID()}`;
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const events: string[] = [];
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => { events.push(values.join(" ")); };
  try {
    const admin = await createUser({ email: `int-admin-${suffix}@example.test`, name: "Admin", password, role: "admin" });
    const developer = await createUser({ email: `int-dev-${suffix}@example.test`, name: "Developer", password, role: "developer" });
    const manager = await createUser({ email: `int-manager-${suffix}@example.test`, name: "Manager", password, role: "release_manager" });
    userIds.push(admin.id, developer.id, manager.id);
    const agents = [admin, developer, manager].map(() => request.agent(app));
    for (let n = 0; n < agents.length; n++) assert.equal((await agents[n].post("/api/auth/login").send({ email: [admin, developer, manager][n].email, password })).status, 200);
    const [owner, dev, release] = agents;
    const a = await owner.post("/api/projects").send({ name: "Integration A", slug: `integration-a-${suffix}` });
    const b = await owner.post("/api/projects").send({ name: "Integration B", slug: `integration-b-${suffix}` });
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    const aId = a.body.data.id as string, bId = b.body.data.id as string;
    projectIds.push(aId, bId);
    const envA = await owner.post(`/api/projects/${aId}/environments`).send({ name: "Development", type: "development" });
    const envB = await owner.post(`/api/projects/${bId}/environments`).send({ name: "Development", type: "development" });
    assert.equal(envA.status, 201); assert.equal(envB.status, 201);
    const aIntegrations = `/api/projects/${aId}/integrations`;
    const aReferences = `/api/projects/${aId}/secret-references`;
    const config = { owner: "example", repository: "service", defaultBranch: "main", repositoryType: "backend" };
    const payload = { provider: "github", displayName: "Repository", environmentId: envA.body.data.id, configuration: config };
    assert.equal((await request(app).get(aIntegrations)).status, 401);
    assert.equal((await request(app).get(aReferences)).status, 401);
    for (const agent of [dev, release]) {
      assert.equal((await agent.get(aIntegrations)).status, 200);
      assert.equal((await agent.post(aIntegrations).send(payload)).status, 403);
      assert.equal((await agent.get(aReferences)).status, 403);
      assert.equal((await agent.post(aReferences).send({})).status, 403);
    }
    assert.equal((await owner.post(aIntegrations).send({ ...payload, environmentId: envB.body.data.id })).status, 400);
    const referencePayload = { provider: "github", displayName: "GitHub App locator", purpose: "repository", environmentId: envA.body.data.id, referenceType: "environment_variable", referenceKey: "GITHUB_APP_KEY" };
    assert.equal((await owner.post(aReferences).send({ ...referencePayload, environmentId: envB.body.data.id })).status, 400);
    const reference = await owner.post(aReferences).send(referencePayload);
    assert.equal(reference.status, 201);
    const refId = reference.body.data.id as string;
    assert.equal((await owner.get(aReferences)).status, 200);
    assert.equal((await owner.get(`${aReferences}/${refId}`)).status, 200);
    assert.equal((await owner.patch(`${aReferences}/${refId}`).send({ purpose: "source control" })).status, 200);
    assert.equal((await owner.get(`/api/projects/${bId}/secret-references/${refId}`)).status, 404);
    assert.equal((await owner.patch(`/api/projects/${bId}/secret-references/${refId}`).send({ purpose: "wrong" })).status, 404);
    assert.equal((await owner.post(`/api/projects/${bId}/integrations`).send({ ...payload, environmentId: envB.body.data.id, secretReferenceId: refId })).status, 400);
    const created = await owner.post(aIntegrations).send({ ...payload, secretReferenceId: refId });
    assert.equal(created.status, 201);
    const id = created.body.data.id as string;
    assert.equal(created.body.data.status, "configured");
    assert.equal((await owner.get(`${aIntegrations}/${id}`)).status, 200);
    assert.equal((await owner.patch(`${aIntegrations}/${id}`).send({ displayName: "Updated" })).status, 200);
    assert.equal((await owner.patch(`${aIntegrations}/${id}`).send({ environmentId: envB.body.data.id })).status, 400);
    assert.equal((await owner.get(`/api/projects/${bId}/integrations/${id}`)).status, 404);
    assert.equal((await owner.patch(`/api/projects/${bId}/integrations/${id}`).send({ displayName: "Wrong" })).status, 404);
    const expo = await owner.post(aIntegrations).send({ provider: "expo", displayName: "Mobile", configuration: {
      expoAccount: "team", projectSlug: "mobile", projectId: randomUUID(), workingDirectory: "apps/mobile", previewProfile: "preview", productionProfile: "production",
    } });
    assert.equal(expo.status, 201);
    const aws = await owner.post(aIntegrations).send({ provider: "aws", displayName: "Infrastructure", configuration: {
      region: "us-east-1", accountId: "123456789012", controlStrategy: "ssm",
    } });
    assert.equal(aws.status, 201);
    assert.equal((await owner.patch(`${aIntegrations}/${aws.body.data.id}`).send({ configuration: { ...aws.body.data.configuration, sessionToken: "sentinel-secret-value" } })).status, 400);
    for (const key of ["token", "accessToken", "password", "privateKey", "clientSecret", "awsSecretAccessKey", "ToKeN"]) {
      assert.equal((await owner.post(aIntegrations).send({ ...payload, configuration: { ...config, [key]: "sentinel-secret-value" } })).status, 400, key);
    }
    assert.equal((await owner.post(aIntegrations).send({ ...payload, configuration: { ...config, nested: { SeCrEt: "sentinel-secret-value" } } })).status, 400);
    assert.equal((await owner.patch(`${aIntegrations}/${id}`).send({ configuration: { ...config, nested: [{ refreshToken: "sentinel-secret-value" }] } })).status, 400);
    assert.equal((await owner.post(aReferences).send({ ...referencePayload, referenceKey: "sentinel-secret-value" })).status, 400);
    const list = await dev.get(aIntegrations);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 3);
    const disabled = await owner.delete(`${aIntegrations}/${id}`);
    assert.equal(disabled.status, 200); assert.equal(disabled.body.data.status, "disabled");
    assert.equal((await owner.get(`${aIntegrations}/${id}`)).status, 200);
    const allBodies = JSON.stringify([reference.body, created.body, list.body, disabled.body, (await owner.get(aReferences)).body]);
    for (const forbidden of ["referenceKey", "GITHUB_APP_KEY", "sentinel-secret-value", "passwordHash", "tokenHash", password]) assert.ok(!allBodies.includes(forbidden), forbidden);
    assert.ok(!events.join("\n").includes("GITHUB_APP_KEY"));
    assert.ok(!events.join("\n").includes("sentinel-secret-value"));
  } finally {
    console.info = originalInfo;
    if (projectIds.length) {
      await db.delete(integrations).where(inArray(integrations.projectId, projectIds));
      await db.delete(secretReferences).where(inArray(secretReferences.projectId, projectIds));
      await db.delete(environments).where(inArray(environments.projectId, projectIds));
      await db.delete(projects).where(inArray(projects.id, projectIds));
    }
    if (userIds.length) {
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await pool.end();
  }
});
