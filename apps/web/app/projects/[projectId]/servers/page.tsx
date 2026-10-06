"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { AwsAction, AwsCommandRecord, AwsServer, AwsServerStatus, Environment, Integration, Project } from "@investaplay/devops-contracts";
import { apiRequest } from "../../../../lib/api";
import { useCurrentUser } from "../../../../components/auth-shell";

const actions: { id: AwsAction; label: string }[] = [
  { id: "server_identity", label: "Check server identity" },
  { id: "disk_usage", label: "Check disk usage" },
  { id: "memory_usage", label: "Check memory usage" },
];

export default function ServersPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const user = useCurrentUser();
  const isAdmin = user.role === "admin";
  const canRun = isAdmin || user.role === "release_manager";
  const [project, setProject] = useState<Project | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [servers, setServers] = useState<AwsServer[]>([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState<AwsServerStatus | null>(null);
  const [commands, setCommands] = useState<AwsCommandRecord[]>([]);
  const [activeCommand, setActiveCommand] = useState<AwsCommandRecord | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("backend");
  const [environmentId, setEnvironmentId] = useState("");
  const [integrationId, setIntegrationId] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [managedInstanceId, setManagedInstanceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedServer = servers.find((server) => server.id === selected);

  async function loadBase() {
    const [p, e, i, s] = await Promise.all([
      apiRequest<Project>(`/projects/${projectId}`), apiRequest<Environment[]>(`/projects/${projectId}/environments`),
      apiRequest<Integration[]>(`/projects/${projectId}/integrations`), apiRequest<AwsServer[]>(`/projects/${projectId}/aws/servers`),
    ]);
    setProject(p); setEnvironments(e); setIntegrations(i.filter((item) => item.provider === "aws" && item.status !== "disabled"));
    setServers(s); setSelected((current) => current || s[0]?.id || "");
  }
  useEffect(() => { void loadBase().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load servers")); }, [projectId]);

  async function loadServer(id: string) {
    const history = await apiRequest<AwsCommandRecord[]>(`/projects/${projectId}/aws/servers/${id}/commands`);
    setCommands(history);
    try { setStatus(await apiRequest<AwsServerStatus>(`/projects/${projectId}/aws/servers/${id}`)); setError(""); }
    catch (cause) { setStatus(null); setError(cause instanceof Error ? cause.message : "Could not load AWS status"); }
  }
  useEffect(() => { if (selected) void loadServer(selected); }, [projectId, selected]);

  useEffect(() => {
    if (!activeCommand || !["queued", "in_progress"].includes(activeCommand.status)) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts++;
      if (attempts > 24) { window.clearInterval(timer); return; }
      void apiRequest<AwsCommandRecord>(`/projects/${projectId}/aws/commands/${activeCommand.id}`).then((record) => {
        setActiveCommand(record);
        setCommands((current) => [record, ...current.filter((item) => item.id !== record.id)]);
      }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not refresh command"));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [projectId, activeCommand?.id, activeCommand?.status]);

  async function addServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    try {
      await apiRequest<AwsServer>(`/projects/${projectId}/aws/servers`, { method: "POST", body: JSON.stringify({ displayName, role, environmentId, integrationId, instanceId, ...(managedInstanceId ? { managedInstanceId } : {}) }) });
      setDisplayName(""); setInstanceId(""); setManagedInstanceId(""); await loadBase(); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not map server"); }
    finally { setBusy(false); }
  }
  async function runAction(action: AwsAction) {
    if (!project || !selectedServer) return;
    const environment = environments.find((item) => item.id === selectedServer.environmentId)?.name ?? selectedServer.environmentId;
    if (!window.confirm(`Run read-only diagnostic?\n\nProject: ${project.name}\nEnvironment: ${environment}\nServer: ${selectedServer.displayName} (${selectedServer.instanceId})\nAction: ${action}`)) return;
    setBusy(true);
    try {
      const record = await apiRequest<AwsCommandRecord>(`/projects/${projectId}/aws/servers/${selectedServer.id}/actions`, { method: "POST", body: JSON.stringify({ action }) });
      setActiveCommand(record); setCommands((current) => [record, ...current]); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Diagnostic request failed"); }
    finally { setBusy(false); }
  }

  return <main className="workspace"><div className="workspace-inner">
    <div className="topline"><Link href="/" className="brand">Investaplay DevOps</Link><Link href="/projects">Projects</Link></div>
    <div className="page-heading"><div><p className="eyebrow">Infrastructure</p><h1>{project?.name ?? "Servers"}</h1><p>Mapped EC2 resources and controlled SSM diagnostics</p></div></div>
    <nav className="project-nav"><Link href={`/projects/${projectId}`}>Overview &amp; environments</Link><Link href={`/projects/${projectId}/integrations`}>Integrations</Link><Link href={`/projects/${projectId}/github`}>GitHub</Link><Link href={`/projects/${projectId}/builds`}>Builds</Link><Link href={`/projects/${projectId}/servers`}>Servers</Link><Link href={`/projects/${projectId}/deployments`}>Deployments</Link></nav>
    {error && <p className="alert" role="alert">{error}</p>}
    <section className="panel"><h2>Mapped servers</h2>{servers.length === 0 ? <p>No servers mapped. An Admin can add a project environment, AWS integration, and server mapping.</p> : <div className="environment-list">{servers.map((server) => <button className="environment-row" key={server.id} onClick={() => setSelected(server.id)}><span><strong>{server.displayName}</strong><br />{environments.find((item) => item.id === server.environmentId)?.name ?? "Environment"} · {server.region} · {server.instanceId}</span><span>{server.id === selected ? "Selected" : "View"}</span></button>)}</div>}</section>
    {isAdmin && project?.status === "active" && <section className="panel"><h2>Map an EC2 server</h2><form className="form-grid" onSubmit={addServer}>
      <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={120} /></label>
      <label>Role<input value={role} onChange={(event) => setRole(event.target.value)} required maxLength={80} placeholder="backend" /></label>
      <label>Environment<select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)} required><option value="">Select environment</option>{environments.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>AWS integration<select value={integrationId} onChange={(event) => setIntegrationId(event.target.value)} required><option value="">Select integration</option>{integrations.map((item) => <option key={item.id} value={item.id}>{item.displayName} ({String(item.configuration?.region ?? "")})</option>)}</select></label>
      <label>EC2 instance ID<input value={instanceId} onChange={(event) => setInstanceId(event.target.value)} required placeholder="i-..." /></label>
      <label>SSM managed ID, if different<input value={managedInstanceId} onChange={(event) => setManagedInstanceId(event.target.value)} placeholder="i-... or mi-..." /></label>
      <button disabled={busy}>Save server mapping</button>
    </form></section>}
    {selectedServer && <><section className="panel"><h2>{selectedServer.displayName}</h2><p>Environment: {environments.find((item) => item.id === selectedServer.environmentId)?.name ?? selectedServer.environmentId}<br />Region: {selectedServer.region}<br />EC2 instance: {selectedServer.instanceId}<br />SSM target: {selectedServer.managedInstanceId}</p>
      {status && <dl className="details"><div><dt>EC2 state</dt><dd>{status.ec2?.state ?? "Unavailable"}</dd></div><div><dt>Instance type</dt><dd>{status.ec2?.instanceType ?? "Unavailable"}</dd></div><div><dt>SSM managed</dt><dd>{status.ssm.managed ? "Yes" : "No"}</dd></div><div><dt>SSM ping</dt><dd>{status?.ssm.pingStatus ?? "Unavailable"}</dd></div><div><dt>Platform</dt><dd>{status.ssm.platform ?? "Unavailable"}</dd></div><div><dt>Agent</dt><dd>{status.ssm.agentVersion ?? "Unavailable"}</dd></div><div><dt>Last ping</dt><dd>{status.ssm.lastPingAt ? new Date(status.ssm.lastPingAt).toLocaleString() : "Unavailable"}</dd></div></dl>}
      {canRun && <div className="actions">{actions.map((action) => <button key={action.id} disabled={busy || !selectedServer.enabled || status?.ec2?.state !== "running" || status?.ssm.pingStatus !== "Online" || status?.ssm.platform !== "Linux"} onClick={() => void runAction(action.id)}>{action.label}</button>)}</div>}
    </section><section className="panel"><h2>Diagnostic history</h2>{commands.length === 0 ? <p>No diagnostic commands recorded.</p> : commands.map((command) => <div className="environment-row" key={command.id}><div><strong>{command.action.replaceAll("_", " ")}</strong><p>{command.status.replaceAll("_", " ")} · SSM ID {command.externalCommandId ?? "Pending"}</p><p className="muted">Requested by {command.requestedByUserId} · {new Date(command.requestedAt).toLocaleString()}</p>{command.sanitizedOutput && <pre>{command.sanitizedOutput}</pre>}{command.sanitizedError && <p>{command.sanitizedError}</p>}</div></div>)}</section></>}
  </div></main>;
}
