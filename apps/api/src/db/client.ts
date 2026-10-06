import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { getLocalDatabaseUrl } from "./config";

export const pool = mysql.createPool({ uri: getLocalDatabaseUrl(), connectionLimit: 5, timezone: "Z" });
export const db = drizzle({ client: pool });
