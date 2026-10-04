import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadEnv } from "../config/env.js";

/**
 * Applies all pending migrations from src/db/migrations. Run via `pnpm db:migrate`.
 * Uses a single dedicated connection (max: 1) — required for advisory-locked
 * migration runs.
 */
const env = loadEnv();
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — copy .env.example to .env and start `pnpm db:up`.");
  process.exit(1);
}

const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  await migrate(drizzle(sql), { migrationsFolder: "src/db/migrations" });
  console.log("migrations applied");
} finally {
  await sql.end();
}
