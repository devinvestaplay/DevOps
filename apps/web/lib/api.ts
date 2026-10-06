import type { ApiData, ApiError } from "@investaplay/devops-contracts";

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as ApiData<T> | ApiError | null;
  if (!response.ok) {
    throw new Error(body && "error" in body ? body.error.message : `Request failed (${response.status})`);
  }
  if (!body || !("data" in body)) throw new Error("Server returned an invalid response");
  return (body as ApiData<T>).data;
}
