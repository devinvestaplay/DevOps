import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { app } from "./app";
import { db, pool } from "./db/client";
import { environments, projects, sessions, users } from "./db/schema";
import { createUser } from "./auth/store";

test("project and environment API isolates projects", async () => {
  const ids: string[] = [];
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const agent = request.agent(app);
  try {
    const password = `Test-Admin-${randomUUID()}`;
    const admin = await createUser({ email: `admin-${suffix}@example.test`, name: "Test Admin", password, role: "admin" });
    userIds.push(admin.id);
    assert.equal((await agent.post("/api/auth/login").send({ email: admin.email, password })).status, 200);
    const health = await agent.get("/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");

    const emptyOrExisting = await agent.get("/api/projects");
    assert.equal(emptyOrExisting.status, 200);
    assert.ok(Array.isArray(emptyOrExisting.body.data));

    const a = await agent.post("/api/projects").send({ name: "Test Project A", slug: `test-a-${suffix}`, description: "A" });
    assert.equal(a.status, 201);
    ids.push(a.body.data.id);
    const b = await agent.post("/api/projects").send({ name: "Test Project B", slug: `test-b-${suffix}`, description: "B" });
    assert.equal(b.status, 201);
    ids.push(b.body.data.id);

    const projectA = ids[0];
    const projectB = ids[1];
    assert.equal((await agent.get(`/api/projects/${projectA}`)).body.data.slug, `test-a-${suffix}`);
    assert.equal((await agent.patch(`/api/projects/${projectA}`).send({ description: "Updated A" })).body.data.description, "Updated A");
    assert.equal((await agent.post("/api/projects").send({ name: "Duplicate", slug: `test-a-${suffix}` })).status, 409);
    assert.equal((await agent.post("/api/projects").send({ name: "Invalid", slug: "bad slug", secret: "x" })).status, 400);

    const aEnvironments: string[] = [];
    for (const type of ["development", "staging", "production"] as const) {
      const result = await agent.post(`/api/projects/${projectA}/environments`).send({ name: type, type });
      assert.equal(result.status, 201);
      aEnvironments.push(result.body.data.id);
    }
    const bEnvironment = await agent.post(`/api/projects/${projectB}/environments`).send({ name: "development", type: "development" });
    assert.equal(bEnvironment.status, 201);
    assert.equal((await agent.get(`/api/projects/${projectA}/environments`)).body.data.length, 3);
    assert.equal((await agent.get(`/api/projects/${projectB}/environments`)).body.data.length, 1);
    assert.equal((await agent.get(`/api/projects/${projectA}/environments/${bEnvironment.body.data.id}`)).status, 404);
    assert.equal((await agent.patch(`/api/projects/${projectA}/environments/${bEnvironment.body.data.id}`).send({ status: "disabled" })).status, 404);
    assert.equal((await agent.get(`/api/projects/${projectB}/environments/${bEnvironment.body.data.id}`)).body.data.status, "active");
    assert.equal((await agent.patch(`/api/projects/${projectA}/environments/${aEnvironments[0]}`).send({ status: "disabled" })).body.data.status, "disabled");
    assert.equal((await agent.post(`/api/projects/${projectA}/environments`).send({ name: "development", type: "development" })).status, 409);

    assert.equal((await agent.get("/api/projects/not-a-uuid")).status, 400);
    assert.equal((await agent.get(`/api/projects/${randomUUID()}`)).status, 404);
    assert.equal((await agent.get(`/api/projects/${projectA}/environments/not-a-uuid`)).status, 400);
    assert.equal((await agent.get(`/api/projects/${projectA}/environments/${randomUUID()}`)).status, 404);

    const archived = await agent.delete(`/api/projects/${projectA}`);
    assert.equal(archived.body.data.status, "archived");
    assert.equal((await agent.get(`/api/projects/${projectA}`)).body.data.status, "archived");
    assert.equal((await agent.post(`/api/projects/${projectA}/environments`).send({ name: "blocked", type: "development" })).status, 409);
    assert.equal((await agent.patch(`/api/projects/${projectA}/environments/${aEnvironments[0]}`).send({ status: "active" })).status, 409);
    assert.equal((await agent.patch(`/api/projects/${projectA}`).send({ status: "active" })).body.data.status, "active");
  } finally {
    if (ids.length) {
      await db.delete(environments).where(inArray(environments.projectId, ids));
      await db.delete(projects).where(inArray(projects.id, ids));
    }
    if (userIds.length) {
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await pool.end();
  }
});
