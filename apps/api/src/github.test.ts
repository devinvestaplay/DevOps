import "dotenv/config";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import test from "node:test";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { app } from "./app";
import { createUser } from "./auth/store";
import { db, pool } from "./db/client";
import { environments, integrations, projects, secretReferences, sessions, users } from "./db/schema";
import { createAppJwt, GitHubClient, GitHubError } from "./github/client";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const publicKey = keys.publicKey;
const installationToken = "mock-installation-token-sensitive";
const locator = "GITHUB_APP_TEST_PRIVATE_KEY";
const config = { owner: "sample-org", repository: "sample-repo", defaultBranch: "main", repositoryType: "backend", appId: "12345", installationId: "67890" };

test("GitHub App JWT, scoped token and sanitized read client", async () => {
  const jwt = createAppJwt(config.appId, privateKey, Date.UTC(2026, 0, 1));
  const [header, payload, signature] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
  assert.equal(JSON.parse(Buffer.from(payload, "base64url").toString()).iss, config.appId);
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")), true);
  const calls: { path: string; auth: string; body?: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    calls.push({ path: url.pathname, auth, body: init?.body as string | undefined });
    if (url.pathname === "/app/installations/67890") return Response.json({ id: 67890, app_id: 12345, account: { login: "sample-org" }, suspended_at: null });
    if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: installationToken, expires_at: "2026-12-01T00:00:00Z" });
    if (url.pathname === "/repos/sample-org/sample-repo") return Response.json({ full_name: "sample-org/sample-repo", default_branch: "main", private: true, html_url: "https://github.com/sample-org/sample-repo", extra_secret: "should-not-return" });
    if (url.pathname.endsWith("/branches")) return Response.json([{ name: "main", commit: { sha: "abc123" } }]);
    if (url.pathname.endsWith("/branches/main")) return Response.json({ name: "main", commit: { sha: "a".repeat(40) } });
    if (url.pathname.endsWith("/commits")) return Response.json([{ sha: "abc123", commit: { message: "Change", author: { name: "Dev", date: "2026-01-01T00:00:00Z" } } }]);
    if (url.pathname.endsWith("/pulls")) return Response.json([{ number: 1, title: "Review", state: "open", head: { ref: "feature" }, base: { ref: "main" } }]);
    if (url.pathname.endsWith("/actions/runs")) return Response.json({ workflow_runs: [{ name: "CI", status: "completed", conclusion: "success", head_branch: "main", head_sha: "abc123", created_at: "2026-01-01T00:00:00Z" }] });
    throw new Error("Unexpected GitHub path");
  };
  const client = new GitHubClient(transport);
  assert.deepEqual(await client.testConnection(config, privateKey), { connected: true, repository: "sample-org/sample-repo", defaultBranch: "main" });
  assert.equal(await client.branchHead(config, privateKey, "main"), "a".repeat(40));
  await assert.rejects(client.branchHead(config, privateKey, "main; echo bad"), (error: unknown) => error instanceof GitHubError && error.code === "GITHUB_BRANCH_NOT_ALLOWED");
  for (const kind of ["repository", "branches", "commits", "pull-requests", "workflow-runs"] as const) {
    const result = await client.read(config, privateKey, kind, 1, 10);
    assert.ok(result);
    assert.ok(!JSON.stringify(result).includes("should-not-return"));
    assert.ok(!JSON.stringify(result).includes(installationToken));
  }
  assert.deepEqual(JSON.parse(calls.find((call) => call.path.endsWith("/access_tokens"))!.body!), {
    repositories: ["sample-repo"], permissions: { metadata: "read", contents: "read", pull_requests: "read", actions: "read" },
  });
  assert.ok(calls.filter((call) => call.path.startsWith("/repos/")).every((call) => call.auth === `Bearer ${installationToken}`));
  assert.ok(calls.filter((call) => call.path.startsWith("/app/")).every((call) => call.auth.startsWith("Bearer eyJ")));
  const failure = (status: number): typeof fetch => async () => new Response(`sensitive provider detail ${installationToken}`, { status });
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(new GitHubClient(failure(status)).testConnection(config, privateKey), (error: unknown) => error instanceof GitHubError && !error.message.includes(installationToken));
  }
  await assert.rejects(new GitHubClient(async () => Response.json({ id: 67890, app_id: 12345, account: { login: "another-org" }, suspended_at: null })).testConnection(config, privateKey), (error: unknown) => error instanceof GitHubError && error.code === "GITHUB_INSTALLATION_MISMATCH");
  await assert.rejects(new GitHubClient(async () => { throw new Error(`network ${installationToken}`); }).testConnection(config, privateKey), (error: unknown) => error instanceof GitHubError && !error.message.includes(installationToken));
  await assert.rejects(new GitHubClient(async () => { throw new DOMException("timeout", "TimeoutError"); }).testConnection(config, privateKey), (error: unknown) => error instanceof GitHubError && error.code === "GITHUB_TIMEOUT");
});

