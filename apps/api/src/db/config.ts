export function getLocalDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required for the local development database");
  const url = new URL(value);
  if (
    url.protocol !== "mysql:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.pathname !== "/investaplay_devops_dev"
  ) {
    throw new Error("Milestone 1 permits only the local investaplay_devops_dev database");
  }
  return value;
}
