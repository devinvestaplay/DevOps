"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "../../lib/api";
import type { User } from "@investaplay/devops-contracts";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await apiRequest<User>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      setPassword("");
      router.replace("/projects");
      router.refresh();
    } catch {
      setError("Could not sign in. Check your credentials and try again.");
    } finally {
      setLoading(false);
    }
  }

  return <main><form className="shell form-grid" onSubmit={login}>
    <p className="eyebrow">Investaplay DevOps</p>
    <h1>Sign in</h1>
    <p>Use your platform account to access projects and environments.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    <label>Email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
    <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
    <button disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
  </form></main>;
}
