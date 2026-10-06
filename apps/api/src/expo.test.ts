import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { app } from "./app";
import { createUser } from "./auth/store";
import { db, pool } from "./db/client";
import { buildRecords, environments, integrations, projects, secretReferences, sessions, users } from "./db/schema";
import { ExpoClient, normalizeBuildStatus } from "./expo/client";
import { runEas } from "./expo/cli-runner";
import { ExpoError } from "./expo/errors";

const expoProjectId = "bbd6fe46-f6e1-4a2e-9cee-2b49e7cdb888";
const firstBuildId = "0aeb49e3-f14b-4da6-bb95-3f0808b90c50";
const secondBuildId = "3ea3d741-ccaa-4eaf-9a35-d62fe78c9cf0";
const tokenSentinel = "mock-expo-token-sensitive";
const config = { expoAccount: "example-team", projectSlug: "mobile-app", projectId: expoProjectId, workingDirectory: "source", previewProfile: "preview", productionProfile: "production", androidEnabled: true };

test("Expo read, preview-only build, RBAC, isolation and secret safety", async () => {
  const root = await mkdtemp(join(tmpdir(), "devops-expo-test-"));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "app.json"), JSON.stringify({ expo: { owner: config.expoAccount, slug: config.projectSlug, extra: { eas: { projectId: expoProjectId } } } }));
  await writeFile(join(source, "eas.json"), '{ // EAS accepts JSON5 comments and trailing commas\n build: { preview: { distribution: "internal", android: { buildType: "apk", }, }, production: {}, },\n}');
  execFileSync("git", ["init", source], { stdio: "ignore" });
  execFileSync("git", ["-C", source, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture"], { stdio: "ignore" });
  const fakeCli = join(root, "fake-eas.cjs");
  const countFile = join(root, "count.txt");
  const argsFile = join(root, "args.json");
  const scenarioFile = join(root, "scenario.txt");
  await writeFile(fakeCli, `const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.EXPO_TOKEN !== ${JSON.stringify(tokenSentinel)} || process.env.DATABASE_URL) { process.stderr.write('invalid token sensitive-data'); process.exit(1); }
const scenario = fs.existsSync(${JSON.stringify(scenarioFile)}) ? fs.readFileSync(${JSON.stringify(scenarioFile)}, 'utf8') : '';
if (scenario === 'auth') { process.stderr.write('invalid token sensitive-data'); process.exit(1); }
const projectId = ${JSON.stringify(expoProjectId)};
const ids = [${JSON.stringify(firstBuildId)}, ${JSON.stringify(secondBuildId)}];
const makeBuild = (id, status = 'FINISHED') => ({ id, app: { id: scenario === 'wrong-build' ? 'c32c61be-90c0-4e03-8075-f4b7eb97e520' : projectId }, platform: 'ANDROID', status, buildProfile: 'preview', appVersion: '1.2.3', appBuildVersion: '7', gitCommitHash: 'abcdef1', createdAt: '2026-09-24T00:00:00Z', completedAt: status === 'FINISHED' ? '2026-09-24T00:05:00Z' : null, artifacts: { applicationArchiveUrl: status === 'FINISHED' ? 'https://example.test/build.apk' : null }, error: null });
if (args[0] === 'config') {
  console.log(JSON.stringify({ appConfig: { owner: 'example-team', slug: 'mobile-app', extra: { eas: { projectId: scenario === 'wrong-project' ? 'c32c61be-90c0-4e03-8075-f4b7eb97e520' : projectId } }, hiddenToken: process.env.EXPO_TOKEN }, buildProfile: { distribution: 'internal', buildType: 'apk' } }));
} else if (args[0] === 'build:list') {
  console.log(JSON.stringify([makeBuild(ids[0])]));
} else if (args[0] === 'build:view') {
  console.log(JSON.stringify(makeBuild(args[1])));
} else if (args[0] === 'build') {
  fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
  const count = fs.existsSync(${JSON.stringify(countFile)}) ? Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(countFile)}, String(count + 1));
  console.log(JSON.stringify([makeBuild(ids[count] || ids[1], 'FINISHED')]));
} else { process.stderr.write('unexpected command'); process.exit(1); }
`);
  const oldRoot = process.env.EXPO_PROJECTS_ROOT, oldCli = process.env.EAS_CLI_ENTRYPOINT, oldToken = process.env.EXPO_TEST_TOKEN;
  process.env.EXPO_PROJECTS_ROOT = root;
  process.env.EAS_CLI_ENTRYPOINT = fakeCli;
  process.env.EXPO_TEST_TOKEN = tokenSentinel;
  const userIds: string[] = [], projectIds: string[] = [];
  const password = `Test-Password-${randomUUID()}`;
  const suffix = randomUUID().slice(0, 8);
  const events: string[] = [];
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => { events.push(values.join(" ")); };
  try {
    assert.equal(normalizeBuildStatus("IN_QUEUE"), "queued");
    assert.equal(normalizeBuildStatus("IN_PROGRESS"), "in_progress");
    assert.equal(normalizeBuildStatus("FINISHED"), "succeeded");
    assert.equal(normalizeBuildStatus("ERRORED"), "failed");
    assert.equal(normalizeBuildStatus("CANCELED"), "canceled");
    const admin = await createUser({ email: `expo-admin-${suffix}@example.test`, name: "Admin", password, role: "admin" });
    const dev = await createUser({ email: `expo-dev-${suffix}@example.test`, name: "Dev", password, role: "developer" });
    const manager = await createUser({ email: `expo-manager-${suffix}@example.test`, name: "Manager", password, role: "release_manager" });
    userIds.push(admin.id, dev.id, manager.id);
    const agents = [admin, dev, manager].map(() => request.agent(app));
    for (let n = 0; n < agents.length; n++) assert.equal((await agents[n].post("/api/auth/login").send({ email: [admin, dev, manager][n].email, password })).status, 200);
    const [owner, developer, release] = agents;
    const a = await owner.post("/api/projects").send({ name: "Expo A", slug: `expo-a-${suffix}` });
    const b = await owner.post("/api/projects").send({ name: "Expo B", slug: `expo-b-${suffix}` });
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    const aId = a.body.data.id as string, bId = b.body.data.id as string;
    projectIds.push(aId, bId);
    const ref = await owner.post(`/api/projects/${aId}/secret-references`).send({ provider: "expo", purpose: "expo_access_token", displayName: "Expo token locator", referenceType: "environment_variable", referenceKey: "EXPO_TEST_TOKEN" });
    assert.equal(ref.status, 201);
    const integration = await owner.post(`/api/projects/${aId}/integrations`).send({ provider: "expo", displayName: "Mobile", configuration: config, secretReferenceId: ref.body.data.id });
    assert.equal(integration.status, 201);
    const id = integration.body.data.id as string;
    const base = `/api/projects/${aId}/expo`;
    assert.equal((await request(app).get(`${base}/project?integrationId=${id}`)).status, 401);
    assert.equal((await request(app).post(`${base}/builds/preview`).send({ integrationId: id })).status, 401);
    for (const agent of [developer, release]) {
      assert.equal((await agent.get(`${base}/project?integrationId=${id}`)).status, 200);
      assert.equal((await agent.get(`${base}/builds?integrationId=${id}`)).status, 200);
      assert.equal((await agent.patch(`/api/projects/${aId}/integrations/${id}`).send({ displayName: "Denied" })).status, 403);
      assert.equal((await agent.post(`/api/projects/${aId}/integrations/${id}/test`)).status, 403);
    }
    assert.equal((await developer.post(`${base}/builds/preview`).send({ integrationId: id })).status, 403);
    assert.equal((await owner.get(`/api/projects/${bId}/expo/project?integrationId=${id}`)).status, 404);
    assert.equal((await owner.get(`/api/projects/${bId}/expo/builds?integrationId=${id}`)).status, 404);
    assert.equal((await owner.get(`/api/projects/${bId}/expo/builds/${firstBuildId}?integrationId=${id}`)).status, 404);
    assert.equal((await owner.get(`${base}/builds/${firstBuildId}?integrationId=${id}`)).status, 200);
    assert.equal((await owner.post(`/api/projects/${aId}/integrations`).send({ provider: "expo", displayName: "Rejected", configuration: { ...config, accessToken: tokenSentinel } })).status, 400);
    const tested = await owner.post(`/api/projects/${aId}/integrations/${id}/test`);
    assert.equal(tested.status, 200); assert.equal(tested.body.data.projectId, expoProjectId);
    for (const injected of [{ integrationId: id, profile: "production" }, { integrationId: id, flags: ["--profile", "production"] }, { integrationId: id, workingDirectory: "../outside" }]) {
      assert.equal((await release.post(`${base}/builds/preview`).send(injected)).status, 400);
    }
    assert.equal((await owner.post(`${base}/builds/production`).send({ integrationId: id })).status, 404);
    const first = await release.post(`${base}/builds/preview`).send({ integrationId: id });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.profile, "preview"); assert.equal(first.body.data.platform, "android");
    assert.ok(Math.abs(Date.now() - Date.parse(first.body.data.requestedAt)) < 60_000);
    assert.equal(first.body.data.externalBuildId, firstBuildId);
    const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    assert.deepEqual(args, ["build", "--platform", "android", "--profile", "preview", "--non-interactive", "--json", "--no-wait", "--freeze-credentials"]);
    const second = await owner.post(`${base}/builds/preview`).send({ integrationId: id });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.data.externalBuildId, secondBuildId);
    const builds = await developer.get(`${base}/builds?integrationId=${id}&limit=10&offset=0`);
    assert.equal(builds.status, 200);
    assert.equal(builds.body.data.builds[0].artifactAvailable, true);
    assert.equal(builds.body.data.records.length, 2);
    const [stored] = await db.select().from(buildRecords).where(eq(buildRecords.id, first.body.data.id));
    assert.ok(!JSON.stringify(stored).includes(tokenSentinel));
    const unsafeConfig = { ...config, previewProfile: "production" };
    assert.equal((await owner.patch(`/api/projects/${aId}/integrations/${id}`).send({ configuration: unsafeConfig })).status, 200);
    const blockedProduction = await release.post(`${base}/builds/preview`).send({ integrationId: id });
    assert.equal(blockedProduction.status, 409);
    assert.equal(blockedProduction.body.error.code, "EXPO_PRODUCTION_GUARD");
    assert.equal((await owner.patch(`/api/projects/${aId}/integrations/${id}`).send({ configuration: config })).status, 200);
    await writeFile(scenarioFile, "wrong-build");
    assert.equal((await owner.get(`${base}/builds/${firstBuildId}?integrationId=${id}`)).body.error.code, "EXPO_PROJECT_MISMATCH");
    await writeFile(scenarioFile, "wrong-project");
    assert.equal((await owner.post(`/api/projects/${aId}/integrations/${id}/test`)).body.error.code, "EXPO_PROJECT_MISMATCH");
    await writeFile(scenarioFile, "auth");
    const failed = await owner.post(`/api/projects/${aId}/integrations/${id}/test`);
    assert.equal(failed.status, 502); assert.equal(failed.body.error.code, "EXPO_AUTH_FAILED");
    const bodies = JSON.stringify([ref.body, integration.body, tested.body, first.body, second.body, builds.body, failed.body]);
    for (const secret of [tokenSentinel, "EXPO_TEST_TOKEN", "invalid token sensitive-data", "passwordHash", "tokenHash"]) {
      assert.ok(!bodies.includes(secret), secret);
      assert.ok(!events.join("\n").includes(secret), secret);
    }
  } finally {
    console.info = originalInfo;
    if (oldRoot === undefined) delete process.env.EXPO_PROJECTS_ROOT; else process.env.EXPO_PROJECTS_ROOT = oldRoot;
    if (oldCli === undefined) delete process.env.EAS_CLI_ENTRYPOINT; else process.env.EAS_CLI_ENTRYPOINT = oldCli;
    if (oldToken === undefined) delete process.env.EXPO_TEST_TOKEN; else process.env.EXPO_TEST_TOKEN = oldToken;
    if (projectIds.length) {
      await db.delete(buildRecords).where(inArray(buildRecords.projectId, projectIds));
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
    const resolvedRoot = await realpath(root);
    if (dirname(resolvedRoot).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(resolvedRoot).startsWith("devops-expo-test-")) throw new Error("Temporary test path failed safety check");
    await rm(resolvedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Expo failure and terminal-state mapping stays sanitized", async () => {
  const make = (id: string, status: string, artifact: string | null) => ({
    id, app: { id: expoProjectId }, platform: "ANDROID", status, buildProfile: "preview",
    createdAt: "2026-09-24T00:00:00Z", completedAt: status === "IN_PROGRESS" ? null : "2026-09-24T00:05:00Z",
    artifacts: { applicationArchiveUrl: artifact }, error: status === "ERRORED" ? { errorCode: "BUILD_FAILED", message: tokenSentinel } : null,
  });
  const client = new ExpoClient(async () => JSON.stringify([
    make(firstBuildId, "ERRORED", null), make(secondBuildId, "CANCELED", null), make(randomUUID(), "FINISHED", null),
  ]));
  const builds = await client.listBuilds(config, tokenSentinel, tmpdir(), 3, 0);
  assert.deepEqual(builds.map((build) => build.status), ["failed", "canceled", "succeeded"]);
  assert.equal(builds[2].artifactAvailable, false);
  assert.equal(builds[0].errorCode, "BUILD_FAILED");
  assert.ok(!JSON.stringify(builds).includes(tokenSentinel));
  const root = await mkdtemp(join(tmpdir(), "devops-expo-runner-test-"));
  const script = join(root, "fake.cjs");
  const oldCli = process.env.EAS_CLI_ENTRYPOINT;
  process.env.EAS_CLI_ENTRYPOINT = script;
  try {
    await writeFile(script, "process.stderr.write('rate limit provider-secret'); process.exit(1)");
    await assert.rejects(runEas(["build:list"], root, tokenSentinel, 1000), (error: unknown) => error instanceof ExpoError && error.code === "EXPO_RATE_LIMITED" && !error.message.includes("provider-secret"));
    await writeFile(script, "setTimeout(() => {}, 1000)");
    await assert.rejects(runEas(["build:list"], root, tokenSentinel, 50), (error: unknown) => error instanceof ExpoError && error.code === "EXPO_TIMEOUT");
  } finally {
    if (oldCli === undefined) delete process.env.EAS_CLI_ENTRYPOINT; else process.env.EAS_CLI_ENTRYPOINT = oldCli;
    const resolvedRoot = await realpath(root);
    if (dirname(resolvedRoot).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(resolvedRoot).startsWith("devops-expo-runner-test-")) throw new Error("Temporary runner path failed safety check");
    await rm(resolvedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
