import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://tplace:tplace@localhost:5433/tplace",
  },
  // Migration 0001 is hand-written (generated columns, trgm indexes, partitioning).
  // Always review generated SQL before applying.
  verbose: true,
  strict: true,
});
