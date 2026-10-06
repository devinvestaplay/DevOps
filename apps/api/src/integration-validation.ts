import { integrationConfigurationSchema, type IntegrationProvider } from "@investaplay/devops-contracts";

const forbiddenPart = /token|password|secret|private.?key|credential|access.?key|api.?key|passphrase|authorization/i;

export function hasSecretLikeField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasSecretLikeField);
  return Object.entries(value).some(([key, child]) => forbiddenPart.test(key) || hasSecretLikeField(child));
}

export function safeConfiguration(provider: IntegrationProvider, value: unknown): Record<string, unknown> | null {
  if (hasSecretLikeField(value)) return null;
  const parsed = integrationConfigurationSchema.safeParse({ provider, configuration: value });
  return parsed.success ? parsed.data.configuration : null;
}

export function validReferenceLocator(type: string, key: string): boolean {
  if (type === "environment_variable") return /^[A-Z_][A-Z0-9_]{0,127}$/.test(key);
  if (type === "aws_secrets_manager") return /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(key);
  if (type === "aws_ssm_parameter") return /^\/[A-Za-z0-9_.\/-]{1,511}$/.test(key) && !key.includes("//");
  return false;
}
