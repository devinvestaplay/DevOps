import "dotenv/config";
import { createUserSchema } from "@investaplay/devops-contracts";
import { countUsers, createUser } from "./auth/store";
import { pool } from "./db/client";

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Development bootstrap is disabled in production");
  }
  const input = createUserSchema.safeParse({
    email: process.env.ADMIN_EMAIL,
    name: process.env.ADMIN_NAME,
    password: process.env.ADMIN_PASSWORD,
    role: "admin",
  });
  if (!input.success) {
    throw new Error("Set ADMIN_EMAIL, ADMIN_NAME, and a password of at least 12 characters");
  }
  if (await countUsers() !== 0) {
    throw new Error("Bootstrap is available only when the users table is empty");
  }
  const user = await createUser(input.data);
  console.info(`Initial development administrator created: ${user.id}`);
}

main().catch(() => {
  console.error("Administrator bootstrap failed. Check local database and input.");
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
