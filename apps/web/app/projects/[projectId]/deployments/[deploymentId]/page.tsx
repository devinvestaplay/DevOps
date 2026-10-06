"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { AwsServer, DeploymentRecord, DeploymentStepRecord, Environment, Project } from "@investaplay/devops-contracts";
import { apiRequest } from "../../../../../lib/api";

type Detail = { deployment: DeploymentRecord; steps: DeploymentStepRecord[] };
const terminal = new Set(["succeeded", "failed", "rolled_back", "rollback_failed", "canceled"]);

export default function DeploymentDetailPage() {
  const { projectId, deploymentId } = useParams<{ projectId: string; deploymentId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [server, setServer] = useState<AwsServer | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let closed = false;
    void Promise.all([
      apiRequest<Project>(`/projects/${projectId}`), apiRequest<Environment[]>(`/projects/${projectId}/environments`),
      apiRequest<AwsServer[]>(`/projects/${projectId}/aws/servers`), apiRequest<Detail>(`/projects/${projectId}/deployments/${deploymentId}`),
    ]).then(([p, environments, servers, value]) => {
      if (closed) return;
      setProject(p); setDetail(value);
      setEnvironment(environments.find((item) => item.id === value.deployment.environmentId) ?? null);
      setServer(servers.find((item) => item.id === value.deployment.serverId) ?? null);
    }).catch((cause) => { if (!closed) setError(cause instanceof Error ? cause.message : "Could not load deployment"); });
    return () => { closed = true; };
  }, [projectId, deploymentId]);

  useEffect(() => {
    if (!detail || terminal.has(detail.deployment.status)) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts++;
      if (attempts > 120) { window.clearInterval(timer); return; }
      void apiRequest<Detail>(`/projects/${projectId}/deployments/${deploymentId}`).then(setDetail).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not refresh deployment"));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [projectId, deploymentId, detail?.deployment.status]);

  const deployment = detail?.deployment;
  return <main className="workspace"><div className="workspace-inner">
    <div className="topline"><Link href="/" className="brand">Investaplay DevOps</Link><Link href={`/projects/${projectId}/deployments`}>Deployments</Link></div>
    <div className="page-heading"><div><p className="eyebrow">Deployment detail</p><h1>{project?.name ?? "Deployment"}</h1><p>{deployment?.id ?? deploymentId}</p></div></div>
    <nav className="project-nav"><Link href={`/projects/${projectId}`}>Overview &amp; environments</Link><Link href={`/projects/${projectId}/integrations`}>Integrations</Link><Link href={`/projects/${projectId}/github`}>GitHub</Link><Link href={`/projects/${projectId}/builds`}>Builds</Link><Link href={`/projects/${projectId}/servers`}>Servers</Link><Link href={`/projects/${projectId}/deployments`}>Deployments</Link></nav>
    {error && <p className="alert" role="alert">{error}</p>}
    {!detail && !error && <section className="panel">Loading deployment…</section>}
    {deployment && <><section className="panel"><h2>Summary</h2><dl className="details">
      <div><dt>Status</dt><dd>{deployment.status.replaceAll("_", " ")}</dd></div>
      <div><dt>Project</dt><dd>{project?.name ?? deployment.projectId}</dd></div>
      <div><dt>Environment</dt><dd>{environment?.name ?? deployment.environmentId}</dd></div>
      <div><dt>Server</dt><dd>{server?.displayName ?? deployment.serverId} {server?.instanceId && `(${server.instanceId})`}</dd></div>
      <div><dt>Repository</dt><dd>{deployment.repositoryOwner}/{deployment.repositoryName}</dd></div>
      <div><dt>Requested branch</dt><dd>{deployment.requestedRef}</dd></div>
      <div><dt>Previous SHA</dt><dd>{deployment.previousSha ?? "Unavailable"}</dd></div>
      <div><dt>Target SHA</dt><dd>{deployment.targetSha}</dd></div>
      <div><dt>Application path</dt><dd>{deployment.configurationSnapshot.applicationPath}</dd></div>
      <div><dt>Service</dt><dd>{deployment.configurationSnapshot.processManager}: {deployment.configurationSnapshot.serviceName}</dd></div>
      <div><dt>Health endpoint</dt><dd>{deployment.configurationSnapshot.healthUrl}</dd></div>
      <div><dt>Requested by</dt><dd>{deployment.requestedByUserId}</dd></div>
      <div><dt>Requested</dt><dd>{new Date(deployment.requestedAt).toLocaleString()}</dd></div>
      <div><dt>Started</dt><dd>{deployment.startedAt ? new Date(deployment.startedAt).toLocaleString() : "—"}</dd></div>
      <div><dt>Completed</dt><dd>{deployment.completedAt ? new Date(deployment.completedAt).toLocaleString() : "—"}</dd></div>
    </dl>{deployment.sanitizedError && <p className="alert">{deployment.sanitizedError}</p>}</section>
    <section className="panel"><h2>Post-deployment health result</h2><p>Preflight health is recorded in the step timeline. HTTP status: {deployment.healthHttpStatus ?? "Not checked"} · Latency: {deployment.healthLatencyMs ?? "—"} ms · Checked: {deployment.healthCheckedAt ? new Date(deployment.healthCheckedAt).toLocaleString() : "—"}</p>{deployment.healthResponse && <pre>{deployment.healthResponse}</pre>}</section>
    <section className="panel"><h2>Step timeline</h2>{detail.steps.length === 0 ? <p>No steps recorded yet.</p> : detail.steps.slice().sort((a, b) => a.sequence - b.sequence).map((step) => <div className="environment-row" key={step.id}><div><strong>{step.sequence}. {step.stepType.replaceAll("_", " ")} — {step.status.replaceAll("_", " ")}</strong><p className="muted">Started: {step.startedAt ? new Date(step.startedAt).toLocaleString() : "—"} · Completed: {step.completedAt ? new Date(step.completedAt).toLocaleString() : "—"}</p>{step.externalCommandId && <p>SSM Command ID: {step.externalCommandId}</p>}{step.exitCode !== null && <p>Exit code: {step.exitCode}</p>}{step.sanitizedOutput && <pre>{step.sanitizedOutput}</pre>}{step.sanitizedError && <p className="alert">{step.sanitizedError}</p>}</div></div>)}</section>
    <section className="panel"><h2>Rollback state</h2><p>{deployment.status.startsWith("rollback") || deployment.status === "rolled_back" ? deployment.status.replaceAll("_", " ") : "No rollback started."} Previous revision: {deployment.previousSha ?? "Unavailable"}. Rollback requires a separate controlled decision.</p></section></>}
  </div></main>;
}
