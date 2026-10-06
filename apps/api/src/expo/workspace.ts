import { execFile } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ExpoError } from "./errors";

const execFileAsync = promisify(execFile);

function inside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function withExpoWorkspace<T>(workingDirectory: string, work: (directory: string) => Promise<T>): Promise<T> {
  const rootSetting = process.env.EXPO_PROJECTS_ROOT;
  if (!rootSetting || !isAbsolute(rootSetting)) throw new ExpoError("EXPO_SOURCE_ROOT_UNAVAILABLE", 503, "Expo source root is not configured");
  const parts = workingDirectory.split("/");
  if (parts.length === 0 || parts.some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new ExpoError("EXPO_WORKING_DIRECTORY_INVALID", 409, "Expo working directory is invalid");
  }
  let approvedRoot: string, source: string, repositoryRoot: string;
  try {
    approvedRoot = await realpath(rootSetting);
    source = await realpath(resolve(approvedRoot, ...parts));
    if (!inside(approvedRoot, source)) throw new Error("outside root");
    const result = await execFileAsync("git", ["-C", source, "rev-parse", "--show-toplevel"], { timeout: 10000, maxBuffer: 4096, windowsHide: true });
    repositoryRoot = await realpath(result.stdout.trim());
    if (!inside(approvedRoot, repositoryRoot) || !inside(repositoryRoot, source)) throw new Error("outside root");
  } catch {
    throw new ExpoError("EXPO_SOURCE_UNAVAILABLE", 409, "Expo source must be a Git checkout inside the approved root");
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "investaplay-eas-"));
  try {
    const clone = join(temporaryRoot, "repository");
    try {
      await execFileAsync("git", ["clone", "--local", "--no-hardlinks", "--", repositoryRoot, clone], { timeout: 120000, maxBuffer: 8192, windowsHide: true });
    } catch {
      throw new ExpoError("EXPO_SOURCE_CLONE_FAILED", 503, "Could not create isolated Expo source snapshot");
    }
    const appDirectory = join(clone, relative(repositoryRoot, source));
    let hasLockfile = true;
    try { await access(join(appDirectory, "package-lock.json")); }
    catch { hasLockfile = false; }
    if (hasLockfile) {
      try {
        const npmCli = process.env.npm_execpath && isAbsolute(process.env.npm_execpath)
          ? process.env.npm_execpath : join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
        await access(npmCli);
        const env: Record<string, string> = {};
        for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME"]) {
          if (process.env[key]) env[key] = process.env[key]!;
        }
        await execFileAsync(process.execPath, [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
          cwd: appDirectory, env, timeout: 300000, maxBuffer: 1_000_000, windowsHide: true,
        });
      } catch {
        throw new ExpoError("EXPO_SOURCE_DEPENDENCIES_FAILED", 503, "Could not install Expo source dependencies in the temporary snapshot");
      }
    }
    return await work(appDirectory);
  } finally {
    const actualTemp = await realpath(temporaryRoot);
    const actualParent = await realpath(tmpdir());
    if (dirname(actualTemp).toLowerCase() !== actualParent.toLowerCase() || !basename(actualTemp).startsWith("investaplay-eas-")) {
      throw new Error("Temporary Expo path failed safety check");
    }
    await rm(actualTemp, { recursive: true, force: true });
  }
}
