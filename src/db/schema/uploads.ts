import { bigint, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { accounts } from "./accounts.js";

/** Spec §8 lifecycle: uploading → queued → processing → ready | failed. */
export const uploadStatus = pgEnum("upload_status", [
  "uploading",
  "queued",
  "processing",
  "ready",
  "failed",
]);

export const uploads = pgTable(
  "uploads",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    /** R2 object key of the uploaded ZIP in the temp area. */
    r2Key: text("r2_key").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    /** SHA-256, lowercase hex, declared by the operator at initiate (spec §8.1). */
    checksum: text("checksum").notNull(),
    status: uploadStatus("status").notNull().default("uploading"),
    error: text("error"),
    /** R2 key of the master playlist once extraction validates (spec §8.4). */
    playlistKey: text("playlist_key"),
    durationSec: integer("duration_sec"),
    /** Set when a worker claims the row; a `processing` row older than the stuck threshold is reclaimable. */
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    /** Times this upload was pulled back from a stuck `processing` state; capped so a crash loop ends in `failed`. */
    recoveryCount: integer("recovery_count").notNull().default(0),
    /**
     * When the upload last lost its episode (episode/program deleted, angle set
     * replaced). Null while attached or never attached. The janitor keeps a
     * detached upload's media for 30 days from here (spec §7.3), versus 14 days
     * for a `ready` upload that was never attached (spec §8.5).
     */
    detachedAt: timestamp("detached_at", { withTimezone: true }),
    /** When the janitor removed the temp archive (`r2_key`), so it is not re-deleted every sweep. */
    tempDeletedAt: timestamp("temp_deleted_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => accounts.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("uploads_status_idx").on(t.status), index("uploads_created_by_idx").on(t.createdBy)],
);

export const images = pgTable(
  "images",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    r2Key: text("r2_key").notNull(),
    url: text("url").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => accounts.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("images_created_by_idx").on(t.createdBy)],
);
