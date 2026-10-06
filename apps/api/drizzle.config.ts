import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { getLocalDatabaseUrl } from "./src/db/config";

export default defineConfig({
  dialect: "mysql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: getLocalDatabaseUrl() },
});
