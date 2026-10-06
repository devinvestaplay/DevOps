import { sign } from "node:crypto";
import { z } from "zod";

export type GitHubConfig = { owner: string; repository: string; defaultBranch: string; appId: string; installationId: string };
export type GitHubReadKind = "repository" | "branches" | "commits" | "pull-requests" | "workflow-runs";

export class GitHubError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}

const apiBase = "https://api.github.com";
const apiVersion = "2026-03-10";
const tokenSchema = z.object({ token: z.string().min(1), expires_at: z.iso.datetime() });
const installationSchema = z.object({ id: z.number(), app_id: z.number(), account: z.object({ login: z.string() }), suspended_at: z.string().nullable().optional() });
const repositorySchema = z.object({ full_name: z.string(), default_branch: z.string(), private: z.boolean(), html_url: z.url() });

export function createAppJwt(appId: string, privateKey: string, now = Date.now()): string {
  const issued = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: issued - 60, exp: issued + 540, iss: appId })).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")}`;
}

function providerFailure(status: number): GitHubError {
  if (status === 401) return new GitHubError("GITHUB_AUTH_FAILED", 502, "GitHub App authentication failed");
  if (status === 403) return new GitHubError("GITHUB_FORBIDDEN", 502, "GitHub denied access or rate limited the request");
  if (status === 404) return new GitHubError("GITHUB_NOT_FOUND", 502, "GitHub installation or repository was not found");
  if (status === 429) return new GitHubError("GITHUB_RATE_LIMITED", 503, "GitHub rate limit reached");
  return new GitHubError("GITHUB_UNAVAILABLE", 503, "GitHub is unavailable");
}

export class GitHubClient {
  constructor(private readonly transport: typeof fetch = (...args) => fetch(...args)) {}

  private async call(path: string, token: string, method: "GET" | "POST" = "GET", body?: object): Promise<unknown> {
    try {
      const response = await this.transport(`${apiBase}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(8000),
        headers: {
          Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": apiVersion, "User-Agent": "Investaplay-DevOps-Platform",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw providerFailure(response.status);
      return await response.json();
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new GitHubError("GITHUB_TIMEOUT", 503, "GitHub request timed out");
      }
      throw new GitHubError("GITHUB_UNAVAILABLE", 503, "GitHub is unavailable");
    }
  }

  private async appAuthentication(config: GitHubConfig, privateKey: string) {
    let jwt: string;
    try { jwt = createAppJwt(config.appId, privateKey); }
    catch { throw new GitHubError("GITHUB_KEY_INVALID", 409, "GitHub App private key is invalid"); }
    const installation = installationSchema.safeParse(await this.call(`/app/installations/${config.installationId}`, jwt));
    if (!installation.success || String(installation.data.id) !== config.installationId || String(installation.data.app_id) !== config.appId || installation.data.account.login.toLowerCase() !== config.owner.toLowerCase() || installation.data.suspended_at) {
      throw new GitHubError("GITHUB_INSTALLATION_MISMATCH", 409, "Configured GitHub installation does not match the app");
    }
    const issued = tokenSchema.safeParse(await this.call(`/app/installations/${config.installationId}/access_tokens`, jwt, "POST", {
      repositories: [config.repository],
      permissions: { metadata: "read", contents: "read", pull_requests: "read", actions: "read" },
    }));
    if (!issued.success) throw new GitHubError("GITHUB_INVALID_RESPONSE", 502, "GitHub returned an invalid token response");
    return issued.data.token;
  }

  private repositoryPath(config: GitHubConfig) {
    return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`;
  }

  private async repository(config: GitHubConfig, token: string) {
    const parsed = repositorySchema.safeParse(await this.call(this.repositoryPath(config), token));
    if (!parsed.success) throw new GitHubError("GITHUB_INVALID_RESPONSE", 502, "GitHub returned invalid repository data");
    if (parsed.data.full_name.toLowerCase() !== `${config.owner}/${config.repository}`.toLowerCase()) {
      throw new GitHubError("GITHUB_REPOSITORY_MISMATCH", 409, "GitHub repository identity does not match configuration");
    }
    return { repository: parsed.data.full_name, defaultBranch: parsed.data.default_branch, private: parsed.data.private, url: parsed.data.html_url };
  }

  async testConnection(config: GitHubConfig, privateKey: string) {
    const token = await this.appAuthentication(config, privateKey);
    const repository = await this.repository(config, token);
    return { connected: true as const, repository: repository.repository, defaultBranch: repository.defaultBranch };
  }

  async branchHead(config: GitHubConfig, privateKey: string, branch: string): Promise<string> {
    if (branch !== config.defaultBranch || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)) {
      throw new GitHubError("GITHUB_BRANCH_NOT_ALLOWED", 409, "Branch is not configured for this repository");
    }
    const token = await this.appAuthentication(config, privateKey);
    await this.repository(config, token);
    const result = z.object({ name: z.string(), commit: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) })
      .safeParse(await this.call(`${this.repositoryPath(config)}/branches/${encodeURIComponent(branch)}`, token));
    if (!result.success || result.data.name !== branch) throw new GitHubError("GITHUB_INVALID_RESPONSE", 502, "GitHub returned invalid branch data");
    return result.data.commit.sha;
  }

