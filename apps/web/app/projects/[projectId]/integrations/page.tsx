"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { type Environment, type Integration, type IntegrationProvider, type Project, type SecretReference } from "@investaplay/devops-contracts";
import { apiRequest } from "../../../../lib/api";
import { useCurrentUser } from "../../../../components/auth-shell";

const providers: { id: IntegrationProvider; label: string }[] = [
  { id: "github", label: "GitHub" }, { id: "expo", label: "Expo / EAS" }, { id: "aws", label: "AWS" },
];
const fields: Record<IntegrationProvider, { name: string; label: string; placeholder?: string }[]> = {
  github: [{ name: "owner", label: "Owner" }, { name: "repository", label: "Repository" }, { name: "defaultBranch", label: "Default branch" }, { name: "repositoryType", label: "Repository type (frontend, backend, monorepo, other)" }, { name: "appId", label: "GitHub App ID" }, { name: "installationId", label: "Installation ID" }],
  expo: [{ name: "expoAccount", label: "Expo account" }, { name: "projectSlug", label: "Project slug" }, { name: "projectId", label: "Expo project UUID" }, { name: "workingDirectory", label: "Directory relative to EXPO_PROJECTS_ROOT" }, { name: "previewProfile", label: "Preview APK profile" }, { name: "productionProfile", label: "Production profile (guard only)" }],
  aws: [{ name: "region", label: "Region" }, { name: "accountId", label: "AWS account ID" }, { name: "controlStrategy", label: "Control strategy (ssm or manual)" }],
};

