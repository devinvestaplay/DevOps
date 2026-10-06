"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { createProjectSchema, type Project } from "@investaplay/devops-contracts";
import { apiRequest } from "../../lib/api";
import { useCurrentUser } from "../../components/auth-shell";

export default function ProjectsPage() {
  const user = useCurrentUser();
  const isAdmin = user.role === "admin";
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");

  async function load() {
    try {
      setError("");
      setProjects(await apiRequest<Project[]>("/projects"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load projects");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function addProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = createProjectSchema.safeParse({ name, slug, description });
    if (!result.success) { setError("Enter a name and a lowercase slug using letters, numbers, and hyphens."); return; }
    setSaving(true);
    setError("");
    try {
      await apiRequest<Project>("/projects", { method: "POST", body: JSON.stringify(result.data) });
      setName(""); setSlug(""); setDescription(""); setShowForm(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create project");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="workspace">
      <div className="workspace-inner">
        <div className="topline"><Link href="/" className="brand">Investaplay DevOps</Link><span>Project Management</span></div>
        <div className="page-heading"><div><p className="eyebrow">Workspace</p><h1>Projects</h1><p>Manage independent projects and their environments.</p></div>{isAdmin && <button onClick={() => setShowForm(!showForm)}>Add Project</button>}</div>
        {error && <p className="alert" role="alert">{error}</p>}
        {isAdmin && showForm && <form className="panel form-grid" onSubmit={addProject}>
          <h2>New project</h2>
          <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
          <label>Slug<input value={slug} onChange={(event) => setSlug(event.target.value)} required maxLength={80} placeholder="my-project" /></label>
          <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={3} /></label>
          <div className="actions"><button disabled={saving} type="submit">{saving ? "Saving…" : "Create project"}</button><button type="button" className="secondary" onClick={() => setShowForm(false)}>Cancel</button></div>
        </form>}
        {loading ? <p className="panel">Loading projects…</p> : projects.length === 0 ? (
          <section className="panel empty"><h2>No projects configured</h2><p>Add your first project to start managing builds and deployments.</p>{isAdmin && <button onClick={() => setShowForm(true)}>Add Project</button>}</section>
        ) : <div className="project-list">{projects.map((project) => <Link className="panel project-row" key={project.id} href={`/projects/${project.id}`}><div><h2>{project.name}</h2><p>{project.description || project.slug}</p></div><span className={`badge ${project.status}`}>{project.status}</span></Link>)}</div>}
      </div>
    </main>
  );
}
