type SecurityEvent = {
  actorId: string | null;
  action: "auth.login" | "auth.logout" | "user.create" | "user.update" | "integration.create" | "integration.update" | "integration.disable" | "secret_reference.create" | "secret_reference.update" | "build.preview.request" | "aws.server.map" | "aws.server.update" | "aws.diagnostic.request" | "deployment.config.create" | "deployment.preflight" | "deployment.start" | "deployment.rollback";
  targetId: string | null;
  result: "allowed" | "denied";
};

export function recordSecurityEvent(event: SecurityEvent): void {
  console.info(JSON.stringify({ ...event, timestamp: new Date().toISOString() }));
}
