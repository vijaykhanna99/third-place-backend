import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

/** Postgres tsvector — no first-class drizzle type, and never written directly. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});
import { accounts } from "./accounts.js";
import { uploads } from "./uploads.js";

export const genres = pgTable("genres", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  /**
   * Deliberate deviation from spec §10 (which lists no unique on genres):
   * duplicate genre names would be operator error. Caveat: the constraint is
   * not partial, so a soft-deleted genre still holds its name — acceptable
   * while genres are seeded server-side; revisit if genre CRUD ships.
   */
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  thumbnailUrl: text("thumbnail_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const programs = pgTable(
  "programs",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    ownerAccountId: uuid("owner_account_id")
      .notNull()
      .references(() => accounts.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    thumbnailUrl: text("thumbnail_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * Generated tsvector, created by hand-written migration 0001 along with its
     * GIN index. Declared here so queries can reference it and hit that index —
     * the expression MUST stay identical to the migration's.
     */
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('simple', "title" || ' ' || "description")`,
    ),
  },
  (t) => [index("programs_owner_idx").on(t.ownerAccountId)],
);

export const programGenres = pgTable(
  "program_genres",
  {
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    genreId: uuid("genre_id")
      .notNull()
      .references(() => genres.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.programId, t.genreId] }),
    index("program_genres_genre_idx").on(t.genreId),
  ],
);

export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    programId: uuid("program_id")
      .notNull()
      .references(() => programs.id, { onDelete: "cascade" }),
    /** Addressed by number, unique within the program (spec §2.1). */
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
  },
  (t) => [
    unique("seasons_program_number_uq").on(t.programId, t.number),
    index("seasons_program_idx").on(t.programId),
  ],
);

export const episodes = pgTable(
  "episodes",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** Authoritative value comes from the validated upload (spec §8.4). */
    durationSec: integer("duration_sec").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** See programs.search — same contract, same migration. */
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('simple', "title" || ' ' || "description")`,
    ),
  },
  (t) => [
    unique("episodes_season_number_uq").on(t.seasonId, t.number),
    index("episodes_season_idx").on(t.seasonId),
  ],
);

/**
 * Camera angles (client-review revision, Aug 2026): an episode carries one or
 * more named streams — "Main", "Side", "Overhead" — each backed by its own
 * upload. Replaces the former single episodes.upload_id.
 *
 * The UNIQUE on upload_id is the one-live-claim-per-upload guarantee (was the
 * partial index on episodes.upload_id). Stream rows are hard-deleted when
 * their episode is soft-deleted, releasing the uploads for reuse; the janitor's
 * unattached-uploads rule then reclaims the storage.
 */
export const episodeStreams = pgTable(
  "episode_streams",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    /** Display name of the angle shown by the client, e.g. "Main". */
    name: text("name").notNull(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => uploads.id)
      .unique(),
    /** Presentation order; index 0 is the default angle and defines episode duration. */
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    unique("episode_streams_episode_name_uq").on(t.episodeId, t.name),
    index("episode_streams_episode_idx").on(t.episodeId),
  ],
);