  async read(config: GitHubConfig, privateKey: string, kind: GitHubReadKind, page: number, perPage: number) {
    const token = await this.appAuthentication(config, privateKey);
    const repository = await this.repository(config, token);
    if (kind === "repository") return repository;
    const base = this.repositoryPath(config);
    const query = `?per_page=${perPage}&page=${page}`;
    if (kind === "branches") {
      const parsed = z.array(z.object({ name: z.string(), commit: z.object({ sha: z.string() }) })).safeParse(await this.call(`${base}/branches${query}`, token));
      if (!parsed.success) throw new GitHubError("GITHUB_INVALID_RESPONSE", 502, "GitHub returned invalid branch data");
      return parsed.data.map((entry) => ({ name: entry.name, sha: entry.commit.sha }));
    }
    if (kind === "commits") {
      const parsed = z.array(z.object({ sha: z.string(), commit: z.object({ message: z.string(), author: z.object({ name: z.string().nullable(), date: z.string().nullable() }).nullable() }) })).safeParse(await this.call(`${base}/commits${query}`, token));
      if (!parsed.success) throw new GitHubError("GITHUB_INVALID_RESPONSE", 502, "GitHub returned invalid commit data");
      return parsed.data.map((entry) => ({ sha: entry.sha, message: entry.commit.message, author: entry.commit.author?.name ?? null, timestamp: entry.commit.author?.date ?? null }));
    }
    if (kind === "pull-requests") {
      const parsed = z.array(z.object({ number: z.number(), title: z.string(), state: z.string(), head: z.object({ ref: z.string() }), base: z.object({ ref: z.string() }) })).safeParse(await this.call(`${base}/pulls${query}`, token));
      if (!parsed.success) throw new GitHubError("GITHUB_INVALID_RESPONSE", 502, "GitHub returned invalid pull request data");
      return parsed.data.map((entry) => ({ number: entry.number, title: entry.title, state: entry.state, head: entry.head.ref, base: entry.base.ref }));
    }
    const parsed = z.object({ workflow_runs: z.array(z.object({ name: z.string().nullable(), status: z.string(), conclusion: z.string().nullable(), head_branch: z.string().nullable(), head_sha: z.string(), created_at: z.string() })) }).safeParse(await this.call(`${base}/actions/runs${query}`, token));
    if (!parsed.success) throw new GitHubError("GITHUB_INVALID_RESPONSE", 502, "GitHub returned invalid workflow data");
    return parsed.data.workflow_runs.map((entry) => ({ name: entry.name, status: entry.status, conclusion: entry.conclusion, branch: entry.head_branch, sha: entry.head_sha, timestamp: entry.created_at }));
  }
}
