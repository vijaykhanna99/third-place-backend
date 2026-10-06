-- Janitor bookkeeping (step 8).
-- detached_at: when an upload lost its episode (delete, angle replacement), so
--   soft-deleted media is kept 30 days from then (spec §7.3) while never-attached
--   ready uploads are reclaimed 14 days after they became ready (spec §8.5).
-- temp_deleted_at: when the janitor removed the temp archive, so one sweep does
--   not re-issue the delete every hour.

ALTER TABLE "uploads" ADD COLUMN "detached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "temp_deleted_at" timestamp with time zone;