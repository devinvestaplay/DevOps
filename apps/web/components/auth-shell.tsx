"use client";

import { createContext, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@investaplay/devops-contracts";

const UserContext = createContext<User | null>(null);

export function useCurrentUser(): User {
  const user = useContext(UserContext);
  if (!user) throw new Error("Authenticated user context is missing");
  return user;
}

export function AuthShell({ user, children }: { user: User; children: React.ReactNode }) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return <UserContext.Provider value={user}>
    <header className="auth-bar"><span>{user.name} <small>({user.role.replace("_", " ")})</small></span><button className="secondary" disabled={loggingOut} onClick={() => void logout()}>Logout</button></header>
    {children}
  </UserContext.Provider>;
}
