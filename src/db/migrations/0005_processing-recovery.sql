-- Stuck-processing recovery. A worker that dies mid-extraction (SIGKILL, OOM)
-- used to leave its row in `processing` forever. processing_started_at lets a
-- redelivery or the worker's sweep reclaim rows older than the configured
-- threshold; recovery_count caps how often one upload is pulled back before
-- it is failed outright, so a crash loop cannot run indefinitely.

ALTER TABLE "uploads" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "recovery_count" integer DEFAULT 0 NOT NULL;
