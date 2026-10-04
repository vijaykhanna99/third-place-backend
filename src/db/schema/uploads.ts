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
