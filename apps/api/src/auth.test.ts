import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { app } from "./app";
import { createUser } from "./auth/store";
import { db, pool } from "./db/client";
import { environments, projects, sessions, users } from "./db/schema";

test("authentication, role policy, disabled sessions, and password safety", async () => {
  const suffix = randomUUID().slice(0, 8);
  const password = `Test-Password-${randomUUID()}`;
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const events: string[] = [];
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => { events.push(values.join(" ")); };
  try {
    assert.equal((await request(app).get("/api/projects")).status, 401);
    assert.equal((await request(app).get("/api/auth/me")).status, 401);
    const admin = await createUser({ email: `ADMIN-${suffix}@example.test`, name: "Admin", password, role: "admin" });
    const developer = await createUser({ email: `dev-${suffix}@example.test`, name: "Developer", password, role: "developer" });
    const manager = await createUser({ email: `manager-${suffix}@example.test`, name: "Manager", password, role: "release_manager" });
    const disabled = await createUser({ email: `disabled-${suffix}@example.test`, name: "Disabled", password, role: "developer" });
    userIds.push(admin.id, developer.id, manager.id, disabled.id);
    const adminAgent = request.agent(app);
    const developerAgent = request.agent(app);
    const managerAgent = request.agent(app);
    const disabledAgent = request.agent(app);

    const wrong = await request(app).post("/api/auth/login").send({ email: admin.email, password: "wrong-password" });
    const unknown = await request(app).post("/api/auth/login").send({ email: `unknown-${suffix}@example.test`, password });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body);

    const adminLogin = await adminAgent.post("/api/auth/login").send({ email: admin.email.toUpperCase(), password });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.body.data.email, admin.email);
    assert.ok(!JSON.stringify(adminLogin.body).includes("passwordHash"));
    const cookie = adminLogin.headers["set-cookie"]?.[0] as string;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Max-Age=/i);
    assert.equal((await adminAgent.get("/api/auth/me")).body.data.role, "admin");

    assert.equal((await developerAgent.post("/api/auth/login").send({ email: developer.email, password })).status, 200);
    assert.equal((await managerAgent.post("/api/auth/login").send({ email: manager.email, password })).status, 200);
    assert.equal((await adminAgent.patch(`/api/users/${disabled.id}`).send({ status: "disabled" })).status, 200);
    const disabledLogin = await disabledAgent.post("/api/auth/login").send({ email: disabled.email, password });
    assert.equal(disabledLogin.status, 401);
    assert.deepEqual(disabledLogin.body, wrong.body);

    for (const agent of [developerAgent, managerAgent, adminAgent]) {
      assert.equal((await agent.get("/api/projects")).status, 200);
    }
    for (const agent of [developerAgent, managerAgent]) {
      assert.equal((await agent.post("/api/projects").send({ name: "Denied", slug: `denied-${suffix}` })).status, 403);
      assert.equal((await agent.get("/api/users")).status, 403);
    }
    const listedUsers = await adminAgent.get("/api/users");
    assert.equal(listedUsers.status, 200);
    assert.ok(!JSON.stringify(listedUsers.body).includes("passwordHash"));
    const project = await adminAgent.post("/api/projects").send({ name: "Role Test", slug: `role-test-${suffix}` });
    assert.equal(project.status, 201);
    projectIds.push(project.body.data.id);
    assert.equal((await developerAgent.get(`/api/projects/${project.body.data.id}`)).status, 200);
    for (const agent of [developerAgent, managerAgent]) {
      assert.equal((await agent.patch(`/api/projects/${project.body.data.id}`).send({ name: "Denied" })).status, 403);
      assert.equal((await agent.delete(`/api/projects/${project.body.data.id}`)).status, 403);
    }
    assert.equal((await developerAgent.post(`/api/projects/${project.body.data.id}/environments`).send({ name: "development", type: "development" })).status, 403);
    const environment = await adminAgent.post(`/api/projects/${project.body.data.id}/environments`).send({ name: "development", type: "development" });
    assert.equal(environment.status, 201);
    assert.equal((await developerAgent.get(`/api/projects/${project.body.data.id}/environments`)).status, 200);
    for (const agent of [developerAgent, managerAgent]) {
      assert.equal((await agent.patch(`/api/projects/${project.body.data.id}/environments/${environment.body.data.id}`).send({ status: "disabled" })).status, 403);
    }

    const newPassword = `New-Password-${randomUUID()}`;
    const created = await adminAgent.post("/api/users").send({ email: `new-${suffix}@example.test`, name: "New User", password: newPassword, role: "developer" });
    assert.equal(created.status, 201);
    userIds.push(created.body.data.id);
    assert.ok(!JSON.stringify(created.body).includes("passwordHash"));
    const [stored] = await db.select().from(users).where(eq(users.id, created.body.data.id));
    assert.notEqual(stored.passwordHash, newPassword);
    assert.match(stored.passwordHash, /^\$2[ab]\$/);
    assert.equal((await adminAgent.get(`/api/users/${created.body.data.id}`)).status, 200);
    assert.equal((await adminAgent.post("/api/users").send({ email: `NEW-${suffix}@example.test`, name: "Duplicate", password: newPassword, role: "developer" })).status, 409);
    assert.equal((await adminAgent.get("/api/users/not-a-uuid")).status, 400);
    assert.equal((await adminAgent.get(`/api/users/${randomUUID()}`)).status, 404);
    assert.equal((await adminAgent.patch(`/api/users/${created.body.data.id}`).send({ name: "Renamed", role: "release_manager" })).body.data.role, "release_manager");
    const activeAdmins = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), eq(users.status, "active")));
    if (activeAdmins.length === 1) {
      assert.equal((await adminAgent.patch(`/api/users/${admin.id}`).send({ status: "disabled" })).status, 409);
    }

    assert.equal((await adminAgent.patch(`/api/users/${developer.id}`).send({ status: "disabled" })).status, 200);
    assert.equal((await developerAgent.get("/api/projects")).status, 401);
    assert.equal((await managerAgent.post("/api/auth/logout")).status, 204);
    assert.equal((await managerAgent.get("/api/auth/me")).status, 401);
    assert.equal((await request(app).post("/api/projects").send({ name: "No Auth", slug: `no-auth-${suffix}` })).status, 401);
    assert.equal((await adminAgent.post("/api/projects").set("Origin", "http://evil.example").send({ name: "Origin", slug: `origin-${suffix}` })).status, 403);

    assert.ok(!events.join("\n").includes(password));
    assert.ok(!events.join("\n").includes(newPassword));
    assert.ok(!events.join("\n").includes(stored.passwordHash));
    assert.ok(!events.join("\n").includes(cookie.split(";")[0]));

    let limited = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await request(app).post("/api/auth/login").send({ email: `missing-${suffix}@example.test`, password });
      if (result.status === 429) { limited = true; break; }
    }
    assert.equal(limited, true);
  } finally {
    console.info = originalInfo;
    if (projectIds.length) {
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
