import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { app, setAwsProviderForTests } from "./app";
import { createUser } from "./auth/store";
import { AwsError, mappedError, normalizeSsmStatus, sanitizeCommandOutput, type AwsProvider } from "./aws/client";
import { db, pool } from "./db/client";
import { awsCommandRecords, awsServers, environments, integrations, projects, sessions, users } from "./db/schema";

test("AWS mappings, diagnostic allowlist, RBAC, isolation and sanitized results", async () => {
  const suffix = randomUUID().slice(0, 8), password = `Test-Password-${randomUUID()}`;
  const projectIds: string[] = [], userIds: string[] = [];
  const events: string[] = [];
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => { events.push(values.join(" ")); };
  let sends = 0, nextStatus: "in_progress" | "succeeded" = "in_progress", instanceState = "running", ping = "Online", failIdentity = false, managed = true, failSend = false;
  const commandId = randomUUID();
  const fake: AwsProvider = {
    async testConnection(config, target) {
      if (failIdentity) throw new AwsError("AWS_AUTH_FAILED", 502, "AWS authentication failed");
      return { connected: true, provider: "aws", accountId: config.accountId, region: config.region,
        instanceId: target?.instanceId ?? null, ssmManaged: target ? true : null, ssmOnline: target ? ping === "Online" : null };
    },
    async describeInstance(_config, instanceId) { return { id: instanceId, state: instanceState, instanceType: "t3.small", availabilityZone: "us-east-1a", privateIp: "10.0.0.1", publicIp: null, launchTime: "2026-09-24T00:00:00Z" }; },
    async describeSsmTarget() { return { managed, pingStatus: managed ? ping : null, platform: managed ? "Linux" : null, agentVersion: "3.0", lastPingAt: "2026-09-24T00:00:00Z" }; },
    async sendDiagnostic(_config, _target, action) { assert.equal(action, "server_identity"); if (failSend) throw new AwsError("AWS_ACCESS_DENIED", 502, "AWS access denied"); sends++; return { commandId: sends === 1 ? commandId : randomUUID(), status: "queued", providerStatus: "Pending" }; },
    async getCommand() { return { status: nextStatus, providerStatus: nextStatus === "succeeded" ? "Success" : "InProgress", exitCode: nextStatus === "succeeded" ? 0 : null,
      output: "hostname\npassword=SHOULD_NOT_APPEAR", error: null }; },
  };
  setAwsProviderForTests(fake);
  try {
    assert.equal(normalizeSsmStatus("TimedOut"), "timed_out");
    assert.equal(normalizeSsmStatus("Success"), "succeeded");
    assert.equal(normalizeSsmStatus("Failed"), "failed");
    assert.equal(mappedError({ name: "ExpiredTokenException" }).code, "AWS_AUTH_FAILED");
    assert.equal(mappedError({ name: "AccessDeniedException" }).code, "AWS_ACCESS_DENIED");
    assert.equal(mappedError({ name: "ThrottlingException" }).code, "AWS_RATE_LIMITED");
    assert.equal(mappedError({ name: "TimeoutError" }).code, "AWS_UNAVAILABLE");
    assert.equal(mappedError({ name: "InvalidInstanceID.NotFound" }).code, "AWS_RESOURCE_NOT_FOUND");
    assert.ok(!sanitizeCommandOutput("token=SHOULD_NOT_APPEAR")!.includes("SHOULD_NOT_APPEAR"));
    assert.equal(sanitizeCommandOutput("a".repeat(6000))?.length, 4096);
    const admin = await createUser({ email: `aws-admin-${suffix}@example.test`, name: "Admin", password, role: "admin" });
    const developer = await createUser({ email: `aws-dev-${suffix}@example.test`, name: "Dev", password, role: "developer" });
    const manager = await createUser({ email: `aws-release-${suffix}@example.test`, name: "Release", password, role: "release_manager" });
    userIds.push(admin.id, developer.id, manager.id);
    const agents = [admin, developer, manager].map(() => request.agent(app));
    for (let i = 0; i < agents.length; i++) assert.equal((await agents[i].post("/api/auth/login").send({ email: [admin, developer, manager][i].email, password })).status, 200);
    const [owner, dev, release] = agents;
    const a = await owner.post("/api/projects").send({ name: "AWS A", slug: `aws-a-${suffix}` });
    const b = await owner.post("/api/projects").send({ name: "AWS B", slug: `aws-b-${suffix}` });
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    const aId = a.body.data.id as string, bId = b.body.data.id as string;
    projectIds.push(aId, bId);
    const envA = await owner.post(`/api/projects/${aId}/environments`).send({ name: "staging", type: "staging" });
    const envB = await owner.post(`/api/projects/${bId}/environments`).send({ name: "staging", type: "staging" });
    assert.equal(envA.status, 201); assert.equal(envB.status, 201);
    const config = { region: "us-east-1", accountId: "123456789012", controlStrategy: "ssm" };
    const intA = await owner.post(`/api/projects/${aId}/integrations`).send({ provider: "aws", displayName: "AWS", environmentId: envA.body.data.id, configuration: config });
    const intB = await owner.post(`/api/projects/${bId}/integrations`).send({ provider: "aws", displayName: "AWS", environmentId: envB.body.data.id, configuration: config });
    assert.equal(intA.status, 201); assert.equal(intB.status, 201);
    const aIntegration = intA.body.data.id as string, bIntegration = intB.body.data.id as string;
    assert.equal((await request(app).get(`/api/projects/${aId}/aws/servers`)).status, 401);
    assert.equal((await dev.post(`/api/projects/${aId}/aws/servers`).send({})).status, 403);
    const payload = { environmentId: envA.body.data.id, integrationId: aIntegration, displayName: "Backend", role: "backend", instanceId: "i-1234567890abcdef0" };
    assert.equal((await owner.post(`/api/projects/${aId}/aws/servers`).send({ ...payload, integrationId: bIntegration })).status, 404);
    const mapped = await owner.post(`/api/projects/${aId}/aws/servers`).send(payload);
    assert.equal(mapped.status, 201, JSON.stringify(mapped.body));
    const serverId = mapped.body.data.id as string;
    assert.equal(mapped.body.data.managedInstanceId, payload.instanceId);
    assert.equal((await dev.get(`/api/projects/${aId}/aws/servers`)).status, 200);
    assert.equal((await release.get(`/api/projects/${aId}/aws/servers/${serverId}`)).body.data.ssm.pingStatus, "Online");
    assert.equal((await owner.get(`/api/projects/${bId}/aws/servers/${serverId}`)).status, 404);
    assert.equal((await owner.get(`/api/projects/${bId}/aws/instances/${payload.instanceId}?integrationId=${bIntegration}`)).status, 404);
    assert.equal((await owner.get(`/api/projects/${bId}/aws/instances?integrationId=${aIntegration}`)).status, 404);
    assert.equal((await owner.post(`/api/projects/${aId}/integrations/${aIntegration}/test`)).status, 200);
    assert.equal((await dev.post(`/api/projects/${aId}/aws/servers/${serverId}/actions`).send({ action: "server_identity" })).status, 403);
    const actionUrl = `/api/projects/${aId}/aws/servers/${serverId}/actions`;
    for (const bad of [{ action: "reboot" }, { action: "server_identity; rm -rf /" }, { action: "server_identity", command: "whoami" },
      { action: "server_identity", instanceId: "i-fffffffffffffffff" }, { action: "server_identity", region: "us-west-2" }]) {
      assert.equal((await release.post(actionUrl).send(bad)).status, 400);
    }
    assert.equal(sends, 0);
    instanceState = "stopped";
    assert.equal((await release.post(actionUrl).send({ action: "server_identity" })).body.error.code, "AWS_INSTANCE_NOT_RUNNING");
    instanceState = "running"; ping = "ConnectionLost";
    assert.equal((await release.post(actionUrl).send({ action: "server_identity" })).body.error.code, "AWS_SSM_OFFLINE");
    ping = "Online"; managed = false;
    assert.equal((await release.post(actionUrl).send({ action: "server_identity" })).body.error.code, "AWS_SSM_NOT_MANAGED");
    managed = true;
    failSend = true;
    assert.equal((await release.post(actionUrl).send({ action: "server_identity" })).body.error.code, "AWS_ACCESS_DENIED");
    failSend = false;
    const submitted = await release.post(actionUrl).send({ action: "server_identity" });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    assert.equal(submitted.body.data.externalCommandId, commandId); assert.equal(sends, 1);
    const recordId = submitted.body.data.id as string;
    assert.equal((await owner.get(`/api/projects/${bId}/aws/commands/${recordId}`)).status, 404);
    assert.equal((await owner.get(`/api/projects/${bId}/aws/servers/${serverId}/commands`)).status, 404);
    nextStatus = "succeeded";
    const result = await dev.get(`/api/projects/${aId}/aws/commands/${recordId}`);
    assert.equal(result.status, 200); assert.equal(result.body.data.status, "succeeded");
    assert.ok(!JSON.stringify(result.body).includes("SHOULD_NOT_APPEAR"));
    assert.ok(!JSON.stringify(result.body).includes("secretAccessKey"));
    assert.equal((await owner.post(actionUrl).send({ action: "server_identity" })).status, 201);
    assert.equal(sends, 2);
    failIdentity = true;
    const failure = await owner.post(`/api/projects/${aId}/integrations/${aIntegration}/test`);
    assert.equal(failure.status, 502); assert.equal(failure.body.error.code, "AWS_AUTH_FAILED");
    assert.ok(!events.join("\n").includes("SHOULD_NOT_APPEAR"));
  } finally {
    setAwsProviderForTests(null); console.info = originalInfo;
    if (projectIds.length) {
      await db.delete(awsCommandRecords).where(inArray(awsCommandRecords.projectId, projectIds));
      await db.delete(awsServers).where(inArray(awsServers.projectId, projectIds));
      await db.delete(integrations).where(inArray(integrations.projectId, projectIds));
      await db.delete(environments).where(inArray(environments.projectId, projectIds));
      await db.delete(projects).where(inArray(projects.id, projectIds));
    }
    if (userIds.length) { await db.delete(sessions).where(inArray(sessions.userId, userIds)); await db.delete(users).where(inArray(users.id, userIds)); }
    await pool.end();
  }
});
