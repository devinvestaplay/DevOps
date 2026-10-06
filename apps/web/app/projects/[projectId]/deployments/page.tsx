"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { AwsServer, CreateDeploymentConfigurationInput, DeploymentConfiguration, DeploymentRecord, Environment, Integration, Project } from "@investaplay/devops-contracts";
import { useCurrentUser } from "../../../../components/auth-shell";
import { apiRequest } from "../../../../lib/api";

type PreflightResult = { deployment: DeploymentRecord; challenge: string };
const initialForm: CreateDeploymentConfigurationInput = {
  environmentId: "", serverId: "", githubIntegrationId: "", allowedBranch: "", repositoryPath: "", applicationPath: "",
  executionAccount: null, repositorySshHostAlias: null,
  packageManager: "none", installStrategy: "none", buildStrategy: "none", processManager: "pm2", serviceName: "",
  healthUrl: "", healthTimeoutSeconds: 10, rollbackStrategy: "manual", enabled: false,
};

export default function DeploymentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const user = useCurrentUser();
  const isAdmin = user.role === "admin";
  const canInitiate = isAdmin || user.role === "release_manager";
  const [project, setProject] = useState<Project | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [servers, setServers] = useState<AwsServer[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [configurations, setConfigurations] = useState<DeploymentConfiguration[]>([]);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [form, setForm] = useState<CreateDeploymentConfigurationInput>(initialForm);
  const [configurationId, setConfigurationId] = useState("");
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [executionAccount, setExecutionAccount] = useState("");
  const [repositorySshHostAlias, setRepositorySshHostAlias] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const selectedConfig = configurations.find((item) => item.id === configurationId);
  const environmentName = (id: string) => environments.find((item) => item.id === id)?.name ?? id;
  const serverName = (id: string) => servers.find((item) => item.id === id)?.displayName ?? id;
  const repoName = (id: string) => { const config = integrations.find((item) => item.id === id)?.configuration; return config ? `${String(config.owner ?? "?")}/${String(config.repository ?? "?")}` : "Unavailable"; };

  async function reload() {
    const [p, e, s, i, c, d] = await Promise.all([
      apiRequest<Project>(`/projects/${projectId}`), apiRequest<Environment[]>(`/projects/${projectId}/environments`),
      apiRequest<AwsServer[]>(`/projects/${projectId}/aws/servers`), apiRequest<Integration[]>(`/projects/${projectId}/integrations`),
      apiRequest<DeploymentConfiguration[]>(`/projects/${projectId}/deployment-configs`), apiRequest<DeploymentRecord[]>(`/projects/${projectId}/deployments`),
    ]);
    setProject(p); setEnvironments(e); setServers(s); setIntegrations(i); setConfigurations(c); setDeployments(d);
  }
  useEffect(() => { void reload().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load deployments")); }, [projectId]);
  useEffect(() => { const config = configurations.find((item) => item.id === configurationId); setSourceRef(config?.allowedBranch ?? ""); setPreflight(null); }, [configurationId, configurations]);

  async function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try { await apiRequest<DeploymentConfiguration>(`/projects/${projectId}/deployment-configs`, { method: "POST", body: JSON.stringify(form) }); await reload(); setForm(initialForm); setNotice("Deployment configuration saved. Review and enable it before preflight."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save configuration"); }
    finally { setBusy(false); }
  }
  async function toggleConfiguration(config: DeploymentConfiguration) {
    setBusy(true); setError("");
    try { await apiRequest<DeploymentConfiguration>(`/projects/${projectId}/deployment-configs/${config.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !config.enabled }) }); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update configuration"); }
    finally { setBusy(false); }
  }
  async function saveExecutionSettings(config: DeploymentConfiguration) {
    setBusy(true); setError("");
    try {
      await apiRequest<DeploymentConfiguration>(`/projects/${projectId}/deployment-configs/${config.id}`, { method: "PATCH", body: JSON.stringify({ executionAccount: executionAccount.trim() || null, repositorySshHostAlias: repositorySshHostAlias.trim() || null }) });
      setEditingConfigId(null); await reload(); setNotice("Execution settings saved. Review before preflight.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save execution settings"); }
    finally { setBusy(false); }
  }
  async function runPreflight(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice(""); setPreflight(null);
    try { const result = await apiRequest<PreflightResult>(`/projects/${projectId}/deployments/preflight`, { method: "POST", body: JSON.stringify({ configurationId, sourceRef }) }); setPreflight(result); setConfirmation(""); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Read-only preflight failed"); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!preflight || confirmation !== preflight.challenge || preflight.deployment.previousSha === preflight.deployment.targetSha) return;
    setBusy(true); setError("");
    try { const deployment = await apiRequest<DeploymentRecord>(`/projects/${projectId}/deployments/${preflight.deployment.id}/confirm`, { method: "POST", body: JSON.stringify({ challenge: confirmation }) }); setPreflight(null); await reload(); setNotice(`Deployment ${deployment.id} accepted. Open its detail to follow progress.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Deployment confirmation failed"); }
    finally { setBusy(false); }
  }

  return <main className="workspace"><div className="workspace-inner">
    <div className="topline"><Link href="/" className="brand">Investaplay DevOps</Link><Link href="/projects">Projects</Link></div>
    <div className="page-heading"><div><p className="eyebrow">Controlled deployments</p><h1>{project?.name ?? "Deployments"}</h1><p>Read-only preflight before a separately confirmed deployment</p></div></div>
    <nav className="project-nav"><Link href={`/projects/${projectId}`}>Overview &amp; environments</Link><Link href={`/projects/${projectId}/integrations`}>Integrations</Link><Link href={`/projects/${projectId}/github`}>GitHub</Link><Link href={`/projects/${projectId}/builds`}>Builds</Link><Link href={`/projects/${projectId}/servers`}>Servers</Link><Link href={`/projects/${projectId}/deployments`}>Deployments</Link></nav>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="panel" role="status">{notice}</p>}
    {canInitiate && <section className="panel"><h2>Read-only deployment preflight</h2><p>This checks the saved target and resolves the exact source revision. It does not change the server.</p>
      <form className="form-grid" onSubmit={runPreflight}><label>Deployment configuration<select required value={configurationId} onChange={(event) => setConfigurationId(event.target.value)}><option value="">Select configuration</option>{configurations.filter((item) => item.enabled).map((item) => <option value={item.id} key={item.id}>{environmentName(item.environmentId)} · {serverName(item.serverId)} · {repoName(item.githubIntegrationId)}</option>)}</select></label>
      <label>Configured branch<input value={sourceRef} readOnly /></label><button disabled={busy || !selectedConfig || !selectedConfig.enabled}>Run read-only preflight</button></form>
    </section>}
    {preflight && <section className="panel"><h2>Preflight result and deployment plan</h2><p>Review every target value before any mutation. Closing this page does not start deployment.</p>
      <dl className="details"><div><dt>Project</dt><dd>{project?.name}</dd></div><div><dt>Environment</dt><dd>{environmentName(preflight.deployment.environmentId)}</dd></div><div><dt>Server</dt><dd>{serverName(preflight.deployment.serverId)} ({servers.find((item) => item.id === preflight.deployment.serverId)?.instanceId})</dd></div><div><dt>Repository</dt><dd>{preflight.deployment.repositoryOwner}/{preflight.deployment.repositoryName}</dd></div><div><dt>Branch</dt><dd>{preflight.deployment.requestedRef}</dd></div><div><dt>Current SHA</dt><dd>{preflight.deployment.previousSha ?? "Unavailable"}</dd></div><div><dt>Target SHA</dt><dd>{preflight.deployment.targetSha}</dd></div><div><dt>Backend path</dt><dd>{preflight.deployment.configurationSnapshot.applicationPath}</dd></div><div><dt>Service</dt><dd>{preflight.deployment.configurationSnapshot.processManager}: {preflight.deployment.configurationSnapshot.serviceName}</dd></div><div><dt>Health endpoint</dt><dd>{preflight.deployment.configurationSnapshot.healthUrl}</dd></div></dl>
      <p>Plan: capture revision → fetch source → checkout target → configured install/build → restart named service → health check. Application database migrations are excluded.</p>
      {preflight.deployment.previousSha === preflight.deployment.targetSha ? <p className="alert">Current and target revisions match. Deployment is disabled; no restart is needed.</p> : <><p>To confirm, type this exact challenge: <strong>{preflight.challenge}</strong></p><label>Confirmation challenge<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label><div className="actions"><button disabled={busy || confirmation !== preflight.challenge} onClick={() => void confirm()}>Confirm controlled deployment</button><button className="secondary" onClick={() => setPreflight(null)}>Cancel</button></div></>}
    </section>}
    <section className="panel"><h2>Deployment configurations</h2>{configurations.length === 0 ? <p>No configurations yet.</p> : configurations.map((item) => <div className="environment-row" key={item.id}><div><strong>{environmentName(item.environmentId)} · {serverName(item.serverId)}</strong><p>{repoName(item.githubIntegrationId)} · {item.allowedBranch} · {item.enabled ? "Enabled" : "Disabled"}</p><p className="muted">{item.applicationPath} · {item.serviceName} · {item.healthUrl}</p><p className="muted">Execution account: {item.executionAccount ?? "Not set"}; SSH host alias: {item.repositorySshHostAlias ?? "None"}</p>{editingConfigId === item.id && <div className="form-grid"><label>Linux execution account<input value={executionAccount} onChange={(event) => setExecutionAccount(event.target.value)} placeholder="service-user" /></label><label>GitHub SSH host alias, if used<input value={repositorySshHostAlias} onChange={(event) => setRepositorySshHostAlias(event.target.value)} placeholder="github-app" /></label><button disabled={busy} onClick={() => void saveExecutionSettings(item)}>Save execution settings</button><button className="secondary" onClick={() => setEditingConfigId(null)}>Cancel</button></div>}</div>{isAdmin && <div className="actions"><button className="secondary" disabled={busy} onClick={() => { setEditingConfigId(item.id); setExecutionAccount(item.executionAccount ?? ""); setRepositorySshHostAlias(item.repositorySshHostAlias ?? ""); }}>Edit execution settings</button><button className="secondary" disabled={busy} onClick={() => void toggleConfiguration(item)}>{item.enabled ? "Disable" : "Enable"}</button></div>}</div>)}</section>
    {isAdmin && <section className="panel"><h2>Add deployment configuration</h2><p>Saved settings define the only allowed target. Start disabled and review before enabling.</p><form className="form-grid" onSubmit={saveConfiguration}>
      <label>Environment<select required value={form.environmentId} onChange={(event) => setForm({ ...form, environmentId: event.target.value, serverId: "" })}><option value="">Select environment</option>{environments.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name} ({item.type})</option>)}</select></label>
      <label>Mapped server<select required value={form.serverId} onChange={(event) => setForm({ ...form, serverId: event.target.value })}><option value="">Select server</option>{servers.filter((item) => item.environmentId === form.environmentId && item.enabled).map((item) => <option key={item.id} value={item.id}>{item.displayName} ({item.instanceId})</option>)}</select></label>
      <label>GitHub integration<select required value={form.githubIntegrationId} onChange={(event) => setForm({ ...form, githubIntegrationId: event.target.value, allowedBranch: String(integrations.find((item) => item.id === event.target.value)?.configuration?.defaultBranch ?? "") })}><option value="">Select repository</option>{integrations.filter((item) => item.provider === "github" && item.status !== "disabled").map((item) => <option key={item.id} value={item.id}>{repoName(item.id)}</option>)}</select></label>
      <label>Allowed branch<input required value={form.allowedBranch} onChange={(event) => setForm({ ...form, allowedBranch: event.target.value })} /></label>
      <label>Server repository path<input required placeholder="/srv/application" value={form.repositoryPath} onChange={(event) => setForm({ ...form, repositoryPath: event.target.value })} /></label>
      <label>Application path<input required placeholder="/srv/application/backend" value={form.applicationPath} onChange={(event) => setForm({ ...form, applicationPath: event.target.value })} /></label>
      <label>Linux execution account<input required placeholder="service-user" value={form.executionAccount ?? ""} onChange={(event) => setForm({ ...form, executionAccount: event.target.value || null })} /></label>
      <label>GitHub SSH host alias, if used<input placeholder="github-alias" value={form.repositorySshHostAlias ?? ""} onChange={(event) => setForm({ ...form, repositorySshHostAlias: event.target.value || null })} /></label>
      <label>Package manager<select value={form.packageManager} onChange={(event) => setForm({ ...form, packageManager: event.target.value as "none" | "npm", installStrategy: "none", buildStrategy: "none" })}><option value="none">None</option><option value="npm">npm</option></select></label>
      <label>Install strategy<select value={form.installStrategy} onChange={(event) => setForm({ ...form, installStrategy: event.target.value as "none" | "npm_ci" })}><option value="none">None</option>{form.packageManager === "npm" && <option value="npm_ci">npm ci</option>}</select></label>
      <label>Build strategy<select value={form.buildStrategy} onChange={(event) => setForm({ ...form, buildStrategy: event.target.value as "none" | "npm_build" })}><option value="none">None</option>{form.packageManager === "npm" && <option value="npm_build">npm run build</option>}</select></label>
      <label>Process manager<input value="pm2" readOnly /></label><label>Service name<input required value={form.serviceName} onChange={(event) => setForm({ ...form, serviceName: event.target.value })} /></label>
      <label>Local health URL<input required type="url" placeholder="http://127.0.0.1:4000/health" value={form.healthUrl} onChange={(event) => setForm({ ...form, healthUrl: event.target.value })} /></label>
      <label>Health timeout (seconds)<input required type="number" min={2} max={30} value={form.healthTimeoutSeconds} onChange={(event) => setForm({ ...form, healthTimeoutSeconds: Number(event.target.value) })} /></label>
      <p>Rollback: manual, using the captured previous SHA.</p><button disabled={busy}>Save disabled configuration</button></form></section>}
    <section className="panel"><h2>Deployment history</h2>{deployments.length === 0 ? <p>No deployments recorded.</p> : deployments.map((item) => <div className="environment-row" key={item.id}><div><strong><Link href={`/projects/${projectId}/deployments/${item.id}`}>{item.id}</Link></strong><p>{environmentName(item.environmentId)} · {serverName(item.serverId)} · {item.status.replaceAll("_", " ")}</p><p>{item.repositoryOwner}/{item.repositoryName} · {item.requestedRef} · {item.targetSha}</p><p className="muted">Requested by {item.requestedByUserId} · {new Date(item.requestedAt).toLocaleString()}</p></div></div>)}</section>
  </div></main>;
}
