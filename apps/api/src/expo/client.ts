import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import JSON5 from "json5";
import type { BuildStatus, ExpoBuildInfo, ExpoProjectInfo } from "@investaplay/devops-contracts";
import { ExpoError } from "./errors";
import { runEas, type EasRunner } from "./cli-runner";

export type ExpoConfig = {
  expoAccount: string; projectSlug: string; projectId: string; workingDirectory: string;
  previewProfile: string; productionProfile: string; androidEnabled: boolean;
};

const configResponse = z.object({
  appConfig: z.object({ owner: z.string(), slug: z.string(), extra: z.object({ eas: z.object({ projectId: z.uuid() }) }) }),
  buildProfile: z.object({ distribution: z.string().optional(), buildType: z.string().optional(), android: z.object({ buildType: z.string().optional() }).optional() }),
});
const rawBuild = z.object({
  id: z.uuid(), app: z.object({ id: z.uuid() }), platform: z.string(), status: z.string(),
  buildProfile: z.string().nullable().optional(), appVersion: z.string().nullable().optional(),
  appBuildVersion: z.string().nullable().optional(), gitCommitHash: z.string().nullable().optional(),
  createdAt: z.string(), completedAt: z.string().nullable().optional(),
  artifacts: z.object({ applicationArchiveUrl: z.string().nullable().optional() }).nullable().optional(),
  error: z.object({ errorCode: z.string().nullable().optional() }).nullable().optional(),
});

function parsedJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new ExpoError("EXPO_INVALID_RESPONSE", 502, "Expo returned an invalid response"); }
}

export function normalizeBuildStatus(status: string): BuildStatus {
  switch (status.toUpperCase().replaceAll("-", "_")) {
    case "NEW": case "IN_QUEUE": return "queued";
    case "IN_PROGRESS": case "PENDING_CANCEL": return "in_progress";
    case "FINISHED": return "succeeded";
    case "ERRORED": return "failed";
    case "CANCELED": return "canceled";
    default: throw new ExpoError("EXPO_UNKNOWN_BUILD_STATUS", 502, "Expo returned an unknown build status");
  }
}

function publicBuild(value: unknown, projectId: string): ExpoBuildInfo {
  const parsed = rawBuild.safeParse(value);
  if (!parsed.success) throw new ExpoError("EXPO_INVALID_RESPONSE", 502, "Expo returned invalid build data");
  const build = parsed.data;
  if (build.app.id.toLowerCase() !== projectId.toLowerCase()) throw new ExpoError("EXPO_PROJECT_MISMATCH", 409, "Expo build does not belong to the configured project");
  const platform = build.platform.toLowerCase();
  if (platform !== "android" && platform !== "ios") throw new ExpoError("EXPO_INVALID_RESPONSE", 502, "Expo returned an unsupported platform");
  const status = normalizeBuildStatus(build.status);
  const providerError = build.error?.errorCode;
  return {
    id: build.id, platform, profile: build.buildProfile ?? null, status, providerStatus: build.status,
    appVersion: build.appVersion ?? null, appBuildVersion: build.appBuildVersion ?? null,
    gitCommitSha: build.gitCommitHash ?? null, createdAt: build.createdAt,
    completedAt: build.completedAt ?? null,
    artifactAvailable: status === "succeeded" && Boolean(build.artifacts?.applicationArchiveUrl),
    errorCode: providerError && /^[A-Z0-9_-]{1,80}$/.test(providerError) ? providerError : status === "failed" ? "PROVIDER_BUILD_FAILED" : null,
    requestedByUserId: null,
  };
}

export class ExpoClient {
  constructor(private readonly runner: EasRunner = runEas) {}

  async project(config: ExpoConfig, token: string, cwd: string): Promise<ExpoProjectInfo> {
    const raw = await this.runner(["config", "--platform", "android", "--profile", config.previewProfile, "--json", "--non-interactive"], cwd, token);
    const parsed = configResponse.safeParse(parsedJson(raw));
    if (!parsed.success) throw new ExpoError("EXPO_INVALID_RESPONSE", 502, "Expo returned invalid project configuration");
    const app = parsed.data.appConfig;
    if (app.owner.toLowerCase() !== config.expoAccount.toLowerCase() || app.slug !== config.projectSlug || app.extra.eas.projectId.toLowerCase() !== config.projectId.toLowerCase()) {
      throw new ExpoError("EXPO_PROJECT_MISMATCH", 409, "Expo project identity does not match configuration");
    }
    return { account: app.owner, slug: app.slug, projectId: app.extra.eas.projectId, previewProfile: config.previewProfile, androidEnabled: config.androidEnabled };
  }