export default function IntegrationsPage() {
  const user = useCurrentUser();
  const isAdmin = user.role === "admin";
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [references, setReferences] = useState<SecretReference[]>([]);
  const [provider, setProvider] = useState<IntegrationProvider>("github");
  const [displayName, setDisplayName] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [secretReferenceId, setSecretReferenceId] = useState("");
  const [configuration, setConfiguration] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [addingReference, setAddingReference] = useState(false);
  const [editingReferenceFor, setEditingReferenceFor] = useState<string | null>(null);
  const [selectedReferenceId, setSelectedReferenceId] = useState("");
  const [referenceName, setReferenceName] = useState("");
  const [referencePurpose, setReferencePurpose] = useState("");
  const [referenceType, setReferenceType] = useState<"environment_variable" | "aws_secrets_manager" | "aws_ssm_parameter">("environment_variable");
  const [referenceKey, setReferenceKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function load() {
    try {
      const [p, e, i, r] = await Promise.all([
        apiRequest<Project>(`/projects/${projectId}`),
        apiRequest<Environment[]>(`/projects/${projectId}/environments`),
        apiRequest<Integration[]>(`/projects/${projectId}/integrations`),
        isAdmin ? apiRequest<SecretReference[]>(`/projects/${projectId}/secret-references`) : Promise.resolve([]),
      ]);
      setProject(p); setEnvironments(e); setIntegrations(i); setReferences(r); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load integrations"); }
  }
  useEffect(() => { void load(); }, [projectId]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    try {
      await apiRequest<Integration>(`/projects/${projectId}/integrations`, {
        method: "POST", body: JSON.stringify({ provider, displayName, environmentId: environmentId || null,
          secretReferenceId: secretReferenceId || null, configuration }),
      });
      setAdding(false); setConfiguration({}); setDisplayName(""); setEnvironmentId(""); setSecretReferenceId("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add integration"); }
    finally { setBusy(false); }
  }
  async function disable(id: string) {
    setBusy(true);
    try { await apiRequest<Integration>(`/projects/${projectId}/integrations/${id}`, { method: "DELETE" }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not disable integration"); }
    finally { setBusy(false); }
  }
  async function attachReference(id: string) {
    if (!selectedReferenceId) { setError("Select an Expo secret reference first"); return; }
    setBusy(true);
    try {
      await apiRequest<Integration>(`/projects/${projectId}/integrations/${id}`, {
        method: "PATCH", body: JSON.stringify({ secretReferenceId: selectedReferenceId }),
      });
      setEditingReferenceFor(null); setSelectedReferenceId("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not attach secret reference"); }
    finally { setBusy(false); }
  }
  async function testConnection(id: string, provider: IntegrationProvider) {
    setBusy(true); setSuccess("");
    try {
      await apiRequest<{ connected: true }>(`/projects/${projectId}/integrations/${id}/test`, { method: "POST" });
      await load();
      setSuccess(`${providers.find((item) => item.id === provider)?.label ?? provider} connection verified successfully.`);
    } catch (cause) { await load(); setError(cause instanceof Error ? cause.message : "Connection test failed"); }
    finally { setBusy(false); }
  }
  async function addReference(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    try {
      await apiRequest<SecretReference>(`/projects/${projectId}/secret-references`, { method: "POST", body: JSON.stringify({
        provider, displayName: referenceName, purpose: referencePurpose, environmentId: environmentId || null,
        referenceType, referenceKey,
      }) });
      setAddingReference(false); setReferenceName(""); setReferencePurpose(""); setReferenceKey("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add secret reference"); }
    finally { setBusy(false); }
  }
  const availableReferences = references.filter((reference) => reference.provider === provider && (!reference.environmentId || reference.environmentId === environmentId));

  return <main className="workspace"><div className="workspace-inner">
    <div className="topline"><Link href="/" className="brand">Investaplay DevOps</Link><Link href="/projects">Projects</Link></div>
    <div className="page-heading"><div><p className="eyebrow">Project integrations</p><h1>{project?.name ?? "Integrations"}</h1><p>{integrations.some((integration) => integration.provider === "expo" && integration.lastVerificationResult === "connected") ? "Expo connection verified." : "Configure integrations and test provider connections here."}</p></div></div>
    <nav className="project-nav"><Link href={`/projects/${projectId}`}>Overview &amp; environments</Link><Link href={`/projects/${projectId}/integrations`}>Integrations</Link><Link href={`/projects/${projectId}/github`}>GitHub</Link><Link href={`/projects/${projectId}/builds`}>Builds</Link><Link href={`/projects/${projectId}/servers`}>Servers</Link><Link href={`/projects/${projectId}/deployments`}>Deployments</Link></nav>
    {error && <p className="alert" role="alert">{error}</p>}
    {success && <p className="panel" role="status">{success}</p>}
    {integrations.length === 0 && <section className="panel empty"><h2>No integrations configured.</h2><p>Connect GitHub, Expo/EAS or AWS when you&apos;re ready to automate this project.</p>{isAdmin && project?.status === "active" && <button onClick={() => setAdding(true)}>Add integration</button>}</section>}
    <div className="integration-grid">{providers.map((item) => {
      const entries = integrations.filter((integration) => integration.provider === item.id);
      return <section className="panel" key={item.id}><h2>{item.label}</h2>{entries.length === 0 ? <p className="muted">Not configured</p> : entries.map((integration) => <div className="environment-row" key={integration.id}><div><strong>{integration.displayName}</strong><p>{integration.status === "disabled" ? "Disabled" : integration.lastVerificationResult === "connected" ? "Connected" : integration.lastVerificationResult === "error" ? "Error" : "Not tested"}</p><small className="muted">{environments.find((environment) => environment.id === integration.environmentId)?.name ?? "All environments"}</small>{integration.provider === "github" && <p className="muted">Repository: {String(integration.configuration?.owner ?? "")}/{String(integration.configuration?.repository ?? "")}<br />Default branch: {String(integration.configuration?.defaultBranch ?? "")}<br />Installation: {integration.lastVerificationResult === "connected" ? "Connected" : "Not verified"}<br />Last verified: {integration.lastVerifiedAt ? new Date(integration.lastVerifiedAt).toLocaleString() : "Never"}</p>}{integration.provider === "expo" && <p className="muted">Expo project: {String(integration.configuration?.expoAccount ?? "")}/{String(integration.configuration?.projectSlug ?? "")}<br />Preview profile: {String(integration.configuration?.previewProfile ?? "")}<br />Last verified: {integration.lastVerifiedAt ? new Date(integration.lastVerifiedAt).toLocaleString() : "Never"}</p>}{integration.provider === "expo" && editingReferenceFor === integration.id && <div className="form-grid"><label>Expo secret reference<select value={selectedReferenceId} onChange={(event) => setSelectedReferenceId(event.target.value)}><option value="">Select reference</option>{references.filter((reference) => reference.provider === "expo" && reference.purpose === "expo_access_token" && (!reference.environmentId || reference.environmentId === integration.environmentId)).map((reference) => <option key={reference.id} value={reference.id}>{reference.displayName}</option>)}</select></label><div className="actions"><button disabled={busy || !selectedReferenceId} onClick={() => void attachReference(integration.id)}>Save reference</button><button className="secondary" onClick={() => setEditingReferenceFor(null)}>Cancel</button></div></div>}</div><div className="actions">{isAdmin && project?.status === "active" && integration.provider === "expo" && integration.status !== "disabled" && <button className="secondary" disabled={busy} onClick={() => { setEditingReferenceFor(integration.id); setSelectedReferenceId(integration.secretReferenceId ?? ""); setError(""); }}>Attach reference</button>}{isAdmin && project?.status === "active" && (integration.provider === "github" || integration.provider === "expo" || integration.provider === "aws") && integration.status !== "disabled" && <button className="secondary" disabled={busy} onClick={() => void testConnection(integration.id, integration.provider)}>Test connection</button>}{isAdmin && project?.status === "active" && integration.status !== "disabled" && <button className="secondary" disabled={busy} onClick={() => void disable(integration.id)}>Disable</button>}</div></div>)}</section>;
    })}</div>
    {isAdmin && project?.status === "active" && !adding && integrations.length > 0 && <p><button onClick={() => setAdding(true)}>Add integration</button></p>}
    {isAdmin && project?.status === "active" && adding && <section className="panel"><h2>Add integration</h2><p className="muted">Enter non-secret metadata. Credentials are never entered here.</p><form className="form-grid" onSubmit={add}>
      <label>Provider<select value={provider} onChange={(event) => { setProvider(event.target.value as IntegrationProvider); setConfiguration({}); setSecretReferenceId(""); }}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={120} /></label>
      <label>Environment<select value={environmentId} onChange={(event) => { setEnvironmentId(event.target.value); setSecretReferenceId(""); }}><option value="">All environments</option>{environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</select></label>
      {fields[provider].map((field) => <label key={field.name}>{field.label}{provider === "aws" && field.name === "controlStrategy" ? <select value={configuration[field.name] ?? ""} onChange={(event) => setConfiguration((current) => ({ ...current, [field.name]: event.target.value }))} required><option value="">Select control strategy</option><option value="ssm">SSM diagnostics</option><option value="manual">Visibility only</option></select> : <input value={configuration[field.name] ?? ""} onChange={(event) => setConfiguration((current) => ({ ...current, [field.name]: event.target.value }))} required maxLength={200} />}</label>)}
      <label>Existing secret reference (optional)<select value={secretReferenceId} onChange={(event) => setSecretReferenceId(event.target.value)}><option value="">None</option>{availableReferences.map((reference) => <option key={reference.id} value={reference.id}>{reference.displayName} · {reference.purpose}</option>)}</select></label>
      <div className="actions"><button disabled={busy}>Save configuration</button><button type="button" className="secondary" onClick={() => setAdding(false)}>Cancel</button></div>
    </form></section>}
    {isAdmin && project?.status === "active" && <section className="panel"><div className="section-heading"><h2>Secret references</h2><button className="secondary" onClick={() => setAddingReference(!addingReference)}>{addingReference ? "Cancel" : "Add reference"}</button></div><p className="muted">References identify where the backend may later resolve credentials. No secret values are stored or displayed.</p>
      {references.length === 0 ? <p>No secret references yet.</p> : <div className="environment-list">{references.map((reference) => <div className="environment-row" key={reference.id}><div><strong>{reference.displayName}</strong><p>{reference.provider} · {reference.purpose} · {reference.referenceType.replaceAll("_", " ")}</p></div></div>)}</div>}
      {addingReference && <form className="form-grid" onSubmit={addReference}>
        <label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as IntegrationProvider)}>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Display name<input value={referenceName} onChange={(event) => setReferenceName(event.target.value)} required maxLength={120} /></label>
        <label>Purpose<input value={referencePurpose} onChange={(event) => setReferencePurpose(event.target.value)} required maxLength={120} /></label>
        <label>Environment<select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}><option value="">All environments</option>{environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</select></label>
        <label>Reference type<select value={referenceType} onChange={(event) => setReferenceType(event.target.value as typeof referenceType)}><option value="environment_variable">Environment variable name</option><option value="aws_secrets_manager">AWS Secrets Manager ARN</option><option value="aws_ssm_parameter">AWS SSM parameter path</option></select></label>
        <label>Locator only; never enter a secret value<input value={referenceKey} onChange={(event) => setReferenceKey(event.target.value)} required maxLength={512} placeholder={referenceType === "environment_variable" ? "GITHUB_APP_KEY" : referenceType === "aws_ssm_parameter" ? "/app/environment/key" : "arn:aws:secretsmanager:..."} /></label>
        <button disabled={busy}>Save reference</button>
      </form>}
    </section>}
  </div></main>;
}