test("GitHub routes enforce project scope, RBAC and server-only key resolution", async () => {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalSecret = process.env[locator];
  const events: string[] = [];
  const userIds: string[] = [], projectIds: string[] = [];
  const password = `Test-Password-${randomUUID()}`;
  const suffix = randomUUID().slice(0, 8);
  let failureStatus = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.github.com");
    if (failureStatus) return new Response("provider credentials sensitive", { status: failureStatus });
    if (url.pathname === "/app/installations/67890") return Response.json({ id: 67890, app_id: 12345, account: { login: "sample-org" }, suspended_at: null });
    if (url.pathname.endsWith("/access_tokens")) return Response.json({ token: installationToken, expires_at: "2026-12-01T00:00:00Z" });
    if (url.pathname === "/repos/sample-org/sample-repo") return Response.json({ full_name: "sample-org/sample-repo", default_branch: "main", private: true, html_url: "https://github.com/sample-org/sample-repo" });
    if (url.pathname.endsWith("/branches")) return Response.json([{ name: "main", commit: { sha: "abc123" } }]);
    throw new Error("Unexpected GitHub path");
  };
  console.info = (...values: unknown[]) => { events.push(values.join(" ")); };
  process.env[locator] = privateKey;
  try {
    const admin = await createUser({ email: `gh-admin-${suffix}@example.test`, name: "Admin", password, role: "admin" });
    const dev = await createUser({ email: `gh-dev-${suffix}@example.test`, name: "Dev", password, role: "developer" });
    const manager = await createUser({ email: `gh-manager-${suffix}@example.test`, name: "Manager", password, role: "release_manager" });
    userIds.push(admin.id, dev.id, manager.id);
    const agents = [admin, dev, manager].map(() => request.agent(app));
    for (let n = 0; n < agents.length; n++) assert.equal((await agents[n].post("/api/auth/login").send({ email: [admin, dev, manager][n].email, password })).status, 200);
    const [owner, developer, release] = agents;
    const a = await owner.post("/api/projects").send({ name: "GitHub A", slug: `github-a-${suffix}` });
    const b = await owner.post("/api/projects").send({ name: "GitHub B", slug: `github-b-${suffix}` });
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    const aId = a.body.data.id as string, bId = b.body.data.id as string;
    projectIds.push(aId, bId);
    const ref = await owner.post(`/api/projects/${aId}/secret-references`).send({ provider: "github", purpose: "github_app_private_key", displayName: "App key", referenceType: "environment_variable", referenceKey: locator });
    assert.equal(ref.status, 201);
    const integration = await owner.post(`/api/projects/${aId}/integrations`).send({ provider: "github", displayName: "GitHub", configuration: config, secretReferenceId: ref.body.data.id });
    assert.equal(integration.status, 201);
    const id = integration.body.data.id as string;
    const route = `/api/projects/${aId}/github/repository?integrationId=${id}`;
    assert.equal((await request(app).get(route)).status, 401);
    assert.equal((await request(app).post(`/api/projects/${aId}/integrations/${id}/test`)).status, 401);
    for (const agent of [developer, release]) {
      assert.equal((await agent.get(route)).status, 200);
      assert.equal((await agent.post(`/api/projects/${aId}/integrations/${id}/test`)).status, 403);
      assert.equal((await agent.patch(`/api/projects/${aId}/integrations/${id}`).send({ displayName: "Denied" })).status, 403);
    }
    assert.equal((await owner.get(`/api/projects/${bId}/github/repository?integrationId=${id}`)).status, 404);
    assert.equal((await owner.post(`/api/projects/${bId}/integrations/${id}/test`)).status, 404);
    assert.equal((await owner.get(`/api/projects/${aId}/github/branches?integrationId=${id}&perPage=31`)).status, 400);
    const tested = await owner.post(`/api/projects/${aId}/integrations/${id}/test`);
    assert.equal(tested.status, 200); assert.equal(tested.body.data.connected, true);
    const read = await developer.get(`/api/projects/${aId}/github/branches?integrationId=${id}&perPage=10`);
    assert.equal(read.status, 200); assert.equal(read.body.data[0].name, "main");
    const verification = await owner.get(`/api/projects/${aId}/integrations/${id}`);
    assert.equal(verification.body.data.lastVerificationResult, "connected");
    assert.ok(verification.body.data.lastVerifiedAt);
    const stored = (await db.select().from(integrations).where(eq(integrations.id, id)))[0];
    assert.ok(!JSON.stringify(stored).includes(installationToken));
    assert.ok(!JSON.stringify(stored).includes(privateKey));
    failureStatus = 401;
    const failed = await owner.post(`/api/projects/${aId}/integrations/${id}/test`);
    assert.equal(failed.status, 502); assert.equal(failed.body.error.code, "GITHUB_AUTH_FAILED");
    const failedState = await owner.get(`/api/projects/${aId}/integrations/${id}`);
    assert.equal(failedState.body.data.lastVerificationResult, "error");
    assert.equal(failedState.body.data.lastVerificationReason, "GITHUB_AUTH_FAILED");
    const bodies = JSON.stringify([tested.body, read.body, verification.body, failed.body, failedState.body, ref.body]);
    for (const secret of [privateKey, installationToken, locator, "provider credentials sensitive", "passwordHash", "tokenHash"]) {
      assert.ok(!bodies.includes(secret), secret.slice(0, 30));
      assert.ok(!events.join("\n").includes(secret), secret.slice(0, 30));
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    if (originalSecret === undefined) delete process.env[locator]; else process.env[locator] = originalSecret;
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
