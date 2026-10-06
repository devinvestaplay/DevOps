import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { app } from "./app";
import { createUser } from "./auth/store";
import { db, pool } from "./db/client";
import { awsCommandRecords, awsServers, deploymentConfigurations, deploymentRecords, deploymentStepRecords, environments, integrations, projects, secretReferences, sessions, users } from "./db/schema";
import { createDeploymentRecord, getDeploymentRecord, listDeploymentSteps, transitionDeploymentRecord } from "./deploy-store";
import { executionConfig, executionTarget } from "./deploy-api/context";
import { setDeploymentHeadResolverForTests } from "./deploy-api/router";
import { runDeployment, runRollback, setDeploymentProvidersForTests } from "./deploy-api/service";
import { AwsError, type AwsProvider, type InvocationInfo } from "./aws/client";
import type { DeploymentSsmProvider, DeploymentStepType, DeploymentTarget, PreflightProbeType } from "./deploy-executor/types";

const previousSha = "b".repeat(40), targetSha = "a".repeat(40);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("deployment preflight, confirmation, scoped execution, automatic health rollback and manual rollback", async () => {
  const suffix = randomUUID().slice(0, 8), password = `Test-Password-${randomUUID()}`;
  const projectIds: string[] = [], userIds: string[] = [];
  const commandKinds = new Map<string, string>();
  const sends: { kind: string; target: string }[] = [];
  let current = previousSha, failStep: string | null = null, rollbackHealthFails = false, dirtyWorktree = false;
  let failureMode: "command" | "timeout" | "throttled" | "network" = "command";
  const ssm: DeploymentSsmProvider = {
    async sendProbe(target: DeploymentTarget, probe: PreflightProbeType) {
      assert.equal(target.managedInstanceId, "i-1234567890abcdef0");
      const commandId = randomUUID(); commandKinds.set(commandId, `probe:${probe}`); sends.push({ kind: `probe:${probe}`, target: target.managedInstanceId });
      return { commandId, status: "queued", providerStatus: "Pending" };
    },
    async sendStep(target: DeploymentTarget, step: DeploymentStepType) {
      assert.equal(target.managedInstanceId, "i-1234567890abcdef0");
      if (step === failStep && failureMode === "throttled") throw new AwsError("AWS_THROTTLED", 503, "AWS request throttled");
      const commandId = randomUUID(); commandKinds.set(commandId, step); sends.push({ kind: step, target: target.managedInstanceId });
      return { commandId, status: "queued", providerStatus: "Pending" };
    },
    async getInvocation(_target: DeploymentTarget, commandId: string): Promise<InvocationInfo> {
      const kind = commandKinds.get(commandId)!;
      if (kind === "capture_current_revision" && dirtyWorktree) return { status: "failed", providerStatus: "Failed", exitCode: 1, output: "WORKTREE_DIRTY", error: null };
      if (kind === failStep && failureMode === "network") throw new AwsError("AWS_UNAVAILABLE", 503, "AWS network unavailable");
      if (kind === failStep && failureMode === "timeout") return { status: "timed_out", providerStatus: "TimedOut", exitCode: 1, output: null, error: "timed out" };
      if (kind === failStep || (kind === "rollback_health_check" && rollbackHealthFails)) return { status: "failed", providerStatus: "Failed", exitCode: 1,
        output: kind === "probe:repository" ? "REMOTE_MISMATCH\n" : null, error: "sanitized failure" };
      if (kind === "checkout_revision") current = targetSha;
      if (kind === "rollback_checkout") current = previousSha;
      const output = kind === "probe:repository" ? `REMOTE_OK\n${current}\nmain\nWORKTREE_CLEAN\n` :
        kind === "probe:runtime" ? '{"node":"v20.0.0","packageJson":true,"lockfile":true,"packageManager":"npm@10.0.0","scripts":["build"]}' :
        kind === "capture_current_revision" ? `${current}\n` :
        kind === "probe:health" || kind === "health_check" || kind === "rollback_health_check" ? "HTTP 200; duration 0.012s" : null;
      return { status: "succeeded", providerStatus: "Success", exitCode: 0, output, error: null };
    },
  };
  const aws: AwsProvider = {
    async testConnection(config) { return { connected: true, provider: "aws", accountId: config.accountId, region: config.region, instanceId: null, ssmManaged: null, ssmOnline: null }; },
    async describeInstance(_config, instanceId) { return { id: instanceId, state: "running", instanceType: "t3.small", availabilityZone: "us-east-1a", privateIp: null, publicIp: null, launchTime: null }; },
    async describeSsmTarget() { return { managed: true, pingStatus: "Online", platform: "Linux", agentVersion: "3", lastPingAt: null }; },
    async sendDiagnostic() { throw new Error("Unexpected diagnostic"); }, async getCommand() { throw new Error("Unexpected diagnostic"); },
  };
  setDeploymentProvidersForTests(ssm, aws);
  setDeploymentHeadResolverForTests(async () => targetSha);
  const waitRecord = async (projectId: string, deploymentId: string, status: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = await getDeploymentRecord(projectId, deploymentId);
      if (record?.status === status) return record;
      await pause(10);
    }
    assert.fail(`Deployment did not reach ${status}`);
  };
  try {
    const admin = await createUser({ email: `deploy-admin-${suffix}@example.test`, name: "Admin", password, role: "admin" });
    const developer = await createUser({ email: `deploy-dev-${suffix}@example.test`, name: "Dev", password, role: "developer" });
    const manager = await createUser({ email: `deploy-release-${suffix}@example.test`, name: "Release", password, role: "release_manager" });
    userIds.push(admin.id, developer.id, manager.id);
    const agents = [admin, developer, manager].map(() => request.agent(app));
    for (let i = 0; i < agents.length; i++) assert.equal((await agents[i].post("/api/auth/login").send({ email: [admin, developer, manager][i].email, password })).status, 200);
    const [owner, dev, release] = agents;
    const a = await owner.post("/api/projects").send({ name: "Deploy A", slug: `deploy-a-${suffix}` });
    const b = await owner.post("/api/projects").send({ name: "Deploy B", slug: `deploy-b-${suffix}` });
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    const aId = a.body.data.id as string, bId = b.body.data.id as string; projectIds.push(aId, bId);
    const env = await owner.post(`/api/projects/${aId}/environments`).send({ name: "production", type: "production" });
    const otherEnv = await owner.post(`/api/projects/${bId}/environments`).send({ name: "production", type: "production" });
    assert.equal(env.status, 201); assert.equal(otherEnv.status, 201);
    const awsConfig = { region: "us-east-1", accountId: "123456789012", controlStrategy: "ssm" };
    const awsIntegration = await owner.post(`/api/projects/${aId}/integrations`).send({ provider: "aws", displayName: "AWS", environmentId: env.body.data.id, configuration: awsConfig });
    assert.equal(awsIntegration.status, 201);
    const reference = await owner.post(`/api/projects/${aId}/secret-references`).send({ provider: "github", purpose: "github_app_private_key", displayName: "GitHub key", referenceType: "environment_variable", referenceKey: "GITHUB_APP_DEPLOY_TEST_PRIVATE_KEY" });
    assert.equal(reference.status, 201);
    const githubConfig = { owner: "sample-org", repository: "sample-repo", defaultBranch: "main", repositoryType: "backend", appId: "12345", installationId: "67890" };
    const github = await owner.post(`/api/projects/${aId}/integrations`).send({ provider: "github", displayName: "GitHub", configuration: githubConfig, secretReferenceId: reference.body.data.id });
    assert.equal(github.status, 201);
    await db.update(integrations).set({ lastVerificationResult: "connected", lastVerifiedAt: new Date() }).where(inArray(integrations.id, [awsIntegration.body.data.id, github.body.data.id]));
    const server = await owner.post(`/api/projects/${aId}/aws/servers`).send({ environmentId: env.body.data.id, integrationId: awsIntegration.body.data.id,
      displayName: "Backend", role: "backend", instanceId: "i-1234567890abcdef0" });
    assert.equal(server.status, 201);
    const configUrl = `/api/projects/${aId}/deployment-configs`;
    const config = { environmentId: env.body.data.id, serverId: server.body.data.id, githubIntegrationId: github.body.data.id,
      allowedBranch: "main", repositoryPath: "/srv/example", applicationPath: "/srv/example/backend", executionAccount: "example", repositorySshHostAlias: null, packageManager: "npm",
      installStrategy: "npm_ci", buildStrategy: "npm_build", processManager: "pm2", serviceName: "backend-api",
      healthUrl: "http://127.0.0.1:4000/health", healthTimeoutSeconds: 10, rollbackStrategy: "manual", enabled: true };
    assert.equal((await request(app).get(configUrl)).status, 401);
    assert.equal((await dev.post(configUrl).send(config)).status, 403);
    for (const bad of [
      { repositoryPath: "/srv/example;touch/tmp/pwn" }, { applicationPath: "/etc" }, { serviceName: "backend-api; reboot" },
      { healthUrl: "http://169.254.169.254/latest/meta-data" }, { allowedBranch: "main; rm -rf /" },
      { executionAccount: "ubuntu;id" }, { repositorySshHostAlias: "github;id" },
      { serverId: randomUUID() }, { environmentId: otherEnv.body.data.id },
    ]) assert.notEqual((await owner.post(configUrl).send({ ...config, ...bad })).status, 201);
    const created = await owner.post(configUrl).send(config);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const configurationId = created.body.data.id as string;
    const previousSends = sends.length;
    assert.equal((await owner.patch(`${configUrl}/${configurationId}`).send({ executionAccount: null })).status, 200);
    assert.equal((await owner.post(`/api/projects/${aId}/deployments/preflight`).send({ configurationId, sourceRef: "main" })).status, 422);
    assert.equal(sends.length, previousSends);
    assert.equal((await owner.patch(`${configUrl}/${configurationId}`).send({ executionAccount: "example" })).status, 200);
    assert.equal((await dev.get(configUrl)).status, 200);
    const preflightUrl = `/api/projects/${aId}/deployments/preflight`;
    assert.equal((await dev.post(preflightUrl).send({ configurationId, sourceRef: "main" })).status, 403);
    assert.equal((await release.post(preflightUrl).send({ configurationId, sourceRef: "main" })).status, 403);
    assert.equal((await owner.post(preflightUrl).send({ configurationId, sourceRef: "main; echo bad" })).status, 400);
    assert.equal((await owner.post(preflightUrl).send({ configurationId, sourceRef: "other" })).status, 409);
    assert.equal((await owner.post(preflightUrl).send({ configurationId, sourceRef: "main", command: "reboot" })).status, 400);
    assert.equal((await owner.post(`/api/projects/${bId}/deployments/preflight`).send({ configurationId, sourceRef: "main" })).status, 404);
    failStep = "probe:repository";
    const beforeDeniedProbe = sends.length;
    const deniedProbe = await owner.post(preflightUrl).send({ configurationId, sourceRef: "main" });
    assert.equal(deniedProbe.status, 409);
    assert.match(deniedProbe.body.error.message, /REMOTE_MISMATCH; SSM command [a-f0-9-]{36}$/);
    assert.deepEqual(sends.slice(beforeDeniedProbe).map((item) => item.kind), ["probe:repository"]);
    failStep = null;
    const preflight = await owner.post(preflightUrl).send({ configurationId, sourceRef: "main" });
    assert.equal(preflight.status, 201, JSON.stringify(preflight.body));
    const record = preflight.body.data.deployment;
    assert.equal(record.previousSha, previousSha); assert.equal(record.targetSha, targetSha);
    assert.equal(record.status, "awaiting_confirmation");
    assert.equal((await owner.get(`/api/projects/${bId}/deployments/${record.id}`)).status, 404);
    const confirmUrl = `/api/projects/${aId}/deployments/${record.id}/confirm`;
    assert.equal((await dev.post(confirmUrl).send({ challenge: preflight.body.data.challenge })).status, 403);
    assert.equal((await owner.post(confirmUrl).send({ challenge: "WRONG" })).status, 400);
    assert.equal((await owner.post(confirmUrl).send({ challenge: preflight.body.data.challenge, command: "reboot" })).status, 400);
    const confirmed = await owner.post(confirmUrl).send({ challenge: preflight.body.data.challenge });
    assert.equal(confirmed.status, 202, JSON.stringify(confirmed.body));
    const success = await waitRecord(aId, record.id, "succeeded");
    assert.equal(success.healthHttpStatus, 200); assert.equal(success.requestedByUserId, admin.id);
    const details = await dev.get(`/api/projects/${aId}/deployments/${record.id}`);
    assert.equal(details.status, 200); assert.ok(details.body.data.steps.some((step: { stepType: string }) => step.stepType === "restart_service"));
    assert.ok(sends.every((send) => send.target === "i-1234567890abcdef0"));
    assert.equal((await owner.post(confirmUrl).send({ challenge: preflight.body.data.challenge })).status, 409);
    const noChange = await owner.post(preflightUrl).send({ configurationId, sourceRef: "main" });
    assert.equal(noChange.status, 201);
    assert.equal(noChange.body.data.deployment.previousSha, targetSha);
    assert.equal((await owner.post(`/api/projects/${aId}/deployments/${noChange.body.data.deployment.id}/confirm`).send({ challenge: noChange.body.data.challenge })).body.error.code, "DEPLOYMENT_NO_SOURCE_CHANGE");
    current = previousSha;

    // The database unique key, rather than a UI button, serializes the same target.
    const conf = (await db.select().from(deploymentConfigurations).where(eq(deploymentConfigurations.id, configurationId)))[0];
    assert.ok(conf);
    const publicConfig = created.body.data;
    const first = await createDeploymentRecord(aId, publicConfig, { repositoryOwner: "sample-org", repositoryName: "sample-repo", requestedRef: "main", targetSha, previousSha, requestedByUserId: admin.id });
    const second = await createDeploymentRecord(aId, publicConfig, { repositoryOwner: "sample-org", repositoryName: "sample-repo", requestedRef: "main", targetSha, previousSha, requestedByUserId: admin.id });
    const locks = await Promise.allSettled([transitionDeploymentRecord(aId, first.id, "awaiting_confirmation", "queued"), transitionDeploymentRecord(aId, second.id, "awaiting_confirmation", "queued")]);
    assert.equal(locks.filter((item) => item.status === "fulfilled" && item.value !== null).length, 1);
    const locked = locks.find((item) => item.status === "fulfilled" && item.value !== null) as PromiseFulfilledResult<typeof first>;
    await transitionDeploymentRecord(aId, locked.value.id, "queued", "failed");
    await assert.rejects(transitionDeploymentRecord(aId, first.id, "failed", "succeeded"));

    // Failures before checkout stop. A post-restart health failure rolls back
    // automatically; other post-checkout failures retain a lock for review.
    const target = executionTarget("us-east-1", "123456789012", "i-1234567890abcdef0");
    const template = executionConfig(publicConfig, "sample-org", "sample-repo", targetSha, previousSha);
    for (const failedAt of ["fetch_source", "install_dependencies", "build", "restart_service", "health_check"]) {
      current = previousSha; failStep = failedAt;
      const failed = await createDeploymentRecord(aId, publicConfig, { repositoryOwner: "sample-org", repositoryName: "sample-repo", requestedRef: "main", targetSha, previousSha, requestedByUserId: admin.id });
      await transitionDeploymentRecord(aId, failed.id, "awaiting_confirmation", "queued");
      await runDeployment(failed, target, template);
      const state = (await getDeploymentRecord(aId, failed.id))!.status;
      assert.equal(state, failedAt === "fetch_source" ? "failed" : failedAt === "health_check" ? "rolled_back" : "rollback_pending");
      if (failedAt === "health_check") {
        assert.equal(current, previousSha);
        const steps = await listDeploymentSteps(aId, failed.id);
        assert.deepEqual(steps.slice(-6).map((step) => step.stepType),
          ["capture_current_revision", "rollback_checkout", "rollback_install", "rollback_build", "rollback_restart", "rollback_health_check"]);
        assert.equal(steps.at(-1)?.stepType, "rollback_health_check");
        assert.equal(steps.at(-1)?.status, "succeeded");
        assert.equal((await getDeploymentRecord(aId, failed.id))!.sanitizedError, "DEPLOYMENT_STEP_FAILED");
      }
      if (state === "rollback_pending") {
        failStep = null;
        if (failedAt === "build") {
          const rollbackUrl = `/api/projects/${aId}/deployments/${failed.id}/rollback`;
          const challenge = `ROLLBACK ${failed.id} ${previousSha}`;
          assert.equal((await dev.post(rollbackUrl).send({ challenge })).status, 403);
          assert.equal((await owner.post(rollbackUrl).send({ challenge, previousSha: targetSha })).status, 400);
          assert.equal((await owner.post(rollbackUrl).send({ challenge: "WRONG" })).status, 400);
          assert.equal((await owner.post(rollbackUrl).send({ challenge })).status, 202);
          await waitRecord(aId, failed.id, "rolled_back");
        } else await runRollback(failed, target, template);
        assert.equal((await getDeploymentRecord(aId, failed.id))!.status, "rolled_back");
        assert.equal(current, previousSha);
      }
    }
    for (const mode of ["timeout", "throttled", "network"] as const) {
      current = previousSha; failStep = "fetch_source"; failureMode = mode;
      const failed = await createDeploymentRecord(aId, publicConfig, { repositoryOwner: "sample-org", repositoryName: "sample-repo", requestedRef: "main", targetSha, previousSha, requestedByUserId: admin.id });
      await transitionDeploymentRecord(aId, failed.id, "awaiting_confirmation", "queued");
      await runDeployment(failed, target, template);
      assert.equal((await getDeploymentRecord(aId, failed.id))!.status, "failed");
      const steps = await listDeploymentSteps(aId, failed.id);
      assert.equal(steps.find((step) => step.stepType === "fetch_source")?.status, mode === "timeout" ? "timed_out" : "failed");
      assert.ok(!steps.some((step) => step.stepType === "checkout_revision"));
    }
    failStep = null; failureMode = "command";
    for (const condition of ["changed_sha", "dirty_worktree"] as const) {
      current = condition === "changed_sha" ? "c".repeat(40) : previousSha;
      dirtyWorktree = condition === "dirty_worktree";
      const guarded = await createDeploymentRecord(aId, publicConfig, { repositoryOwner: "sample-org", repositoryName: "sample-repo", requestedRef: "main", targetSha, previousSha, requestedByUserId: admin.id });
      await transitionDeploymentRecord(aId, guarded.id, "awaiting_confirmation", "queued");
      const before = sends.length;
      await runDeployment(guarded, target, template);
      assert.equal((await getDeploymentRecord(aId, guarded.id))!.status, "failed");
      assert.deepEqual(sends.slice(before).map((item) => item.kind), ["capture_current_revision"]);
      dirtyWorktree = false;
    }
    // A failed restored-version health check must never be marked rolled back.
    current = previousSha; failStep = "health_check"; rollbackHealthFails = true;
    const failedRollback = await createDeploymentRecord(aId, publicConfig, { repositoryOwner: "sample-org", repositoryName: "sample-repo", requestedRef: "main", targetSha, previousSha, requestedByUserId: admin.id });
    await transitionDeploymentRecord(aId, failedRollback.id, "awaiting_confirmation", "queued");
    await runDeployment(failedRollback, target, template);
    const rollbackResult = (await getDeploymentRecord(aId, failedRollback.id))!;
    assert.equal(rollbackResult.status, "rollback_failed");
    assert.match(rollbackResult.sanitizedError ?? "", /MANUAL_INTERVENTION_REQUIRED/);
    assert.equal((await listDeploymentSteps(aId, failedRollback.id)).at(-1)?.stepType, "rollback_health_check");
    assert.equal((await listDeploymentSteps(aId, failedRollback.id)).at(-1)?.status, "failed");
    rollbackHealthFails = false; failStep = null;
    assert.equal((await db.select().from(deploymentRecords).where(eq(deploymentRecords.id, record.id)))[0].status, "succeeded");
    assert.ok((await listDeploymentSteps(aId, record.id)).length >= 7);
  } finally {
    setDeploymentProvidersForTests(null, null); setDeploymentHeadResolverForTests(null);
    if (projectIds.length) {
      await db.delete(deploymentStepRecords).where(inArray(deploymentStepRecords.projectId, projectIds));
      await db.delete(deploymentRecords).where(inArray(deploymentRecords.projectId, projectIds));
      await db.delete(deploymentConfigurations).where(inArray(deploymentConfigurations.projectId, projectIds));
      await db.delete(awsCommandRecords).where(inArray(awsCommandRecords.projectId, projectIds));
      await db.delete(awsServers).where(inArray(awsServers.projectId, projectIds));
      await db.delete(integrations).where(inArray(integrations.projectId, projectIds));
      await db.delete(secretReferences).where(inArray(secretReferences.projectId, projectIds));
      await db.delete(environments).where(inArray(environments.projectId, projectIds));
      await db.delete(projects).where(inArray(projects.id, projectIds));
    }
    if (userIds.length) { await db.delete(sessions).where(inArray(sessions.userId, userIds)); await db.delete(users).where(inArray(users.id, userIds)); }
    await pool.end();
  }
});
