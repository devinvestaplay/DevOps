"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  createEnvironmentSchema, updateProjectSchema,
  type Environment, type EnvironmentType, type Project,
} from "@investaplay/devops-contracts";
import { apiRequest } from "../../../lib/api";
import { useCurrentUser } from "../../../components/auth-shell";

const types: EnvironmentType[] = ["development", "staging", "production"];

export default function ProjectDetailPage() {
  const user = useCurrentUser();
  const isAdmin = user.role === "admin";
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [environmentName, setEnvironmentName] = useState("");
  const [environmentType, setEnvironmentType] = useState<EnvironmentType>("development");

  async function load() {
    try {
      setError("");
      const [nextProject, nextEnvironments] = await Promise.all([
        apiRequest<Project>(`/projects/${projectId}`),
        apiRequest<Environment[]>(`/projects/${projectId}/environments`),
      ]);
      setProject(nextProject);
      setEnvironments(nextEnvironments);
      setName(nextProject.name); setSlug(nextProject.slug); setDescription(nextProject.description);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load project");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [projectId]);

  async function saveProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = updateProjectSchema.safeParse({ name, slug, description });
    if (!result.success) { setError("Enter a valid name and lowercase slug."); return; }
    setSaving(true);
    try {
      const updated = await apiRequest<Project>(`/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(result.data) });
      setProject(updated); setEditing(false); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update project"); }
    finally { setSaving(false); }
  }

  async function setProjectStatus(status: "active" | "archived") {
    if (status === "archived" && !window.confirm("Archive this project? Its environments will remain available for viewing.")) return;
    setSaving(true);
    try {
      const updated = status === "archived"
        ? await apiRequest<Project>(`/projects/${projectId}`, { method: "DELETE" })
        : await apiRequest<Project>(`/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setProject(updated); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change project status"); }
    finally { setSaving(false); }
  }

  async function addEnvironment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = createEnvironmentSchema.safeParse({ name: environmentName, type: environmentType });
    if (!result.success) { setError("Enter a valid environment name."); return; }
    setSaving(true);
    try {
      await apiRequest<Environment>(`/projects/${projectId}/environments`, { method: "POST", body: JSON.stringify(result.data) });
      setEnvironmentName(""); setError("");
      setEnvironments(await apiRequest<Environment[]>(`/projects/${projectId}/environments`));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create environment"); }
    finally { setSaving(false); }
  }

  async function toggleEnvironment(environment: Environment) {
    setSaving(true);
    try {
      const status = environment.status === "active" ? "disabled" : "active";
      const updated = await apiRequest<Environment>(`/projects/${projectId}/environments/${environment.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setEnvironments((current) => current.map((item) => item.id === updated.id ? updated : item));
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update environment"); }
    finally { setSaving(false); }
  }

  return <main className="workspace"><div className="workspace-inner">
    <div className="topline"><Link href="/" className="brand">Investaplay DevOps</Link><Link href="/projects">Projects</Link></div>
    {error && <p className="alert" role="alert">{error}</p>}
    {loading ? <p className="panel">Loading project…</p> : !project ? <p className="panel">Project unavailable.</p> : <>
      <div className="page-heading"><div><p className="eyebrow">Project</p><h1>{project.name}</h1><p>{project.description || "No description"}</p></div><span className={`badge ${project.status}`}>{project.status}</span></div>
      <nav className="project-nav"><Link href={`/projects/${projectId}`}>Overview &amp; environments</Link><Link href={`/projects/${projectId}/integrations`}>Integrations</Link><Link href={`/projects/${projectId}/github`}>GitHub</Link><Link href={`/projects/${projectId}/builds`}>Builds</Link><Link href={`/projects/${projectId}/servers`}>Servers</Link><Link href={`/projects/${projectId}/deployments`}>Deployments</Link></nav>
      <section className="panel"><div className="section-heading"><h2>Details</h2>{isAdmin && <div className="actions"><button className="secondary" onClick={() => setEditing(!editing)} disabled={saving || project.status === "archived"}>Edit</button><button className="secondary" onClick={() => void setProjectStatus(project.status === "active" ? "archived" : "active")} disabled={saving}>{project.status === "active" ? "Archive" : "Restore"}</button></div>}</div>
        {editing ? <form className="form-grid" onSubmit={saveProject}><label>Name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label><label>Slug<input value={slug} onChange={(event) => setSlug(event.target.value)} required maxLength={80} /></label><label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={3} /></label><div className="actions"><button disabled={saving}>Save changes</button><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button></div></form> : <dl className="details"><div><dt>Slug</dt><dd>{project.slug}</dd></div><div><dt>Status</dt><dd>{project.status}</dd></div><div><dt>Created</dt><dd>{new Date(project.createdAt).toLocaleString()}</dd></div></dl>}
      </section>
      <section className="panel"><div className="section-heading"><h2>Environments</h2><span>{environments.length} configured</span></div>
        {environments.length === 0 ? <p>No environments configured yet.</p> : <div className="environment-list">{environments.map((environment) => <div className="environment-row" key={environment.id}><div><strong>{environment.name}</strong><p>{environment.type}</p></div><div className="actions"><span className={`badge ${environment.status}`}>{environment.status}</span>{isAdmin && project.status === "active" && <button className="secondary" disabled={saving} onClick={() => void toggleEnvironment(environment)}>{environment.status === "active" ? "Disable" : "Enable"}</button>}</div></div>)}</div>}
        {isAdmin && project.status === "active" && <form className="environment-form" onSubmit={addEnvironment}><label>Name<input value={environmentName} onChange={(event) => setEnvironmentName(event.target.value)} required maxLength={120} placeholder="Development" /></label><label>Type<select value={environmentType} onChange={(event) => setEnvironmentType(event.target.value as EnvironmentType)}>{types.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><button disabled={saving}>Add environment</button></form>}
      </section>
    </>}
  </div></main>;
}
