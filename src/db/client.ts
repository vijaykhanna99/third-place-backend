import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema/index.js";

export function createDb(url: string) {
  const sql = postgres(url, {
    max: 10,
    // Fail fast instead of tying up pool slots when the server is unreachable.
    connect_timeout: 5,
    // Notices (e.g. from IF NOT EXISTS) are noise at runtime; real errors still throw.
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export type DbBundle = ReturnType<typeof createDb>;
export type Db = DbBundle["db"];
export type PgSql = DbBundle["sql"];
