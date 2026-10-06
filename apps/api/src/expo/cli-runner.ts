import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { ExpoError } from "./errors";

export type EasRunner = (args: string[], cwd: string, token: string, timeoutMs?: number) => Promise<string>;

function sanitizedCliFailure(stderr: string): ExpoError {
  if (/rate.?limit|too many requests/i.test(stderr)) return new ExpoError("EXPO_RATE_LIMITED", 503, "Expo rate limit reached");
  if (/unauthori[sz]ed|invalid.*token|authentication.*fail|not logged in/i.test(stderr)) return new ExpoError("EXPO_AUTH_FAILED", 502, "Expo authentication failed");
  if (/project.*not found|not authorized|permission denied|forbidden/i.test(stderr)) return new ExpoError("EXPO_PROJECT_INACCESSIBLE", 502, "Expo project is inaccessible");
  return new ExpoError("EXPO_COMMAND_FAILED", 502, "Expo command failed");
}

export const runEas: EasRunner = (args, cwd, token, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const entrypoint = process.env.EAS_CLI_ENTRYPOINT ?? join(dirname(require.resolve("eas-cli/package.json")), "bin", "run");
  const passthrough = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME"] as const;
  const env: Record<string, string> = { CI: "1", EXPO_NO_TELEMETRY: "1", EXPO_TOKEN: token };
  for (const key of passthrough) if (process.env[key]) env[key] = process.env[key]!;
  const child = spawn(process.execPath, [entrypoint, ...args], { cwd, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", done = false;
  const finish = (error?: ExpoError) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (error) reject(error); else resolve(stdout);
  };
  const timer = setTimeout(() => { child.kill(); finish(new ExpoError("EXPO_TIMEOUT", 503, "Expo command timed out")); }, timeoutMs);
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.length > 3_000_000) { child.kill(); finish(new ExpoError("EXPO_RESPONSE_TOO_LARGE", 502, "Expo response exceeded the limit")); }
  });
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-10000); });
  child.on("error", () => finish(new ExpoError("EXPO_CLI_UNAVAILABLE", 503, "EAS CLI is unavailable")));
  child.on("close", (code) => {
    if (done) return;
    if (code !== 0) finish(sanitizedCliFailure(stderr)); else finish();
  });
});
