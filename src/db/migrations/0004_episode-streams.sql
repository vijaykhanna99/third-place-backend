-- Multi-angle streams (client-review revision): an episode carries 1..n named
-- camera-angle streams, each backed by its own upload. Replaces the single
-- episodes.upload_id. The UNIQUE on upload_id carries forward the
-- one-live-claim-per-upload guarantee (dropping the column below also drops
-- 0003's partial index that previously enforced it).

CREATE TABLE "episode_streams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"episode_id" uuid NOT NULL,
	"name" text NOT NULL,
	"upload_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "episode_streams_upload_id_unique" UNIQUE("upload_id"),
	CONSTRAINT "episode_streams_episode_name_uq" UNIQUE("episode_id","name")
);
--> statement-breakpoint
ALTER TABLE "episodes" DROP CONSTRAINT "episodes_upload_id_uploads_id_fk";
--> statement-breakpoint
DROP INDEX "episodes_upload_idx";--> statement-breakpoint
ALTER TABLE "episode_streams" ADD CONSTRAINT "episode_streams_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode_streams" ADD CONSTRAINT "episode_streams_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episode_streams_episode_idx" ON "episode_streams" USING btree ("episode_id");--> statement-breakpoint
-- Backfill: every live episode's single upload becomes its "Main" angle, so a
-- database migrated mid-flight keeps its mappings. (gen_random_uuid is v4;
-- acceptable for backfill rows — v7 ordering matters only for app-created ids.)
INSERT INTO "episode_streams" ("id", "episode_id", "name", "upload_id", "sort_order")
SELECT gen_random_uuid(), "id", 'Main', "upload_id", 0
FROM "episodes" WHERE "deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "episodes" DROP COLUMN "upload_id";