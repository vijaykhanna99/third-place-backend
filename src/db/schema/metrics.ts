import { pgEnum, pgTable, primaryKey, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

export const playbackEvent = pgEnum("playback_event", ["start", "progress", "complete", "error"]);

/**
 * Append-only telemetry (spec §9/§10), partitioned by month.
 *
 * drizzle-kit generates this as a plain table in migration 0000; the
 * hand-written migration 0001 drops and recreates it as a RANGE-partitioned
 * table (partition key must be in the PK, hence the composite key). Never
 * ALTER this table through drizzle-kit — partition maintenance belongs to the
 * janitor job (step 8).
 *
 * Deliberately NO foreign key to episodes: telemetry must survive physical
 * deletion of media (janitor removes soft-deleted episodes after 30 days).
 */
export const playbackEvents = pgTable(
  "playback_events",
  {
    id: uuid("id")
      .notNull()
      .$defaultFn(() => uuidv7()),
    episodeId: uuid("episode_id").notNull(),
    event: playbackEvent("event").notNull(),
    positionSec: real("position_sec").notNull(),
    quality: text("quality"),
    sessionUuid: uuid("session_uuid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.id, t.createdAt] })],
);