  async testConnection(config: ExpoConfig, token: string, cwd: string) {
    const project = await this.project(config, token, cwd);
    await this.listBuilds(config, token, cwd, 1, 0);
    return { connected: true as const, provider: "expo" as const, projectSlug: project.slug, projectId: project.projectId };
  }

  async listBuilds(config: ExpoConfig, token: string, cwd: string, limit: number, offset: number): Promise<ExpoBuildInfo[]> {
    const raw = await this.runner(["build:list", "--limit", String(limit), "--offset", String(offset), "--json", "--non-interactive"], cwd, token);
    const parsed = z.array(z.unknown()).safeParse(parsedJson(raw));
    if (!parsed.success) throw new ExpoError("EXPO_INVALID_RESPONSE", 502, "Expo returned invalid build list");
    return parsed.data.map((build) => publicBuild(build, config.projectId));
  }

  async getBuild(config: ExpoConfig, token: string, cwd: string, buildId: string): Promise<ExpoBuildInfo> {
    const raw = await this.runner(["build:view", buildId, "--json"], cwd, token);
    return publicBuild(parsedJson(raw), config.projectId);
  }

  async ensurePreviewApk(config: ExpoConfig, token: string, cwd: string): Promise<void> {
    if (!config.androidEnabled || config.previewProfile.toLowerCase() === "production" || config.previewProfile.toLowerCase() === config.productionProfile.toLowerCase()) {
      throw new ExpoError("EXPO_PRODUCTION_GUARD", 409, "Android preview profile is not safely configured");
    }
    let easJson: unknown;
    try { easJson = JSON5.parse(await readFile(join(cwd, "eas.json"), "utf8")); }
    catch { throw new ExpoError("EXPO_PREVIEW_CONFIG_MISSING", 409, "Preview APK profile is missing from eas.json"); }
    const profiles = z.object({ build: z.record(z.string(), z.unknown()) }).safeParse(easJson);
    if (!profiles.success) throw new ExpoError("EXPO_PREVIEW_CONFIG_INVALID", 409, "EAS build profiles are invalid");
    let profileName = config.previewProfile;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(profileName) || profileName.toLowerCase() === "production" || profileName.toLowerCase() === config.productionProfile.toLowerCase()) {
        throw new ExpoError("EXPO_PRODUCTION_GUARD", 409, "Preview profile may not use production settings");
      }
      visited.add(profileName);
      const profile = z.object({ extends: z.string().optional() }).passthrough().safeParse(profiles.data.build[profileName]);
      if (!profile.success) throw new ExpoError("EXPO_PREVIEW_CONFIG_INVALID", 409, "Preview build profile is invalid");
      if (!profile.data.extends) break;
      profileName = profile.data.extends;
    }
    const raw = await this.runner(["config", "--platform", "android", "--profile", config.previewProfile, "--json", "--non-interactive"], cwd, token);
    const parsed = configResponse.safeParse(parsedJson(raw));
    const profile = parsed.success ? parsed.data.buildProfile : null;
    const buildTypes = profile ? [profile.buildType, profile.android?.buildType].filter((value): value is string => value !== undefined) : [];
    if (!profile || profile.distribution !== "internal" || buildTypes.length === 0 || buildTypes.some((value) => value !== "apk")) {
      throw new ExpoError("EXPO_PREVIEW_CONFIG_INVALID", 409, "Preview profile must produce an internal Android APK");
    }
    await this.project(config, token, cwd);
  }

  async startPreview(config: ExpoConfig, token: string, cwd: string): Promise<ExpoBuildInfo> {
    await this.ensurePreviewApk(config, token, cwd);
    const raw = await this.runner(["build", "--platform", "android", "--profile", config.previewProfile, "--non-interactive", "--json", "--no-wait", "--freeze-credentials"], cwd, token, 600000);
    const parsed = z.array(z.unknown()).length(1).safeParse(parsedJson(raw));
    if (!parsed.success) throw new ExpoError("EXPO_INVALID_RESPONSE", 502, "Expo returned invalid build submission data");
    const build = publicBuild(parsed.data[0], config.projectId);
    if (build.platform !== "android" || build.profile !== config.previewProfile) throw new ExpoError("EXPO_PRODUCTION_GUARD", 502, "Expo returned an unexpected build profile");
    return build;
  }
}
