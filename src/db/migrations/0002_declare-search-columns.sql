-- Snapshot reconciliation, not a schema change.
--
-- Migration 0001 created these generated columns by hand (drizzle-kit cannot
-- author generated columns), so drizzle's snapshot never learned about them and
-- `db:generate` kept re-proposing them. Declaring `search` in the Drizzle schema
-- fixes queries and index usage; this migration teaches the snapshot they exist.
--
-- IF NOT EXISTS makes it a no-op on any database that already ran 0001, while
-- still being correct if someone ever replays from an older snapshot.
-- The expression MUST stay identical to 0001 and to the schema declaration.

ALTER TABLE "episodes" ADD COLUMN IF NOT EXISTS "search" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', "title" || ' ' || "description")) STORED;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "search" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', "title" || ' ' || "description")) STORED;
