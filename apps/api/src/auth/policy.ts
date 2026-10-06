import type { RequestHandler } from "express";
import { sessionCookieName, type Role, type User } from "@investaplay/devops-contracts";
import { getSessionUser } from "./store";

export const SESSION_COOKIE = sessionCookieName;

export const permissions = {
  projectsRead: ["developer", "release_manager", "admin"],
  projectsWrite: ["admin"],
  environmentsRead: ["developer", "release_manager", "admin"],
  environmentsWrite: ["admin"],
  usersManage: ["admin"],
  integrationsRead: ["developer", "release_manager", "admin"],
  integrationsWrite: ["admin"],
  secretReferencesManage: ["admin"],
  expoRead: ["developer", "release_manager", "admin"],
  expoBuildPreview: ["release_manager", "admin"],
  awsRead: ["developer", "release_manager", "admin"],
  awsManage: ["admin"],
  awsDiagnostic: ["release_manager", "admin"],
  deploymentsRead: ["developer", "release_manager", "admin"],
  deploymentsConfigure: ["admin"],
  deploymentsPreflight: ["release_manager", "admin"],
  deploymentsExecute: ["release_manager", "admin"],
  deploymentsRollback: ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof permissions;

export function currentUser(response: { locals: Record<string, unknown> }): User {
  return response.locals.user as User;
}

export const requireAuth: RequestHandler = async (request, response, next) => {
  const token = request.cookies?.[SESSION_COOKIE] as string | undefined;
  const user = token ? await getSessionUser(token) : null;
  if (!user) {
    response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication required" } });
    return;
  }
  response.locals.user = user;
  next();
};

export function requirePermission(permission: Permission): RequestHandler {
  return (_request, response, next) => {
    const user = currentUser(response);
    if (!(permissions[permission] as readonly Role[]).includes(user.role)) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "Permission denied" } });
      return;
    }
    next();
  };
}
