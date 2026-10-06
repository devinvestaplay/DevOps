"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { BuildRecord, ExpoBuildInfo, ExpoProjectInfo, Integration, Project } from "@investaplay/devops-contracts";
import { apiRequest } from "../../../../lib/api";
import { useCurrentUser } from "../../../../components/auth-shell";

type BuildListing = { builds: ExpoBuildInfo[]; records: BuildRecord[] };

export default function BuildsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const user = useCurrentUser();
  const canBuild = user.role === "release_manager" || user.role === "admin";
  const [project, setProject] = useState<Project | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [selected, setSelected] = useState("");
  const [expoProject, setExpoProject] = useState<ExpoProjectInfo | null>(null);
  const [builds, setBuilds] = useState<ExpoBuildInfo[]>([]);
  const [records, setRecords] = useState<BuildRecord[]>([]);
  const [detail, setDetail] = useState<ExpoBuildInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const integration = integrations.find((item) => item.id === selected);

  useEffect(() => {
    void Promise.all([apiRequest<Project>(`/projects/${projectId}`), apiRequest<Integration[]>(`/projects/${projectId}/integrations`)]).then(([p, i]) => {
      setProject(p);
      const expo = i.filter((item) => item.provider === "expo" && item.environmentId === null && item.status !== "disabled");
      setIntegrations(expo); setSelected(expo[0]?.id ?? "");
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load project"));
  }, [projectId]);

  async function load(id: string) {
    setLoading(true);
    try {
      const query = `integrationId=${encodeURIComponent(id)}`;
      const [info, listing] = await Promise.all([
        apiRequest<ExpoProjectInfo>(`/projects/${projectId}/expo/project?${query}`),
        apiRequest<BuildListing>(`/projects/${projectId}/expo/builds?${query}&limit=20`),
      ]);
      setExpoProject(info); setBuilds(listing.builds); setRecords(listing.records); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load Expo builds"); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    if (!selected) return;
    void load(selected);
    const timer = window.setInterval(() => { void load(selected); }, 30000);
    return () => window.clearInterval(timer);
  }, [projectId, selected]);

  async function startPreview() {
    if (!integration || !project) return;
    const profile = String(integration.configuration?.previewProfile ?? "");
    if (!window.confirm(`Build Android Preview APK?\n\nProject: ${project.name}\nProfile: ${profile}\nSource: committed Git checkout\n\nThis uses EAS build resources.`)) return;
    setBusy(true);
    try {
      await apiRequest<BuildRecord>(`/projects/${projectId}/expo/builds/preview`, { method: "POST", body: JSON.stringify({ integrationId: integration.id }) });
      await load(integration.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start preview build"); }
    finally { setBusy(false); }
  }

  async function showBuild(id: string) {
    try {
      const data = await apiRequest<{ build: ExpoBuildInfo }>(`/projects/${projectId}/expo/builds/${id}?integrationId=${encodeURIComponent(selected)}`);
      setDetail(data.build); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load build details"); }
  }

  return <main className="workspace"><div className="workspace-inner">
    <div className="topline"><Link href="/" className="brand">Investaplay DevOps</Link><Link href="/projects">Projects</Link></div>
    <div className="page-heading"><div><p className="eyebrow">Expo / EAS</p><h1>{project?.name ?? "Builds"}</h1><p>Project builds and Android Preview APK requests</p></div></div>
    <nav className="project-nav"><Link href={`/projects/${projectId}`}>Overview &amp; environments</Link><Link href={`/projects/${projectId}/integrations`}>Integrations</Link><Link href={`/projects/${projectId}/github`}>GitHub</Link><Link href={`/projects/${projectId}/builds`}>Builds</Link><Link href={`/projects/${projectId}/servers`}>Servers</Link><Link href={`/projects/${projectId}/deployments`}>Deployments</Link></nav>
    {error && <p className="alert" role="alert">{error}</p>}
    {integrations.length === 0 ? <section className="panel empty"><h2>No Expo integration configured</h2><p>Add a project-level Expo/EAS integration to view builds.</p></section> : <section className="panel"><div className="section-heading"><h2>Expo connection</h2><span className={`badge ${integration?.status ?? ""}`}>{integration?.lastVerificationResult === "connected" ? "Connected" : integration?.lastVerificationResult === "error" ? "Error" : "Not tested"}</span></div>
      <label>Integration<select value={selected} onChange={(event) => { setSelected(event.target.value); setExpoProject(null); setBuilds([]); setRecords([]); setDetail(null); }}>{integrations.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      <p>{expoProject ? `${expoProject.account}/${expoProject.slug}` : `${String(integration?.configuration?.expoAccount ?? "")}/${String(integration?.configuration?.projectSlug ?? "")}`}</p>
      <p className="muted">EAS project ID: {expoProject?.projectId ?? String(integration?.configuration?.projectId ?? "")}<br />Preview profile: {String(integration?.configuration?.previewProfile ?? "")}</p>
      {canBuild && project?.status === "active" && integration && <button disabled={busy || loading || !expoProject?.androidEnabled} onClick={() => void startPreview()}>Build Preview APK</button>}
    </section>}
    {loading && <p className="panel">Refreshing EAS builds…</p>}
    {selected && <><section className="panel"><h2>Recent EAS builds</h2>{builds.length === 0 ? <p>No builds returned.</p> : builds.map((build) => <div className="environment-row" key={build.id}><div><strong>{build.platform.toUpperCase()} · {build.profile ?? "Unknown profile"}</strong><p><span className={`badge ${build.status}`}>{build.status.replaceAll("_", " ")}</span> · Version {build.appVersion ?? "—"} ({build.appBuildVersion ?? "—"})</p><p className="muted">Commit {build.gitCommitSha?.slice(0, 12) ?? "Unavailable"} · Created {new Date(build.createdAt).toLocaleString()} · Completed {build.completedAt ? new Date(build.completedAt).toLocaleString() : "Pending"}</p><p>Artifact: {build.artifactAvailable ? "Available" : "Unavailable"}{build.errorCode ? ` · ${build.errorCode}` : ""}</p></div><button className="secondary" onClick={() => void showBuild(build.id)}>Details</button></div>)}</section>
      <section className="panel"><h2>Panel build requests</h2>{records.length === 0 ? <p>No preview builds requested through this panel.</p> : records.map((record) => <div className="environment-row" key={record.id}><div><strong>Android · {record.profile}</strong><p>{record.status.replaceAll("_", " ")} · EAS ID {record.externalBuildId ?? "Pending"}</p><p className="muted">Requested by {record.requestedByUserId ?? "Unknown"} · {new Date(record.requestedAt).toLocaleString()} · Source {record.gitCommitSha?.slice(0, 12) ?? "Unavailable"}</p><p>Artifact: {record.artifactAvailable ? "Available" : "Unavailable"}{record.errorCode ? ` · ${record.errorCode}` : ""}</p></div></div>)}</section>
      {detail && <section className="panel"><h2>Build detail</h2><dl className="details"><div><dt>ID</dt><dd>{detail.id}</dd></div><div><dt>Status</dt><dd>{detail.status}</dd></div><div><dt>Provider status</dt><dd>{detail.providerStatus}</dd></div><div><dt>Artifact</dt><dd>{detail.artifactAvailable ? "Available" : "Unavailable"}</dd></div></dl></section>}
    </>}
  </div></main>;
}
