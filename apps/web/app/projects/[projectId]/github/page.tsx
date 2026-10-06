"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Integration, Project } from "@investaplay/devops-contracts";
import { apiRequest } from "../../../../lib/api";

type Repository = { repository: string; defaultBranch: string; private: boolean; url: string };
type Branch = { name: string; sha: string };
type Commit = { sha: string; message: string; author: string | null; timestamp: string | null };
type PullRequest = { number: number; title: string; state: string; head: string; base: string };
type WorkflowRun = { name: string | null; status: string; conclusion: string | null; branch: string | null; sha: string; timestamp: string };

export default function GitHubPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [selected, setSelected] = useState("");
  const [repository, setRepository] = useState<Repository | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [pullRequests, setPullRequests] = useState<PullRequest[]>([]);
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([apiRequest<Project>(`/projects/${projectId}`), apiRequest<Integration[]>(`/projects/${projectId}/integrations`)]).then(([p, i]) => {
      setProject(p); const github = i.filter((entry) => entry.provider === "github" && entry.environmentId === null && entry.status !== "disabled");
      setIntegrations(github); setSelected(github[0]?.id ?? "");
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load project"));
  }, [projectId]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true); setError(""); setRepository(null); setBranches([]); setCommits([]); setPullRequests([]); setWorkflowRuns([]);
    const path = (kind: string) => `/projects/${projectId}/github/${kind}?integrationId=${encodeURIComponent(selected)}&perPage=10`;
    void Promise.all([
      apiRequest<Repository>(path("repository")), apiRequest<Branch[]>(path("branches")), apiRequest<Commit[]>(path("commits")),
      apiRequest<PullRequest[]>(path("pull-requests")), apiRequest<WorkflowRun[]>(path("workflow-runs")),
    ]).then(([r, b, c, p, w]) => { if (!cancelled) { setRepository(r); setBranches(b); setCommits(c); setPullRequests(p); setWorkflowRuns(w); } })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load GitHub data"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, selected]);

  return <main className="workspace"><div className="workspace-inner">
    <div className="topline"><Link href="/" className="brand">Investaplay DevOps</Link><Link href="/projects">Projects</Link></div>
    <div className="page-heading"><div><p className="eyebrow">GitHub</p><h1>{project?.name ?? "Repository"}</h1><p>Read-only repository activity</p></div></div>
    <nav className="project-nav"><Link href={`/projects/${projectId}`}>Overview &amp; environments</Link><Link href={`/projects/${projectId}/integrations`}>Integrations</Link><Link href={`/projects/${projectId}/github`}>GitHub</Link><Link href={`/projects/${projectId}/builds`}>Builds</Link><Link href={`/projects/${projectId}/servers`}>Servers</Link><Link href={`/projects/${projectId}/deployments`}>Deployments</Link></nav>
    {integrations.length === 0 ? <section className="panel empty"><h2>No project-level GitHub integration</h2><p>Configure a GitHub App integration for this project to view repository activity.</p></section> : <label className="panel">Repository integration<select value={selected} onChange={(event) => setSelected(event.target.value)}>{integrations.map((integration) => <option key={integration.id} value={integration.id}>{integration.displayName}</option>)}</select></label>}
    {error && <p className="alert" role="alert">{error}</p>}{loading && <p className="panel">Loading GitHub data…</p>}
    {repository && <><section className="panel"><h2>Repository</h2><dl className="details"><div><dt>Name</dt><dd>{repository.repository}</dd></div><div><dt>Default branch</dt><dd>{repository.defaultBranch}</dd></div><div><dt>Visibility</dt><dd>{repository.private ? "Private" : "Public"}</dd></div></dl></section>
      <section className="panel"><h2>Latest commits</h2>{commits.length ? commits.map((entry) => <div className="environment-row" key={entry.sha}><div><strong>{entry.message.split("\n")[0]}</strong><p>{entry.sha.slice(0, 12)} · {entry.author ?? "Unknown author"} · {entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "Unknown date"}</p></div></div>) : <p>No recent commits.</p>}</section>
      <section className="panel"><h2>Branches</h2>{branches.length ? branches.map((entry) => <div className="environment-row" key={entry.name}><strong>{entry.name}</strong><span className="muted">{entry.sha.slice(0, 12)}</span></div>) : <p>No branches returned.</p>}</section>
      <section className="panel"><h2>Open pull requests</h2>{pullRequests.length ? pullRequests.map((entry) => <div className="environment-row" key={entry.number}><div><strong>#{entry.number} {entry.title}</strong><p>{entry.head} → {entry.base} · {entry.state}</p></div></div>) : <p>No open pull requests.</p>}</section>
      <section className="panel"><h2>Workflow runs</h2>{workflowRuns.length ? workflowRuns.map((entry, index) => <div className="environment-row" key={`${entry.sha}-${index}`}><div><strong>{entry.name ?? "Workflow"}</strong><p>{entry.branch ?? "Unknown branch"} · {entry.status}{entry.conclusion ? ` / ${entry.conclusion}` : ""} · {new Date(entry.timestamp).toLocaleString()}</p></div></div>) : <p>No recent workflow runs.</p>}</section>
    </>}
  </div></main>;
}
