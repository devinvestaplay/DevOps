import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookieName, type ApiData, type User } from "@investaplay/devops-contracts";
import { AuthShell } from "../../components/auth-shell";

export default async function ProjectsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = (await cookies()).get(sessionCookieName)?.value;
  const cookieHeader = session ? `${sessionCookieName}=${encodeURIComponent(session)}` : "";
  const response = await fetch("http://127.0.0.1:4001/api/auth/me", {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });
  if (response.status === 401) redirect("/login");
  if (!response.ok) throw new Error("Authentication service unavailable");
  const { data: user } = await response.json() as ApiData<User>;
  return <AuthShell user={user}>{children}</AuthShell>;
}
