-- Hand-written migration: everything drizzle-kit cannot express.
-- 1. pg_trgm extension for substring search (works for Japanese text where
--    stemming does not).
-- 2. Generated tsvector `search` columns + GIN indexes on programs/episodes
--    ('simple' config: no language stemming — catalog text is JA/EN mixed).
-- 3. playback_events recreated as a RANGE-partitioned table (spec §10).
--    Partition key must be in the PK, hence PRIMARY KEY (id, created_at).
--    Monthly partitions through 2026-12 are created here; the janitor job
--    (step 8) creates future months and MUST run AHEAD of time (create month
--    N+1 while still in month N).
--
--    DEFAULT-partition trap — read before touching partitions:
--    The DEFAULT partition catches inserts for months with no range partition,
--    so inserts never fail. BUT once rows for month X sit in DEFAULT, a later
--    CREATE TABLE ... PARTITION OF ... FOR VALUES (month X) FAILS ("would be
--    violated by some row"), and even an empty-conflict creation takes an
--    ACCESS EXCLUSIVE lock and scans DEFAULT. Recovery if DEFAULT holds rows:
--      BEGIN;
--      ALTER TABLE playback_events DETACH PARTITION playback_events_default;
--      CREATE TABLE playback_events_YYYY_MM PARTITION OF playback_events FOR VALUES FROM (...) TO (...);
--      INSERT INTO playback_events SELECT * FROM playback_events_default WHERE created_at >= ... AND created_at < ...;
--      DELETE FROM playback_events_default WHERE created_at >= ... AND created_at < ...;
--      ALTER TABLE playback_events ATTACH PARTITION playback_events_default DEFAULT;
--      COMMIT;
--    The janitor (step 8) must also alert when count(*) FROM ONLY
--    playback_events_default > 0.

CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

ALTER TABLE "programs" ADD COLUMN "search" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', "title" || ' ' || "description")) STORED;--> statement-breakpoint
CREATE INDEX "programs_search_idx" ON "programs" USING gin ("search");--> statement-breakpoint
CREATE INDEX "programs_title_trgm_idx" ON "programs" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "programs_description_trgm_idx" ON "programs" USING gin ("description" gin_trgm_ops);--> statement-breakpoint

ALTER TABLE "episodes" ADD COLUMN "search" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', "title" || ' ' || "description")) STORED;--> statement-breakpoint
CREATE INDEX "episodes_search_idx" ON "episodes" USING gin ("search");--> statement-breakpoint
CREATE INDEX "episodes_title_trgm_idx" ON "episodes" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "episodes_description_trgm_idx" ON "episodes" USING gin ("description" gin_trgm_ops);--> statement-breakpoint

DROP TABLE "playback_events";--> statement-breakpoint
CREATE TABLE "playback_events" (
	"id" uuid NOT NULL,
	"episode_id" uuid NOT NULL,
	"event" "playback_event" NOT NULL,
	"position_sec" real NOT NULL,
	"quality" text,
	"session_uuid" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playback_events_id_created_at_pk" PRIMARY KEY("id","created_at")
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
CREATE TABLE "playback_events_default" PARTITION OF "playback_events" DEFAULT;--> statement-breakpoint
CREATE TABLE "playback_events_2026_08" PARTITION OF "playback_events"
  FOR VALUES FROM ('2026-08-01T00:00:00Z') TO ('2026-09-01T00:00:00Z');--> statement-breakpoint
CREATE TABLE "playback_events_2026_09" PARTITION OF "playback_events"
  FOR VALUES FROM ('2026-09-01T00:00:00Z') TO ('2026-10-01T00:00:00Z');--> statement-breakpoint
CREATE TABLE "playback_events_2026_10" PARTITION OF "playback_events"
  FOR VALUES FROM ('2026-10-01T00:00:00Z') TO ('2026-11-01T00:00:00Z');--> statement-breakpoint
CREATE TABLE "playback_events_2026_11" PARTITION OF "playback_events"
  FOR VALUES FROM ('2026-11-01T00:00:00Z') TO ('2026-12-01T00:00:00Z');--> statement-breakpoint
CREATE TABLE "playback_events_2026_12" PARTITION OF "playback_events"
  FOR VALUES FROM ('2026-12-01T00:00:00Z') TO ('2027-01-01T00:00:00Z');--> statement-breakpoint
CREATE INDEX "playback_events_episode_idx" ON "playback_events" ("episode_id", "created_at");
