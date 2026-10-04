CREATE TYPE "public"."account_role" AS ENUM('operator', 'creator', 'user');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('uploading', 'queued', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."playback_event" AS ENUM('start', 'progress', 'complete', 'error');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"did" text NOT NULL,
	"handle" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"avatar_url" text,
	"password_hash" text NOT NULL,
	"role" "account_role" DEFAULT 'user' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "accounts_did_unique" UNIQUE("did"),
	CONSTRAINT "accounts_handle_unique" UNIQUE("handle"),
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"refresh_hash" text NOT NULL,
	"chain_id" uuid NOT NULL,
	"device_info" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_refresh_hash_unique" UNIQUE("refresh_hash")
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"season_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"duration_sec" integer NOT NULL,
	"thumbnail_url" text,
	"upload_id" uuid NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "episodes_season_number_uq" UNIQUE("season_id","number")
);
--> statement-breakpoint
CREATE TABLE "genres" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"thumbnail_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "genres_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "program_genres" (
	"program_id" uuid NOT NULL,
	"genre_id" uuid NOT NULL,
	CONSTRAINT "program_genres_program_id_genre_id_pk" PRIMARY KEY("program_id","genre_id")
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"thumbnail_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"program_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	CONSTRAINT "seasons_program_number_uq" UNIQUE("program_id","number")
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"r2_key" text NOT NULL,
	"url" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"r2_key" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"checksum" text NOT NULL,
	"status" "upload_status" DEFAULT 'uploading' NOT NULL,
	"error" text,
	"playlist_key" text,
	"duration_sec" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playback_events" (
	"id" uuid NOT NULL,
	"episode_id" uuid NOT NULL,
	"event" "playback_event" NOT NULL,
	"position_sec" real NOT NULL,
	"quality" text,
	"session_uuid" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playback_events_id_created_at_pk" PRIMARY KEY("id","created_at")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_genres" ADD CONSTRAINT "program_genres_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_genres" ADD CONSTRAINT "program_genres_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_created_by_accounts_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_chain_idx" ON "sessions" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "episodes_season_idx" ON "episodes" USING btree ("season_id");--> statement-breakpoint
CREATE INDEX "episodes_upload_idx" ON "episodes" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "program_genres_genre_idx" ON "program_genres" USING btree ("genre_id");--> statement-breakpoint
CREATE INDEX "programs_owner_idx" ON "programs" USING btree ("owner_account_id");--> statement-breakpoint
CREATE INDEX "seasons_program_idx" ON "seasons" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "images_created_by_idx" ON "images" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "uploads_status_idx" ON "uploads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "uploads_created_by_idx" ON "uploads" USING btree ("created_by");