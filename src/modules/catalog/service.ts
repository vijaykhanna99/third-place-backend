import { and, asc, desc, eq, getTableColumns, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  accounts,
  episodes,
  episodeStreams,
  genres,
  playbackEvents,
  programGenres,
  programs,
  seasons,
  uploads,
} from "../../db/schema/index.js";
import { errors } from "../../lib/errors.js";
import { decodeCursor, encodeCursor } from "../../lib/pagination.js";

/** Contract shapes (openapi.yaml). Dates are ISO strings at the boundary. */
export interface GenreRef {
  id: string;
  name: string;
}

export interface StreamView {
  /** Camera-angle display name, e.g. "Main", "Side", "Overhead". */
  name: string;
  streamURL: string;
}

export interface EpisodeView {
  id: string;
  number: number;
  title: string;
  description: string;
  durationSec: number;
  thumbnailURL: string | null;
  /** 1..n camera angles, presentation order; index 0 is the default angle. */
  streams: StreamView[];
  publishedAt: string;
}

export interface EpisodeSummaryView {
  id: string;
  seasonNumber: number;
  number: number;
  title: string;
  description: string;
  durationSec: number;
  thumbnailURL: string | null;
  publishedAt: string;
}

export interface ProgramView {
  id: string;
  title: string;
  description: string;
  thumbnailURL: string;
  genre: GenreRef[];
  createdAt: string;
  updatedAt: string;
  /** Approximate: anonymous client-reported playback starts across all live episodes. */
  viewCount: number;
  owner: { did: string; handle: string; displayName: string; avatarURL: string | null };
  viewer: { isFollowing: boolean; isFavorited: boolean };
  season: {
    id: string;
    number: number;
    title: string;
    description: string;
    episodes: EpisodeView[];
  }[];
}

export interface ProgramSummaryView {
  id: string;
  title: string;
  description: string;
  thumbnailURL: string;
  genre: GenreRef[];
  updatedAt: string;
}

export interface CreateProgramInput {
  title: string;
  description: string;
  genreIDs: string[];
  thumbnailURL: string;
  season: {
    number: number;
    title: string;
    description: string;
    episodes: {
      number: number;
      title: string;
      description: string;
      durationSec?: number;
      thumbnailURL?: string;
      publishedAt: string;
      streams: { name: string; uploadID: string }[];
    }[];
  }[];
}

export interface UpdateProgramInput {
  title?: string | null;
  description?: string | null;
  genreIDs?: string[] | null;
  thumbnailURL?: string | null;
  episodes?: {
    episodeID: string;
    title?: string | null;
    description?: string | null;
    thumbnailURL?: string | null;
    publishedAt?: string | null;
    /** When provided, REPLACES the episode's full stream set. */
    streams?: { name: string; uploadID: string }[] | null;
  }[];
}

/**
 * Column projections that omit the generated `search` tsvector. Selecting whole
 * rows would ship a multi-KB tsvector per row over the wire for data no client
 * ever sees.
 */
const { search: _programSearch, ...programCols } = getTableColumns(programs);
const { search: _episodeSearch, ...episodeCols } = getTableColumns(episodes);

/**
 * Upper bound on episodes returned per program in general search. Without it,
 * one request could serialize the full episode catalogue of every program on
 * the page. Clients needing the rest use program detail or episode search.
 */
const MAX_EPISODES_PER_SEARCH_RESULT = 20;

/** Row shapes as actually selected (i.e. without the `search` tsvector). */
type ProgramRow = Omit<typeof programs.$inferSelect, "search">;
type EpisodeRow = Omit<typeof episodes.$inferSelect, "search">;

export class CatalogService {
  constructor(
    private readonly db: Db,
    /** Injected so media/token concerns stay in the media module (step 7).
     *  Storage is keyed per UPLOAD (one upload = one camera angle). */
    private readonly streamUrlFor: (uploadId: string) => string,
  ) {}

  // ---------------------------------------------------------------- reads

  /**
   * Program detail with seasons and episodes (spec §6.1). Soft-deleted rows are
   * invisible everywhere, which is why every query carries an isNull(deletedAt).
   */
  async getProgram(programId: string, seasonNumber?: number): Promise<ProgramView> {
    const [row] = await this.db
      .select({ program: programCols, owner: accounts })
      .from(programs)
      .innerJoin(accounts, eq(programs.ownerAccountId, accounts.id))
      .where(and(eq(programs.id, programId), isNull(programs.deletedAt)))
      .limit(1);
    if (!row) throw errors.notFound("Program not found");

    const genreRows = await this.genresFor([programId]);

    const seasonRows = await this.db
      .select()
      .from(seasons)
      .where(
        seasonNumber === undefined
          ? eq(seasons.programId, programId)
          : and(eq(seasons.programId, programId), eq(seasons.number, seasonNumber)),
      )
      .orderBy(asc(seasons.number));

    // A season filter that matches nothing is a 404, not an empty program.
    if (seasonNumber !== undefined && seasonRows.length === 0) {
      throw errors.notFound("Season not found");
    }

    const seasonIds = seasonRows.map((s) => s.id);
    const episodeRows = seasonIds.length
      ? await this.db
          .select()
          .from(episodes)
          .where(and(inArray(episodes.seasonId, seasonIds), isNull(episodes.deletedAt)))
          .orderBy(asc(episodes.number))
      : [];

    // Camera angles for every episode on the page, one round-trip.
    const streamRows = episodeRows.length
      ? await this.db
          .select()
          .from(episodeStreams)
          .where(
            inArray(
              episodeStreams.episodeId,
              episodeRows.map((e) => e.id),
            ),
          )
          .orderBy(asc(episodeStreams.sortOrder), asc(episodeStreams.id))
      : [];
    const streamsByEpisode = new Map<string, StreamView[]>();
    for (const r of streamRows) {
      const list = streamsByEpisode.get(r.episodeId) ?? [];
      list.push({ name: r.name, streamURL: this.streamUrlFor(r.uploadId) });
      streamsByEpisode.set(r.episodeId, list);
    }

    // Program-wide (NOT season-filtered) playback starts. Approximate by
    // design: anonymous, client-reported. Display-grade, never billing-grade.
    const [vc] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(playbackEvents)
      .innerJoin(episodes, eq(playbackEvents.episodeId, episodes.id))
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .where(
        and(
          eq(seasons.programId, programId),
          isNull(episodes.deletedAt),
          eq(playbackEvents.event, "start"),
        ),
      );

    return {
      id: row.program.id,
      title: row.program.title,
      description: row.program.description,
      thumbnailURL: row.program.thumbnailUrl,
      genre: genreRows.get(programId) ?? [],
      createdAt: row.program.createdAt.toISOString(),
      updatedAt: row.program.updatedAt.toISOString(),
      viewCount: vc?.n ?? 0,
      owner: {
        did: row.owner.did,
        handle: row.owner.handle,
        displayName: row.owner.displayName,
        avatarURL: row.owner.avatarUrl,
      },
      // Always false in v1 — no end-user accounts exist (spec §3).
      viewer: { isFollowing: false, isFavorited: false },
      season: seasonRows.map((s) => ({
        id: s.id,
        number: s.number,
        title: s.title,
        description: s.description,
        episodes: episodeRows
          .filter((e) => e.seasonId === s.id)
          .map((e) => ({
            id: e.id,
            number: e.number,
            title: e.title,
            description: e.description,
            durationSec: e.durationSec,
            thumbnailURL: e.thumbnailUrl,
            streams: streamsByEpisode.get(e.id) ?? [],
            publishedAt: e.publishedAt.toISOString(),
          })),
      })),
    };
  }

  /** Genre refs for a set of programs, in one round-trip. */
  private async genresFor(programIds: string[]): Promise<Map<string, GenreRef[]>> {
    const out = new Map<string, GenreRef[]>();
    if (programIds.length === 0) return out;
    const rows = await this.db
      .select({
        programId: programGenres.programId,
        id: genres.id,
        name: genres.name,
      })
      .from(programGenres)
      .innerJoin(genres, eq(programGenres.genreId, genres.id))
      .where(and(inArray(programGenres.programId, programIds), isNull(genres.deletedAt)))
      .orderBy(asc(genres.name));
    for (const r of rows) {
      const list = out.get(r.programId) ?? [];
      list.push({ id: r.id, name: r.name });
      out.set(r.programId, list);
    }
    return out;
  }

  async listGenres() {
    const rows = await this.db
      .select({
        id: genres.id,
        name: genres.name,
        description: genres.description,
        thumbnailUrl: genres.thumbnailUrl,
        programCount: sql<number>`count(${programs.id})::int`,
      })
      .from(genres)
      .leftJoin(programGenres, eq(programGenres.genreId, genres.id))
      .leftJoin(
        programs,
        and(eq(programs.id, programGenres.programId), isNull(programs.deletedAt)),
      )
      .where(isNull(genres.deletedAt))
      .groupBy(genres.id)
      .orderBy(asc(genres.name));

    return {
      genres: rows.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        thumbnailURL: g.thumbnailUrl,
        programCount: g.programCount,
      })),
    };
  }

  /** Programs in a genre, newest-updated first, keyset-paginated (spec §6.2). */
  async listProgramsByGenre(genreId: string, limit: number, cursorRaw?: string) {
    const [genre] = await this.db
      .select({ id: genres.id })
      .from(genres)
      .where(and(eq(genres.id, genreId), isNull(genres.deletedAt)))
      .limit(1);
    if (!genre) throw errors.notFound("Genre not found");

    const cursor = decodeCursor(cursorRaw);
    // Ordered by id (UUIDv7 → creation order), NOT updatedAt: updatedAt is
    // mutated by every edit, so a row could move behind the cursor mid-sweep
    // and be skipped, and its microsecond precision does not survive the
    // JS Date round-trip either.
    const keyset = cursor ? lt(programs.id, cursor.id) : undefined;

    const rows = await this.db
      .select({ program: programCols })
      .from(programs)
      .innerJoin(programGenres, eq(programGenres.programId, programs.id))
      .where(and(eq(programGenres.genreId, genreId), isNull(programs.deletedAt), keyset))
      .orderBy(desc(programs.id))
      .limit(limit + 1);

    const [totalRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(programs)
      .innerJoin(programGenres, eq(programGenres.programId, programs.id))
      .where(and(eq(programGenres.genreId, genreId), isNull(programs.deletedAt)));

    const page = rows.slice(0, limit).map((r) => r.program);
    const genreMap = await this.genresFor(page.map((p) => p.id));

    return {
      genreID: genreId,
      total: totalRow?.total ?? 0,
      nextCursor:
        rows.length > limit && page.length > 0
          ? encodeCursor({ id: page[page.length - 1]!.id })
          : null,
      programs: page.map((p) => this.toSummary(p, genreMap)),
    };
  }

  private toSummary(p: ProgramRow, genreMap: Map<string, GenreRef[]>): ProgramSummaryView {
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      thumbnailURL: p.thumbnailUrl,
      genre: genreMap.get(p.id) ?? [],
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  /**
   * Search matching (both endpoints): full-text on the generated tsvector,
   * OR substring — FTS alone misses partial words and, critically, Japanese,
   * which the 'simple' config emits as one undivided lexeme (so the tsvector
   * arm effectively only serves the Latin half of the catalogue).
   *
   * Two rules keep this from becoming a table-scan machine:
   *  - LIKE metacharacters in the query are escaped, so `%` searches for a
   *    literal percent sign instead of matching the entire catalogue.
   *  - The ILIKE arms are added only for queries of >= 3 characters. pg_trgm
   *    cannot extract trigrams from a shorter pattern, and Postgres uses
   *    indexes for an OR only when EVERY arm is indexable — so a 1-2 char
   *    query would otherwise force a sequential scan of the whole table.
   */
  private static readonly MIN_TRIGRAM_LENGTH = 3;

  /** Escapes LIKE metacharacters so user input is matched literally. */
  private static likePattern(query: string): string {
    return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }

  private static useSubstring(query: string): boolean {
    return [...query].length >= CatalogService.MIN_TRIGRAM_LENGTH;
  }

  private episodeMatch(query: string) {
    const fts = sql`${episodes.search} @@ plainto_tsquery('simple', ${query})`;
    if (!CatalogService.useSubstring(query)) return fts;
    const like = CatalogService.likePattern(query);
    return or(fts, sql`${episodes.title} ILIKE ${like}`, sql`${episodes.description} ILIKE ${like}`);
  }

  private programMatch(query: string) {
    const fts = sql`${programs.search} @@ plainto_tsquery('simple', ${query})`;
    if (!CatalogService.useSubstring(query)) return fts;
    const like = CatalogService.likePattern(query);
    return or(fts, sql`${programs.title} ILIKE ${like}`, sql`${programs.description} ILIKE ${like}`);
  }

  /** Episode search scoped to one program (spec §6.4). */
  async searchEpisodes(programId: string, query: string, limit: number, cursorRaw?: string) {
    const [program] = await this.db
      .select({ id: programs.id })
      .from(programs)
      .where(and(eq(programs.id, programId), isNull(programs.deletedAt)))
      .limit(1);
    if (!program) throw errors.notFound("Program not found");

    const cursor = decodeCursor(cursorRaw);
    const keyset = cursor
      ? or(
          lt(episodes.publishedAt, new Date(cursor.t!)),
          and(eq(episodes.publishedAt, new Date(cursor.t!)), lt(episodes.id, cursor.id)),
        )
      : undefined;

    const where = and(
      eq(seasons.programId, programId),
      isNull(episodes.deletedAt),
      this.episodeMatch(query),
    );

    const rows = await this.db
      .select({ episode: episodeCols, seasonNumber: seasons.number })
      .from(episodes)
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .where(and(where, keyset))
      .orderBy(desc(episodes.publishedAt), desc(episodes.id))
      .limit(limit + 1);

    const [totalRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(episodes)
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .where(where);

    const page = rows.slice(0, limit);

    return {
      query,
      programID: programId,
      total: totalRow?.total ?? 0,
      nextCursor:
        rows.length > limit && page.length > 0
          ? encodeCursor({
              t: page[page.length - 1]!.episode.publishedAt.toISOString(),
              id: page[page.length - 1]!.episode.id,
            })
          : null,
      episodes: page.map((r) => this.toEpisodeSummary(r.episode, r.seasonNumber)),
    };
  }

  private toEpisodeSummary(e: EpisodeRow, seasonNumber: number): EpisodeSummaryView {
    return {
      id: e.id,
      seasonNumber,
      number: e.number,
      title: e.title,
      description: e.description,
      durationSec: e.durationSec,
      thumbnailURL: e.thumbnailUrl,
      publishedAt: e.publishedAt.toISOString(),
    };
  }

  /**
   * General search (spec §6.5): results are grouped by program.
   * - program match → that program with ALL its episodes, matchedBy "program"
   * - episode match → the containing program with ONLY matching episodes,
   *   matchedBy "episode"
   * A program matching directly wins over episode-only matching.
   */
  async search(query: string, limit: number, cursorRaw?: string) {
    const cursor = decodeCursor(cursorRaw);
    // Ordered by id (UUIDv7 → creation order), NOT updatedAt: updatedAt is
    // mutated by every edit, so a row could move behind the cursor mid-sweep
    // and be skipped, and its microsecond precision does not survive the
    // JS Date round-trip either.
    const keyset = cursor ? lt(programs.id, cursor.id) : undefined;

    // Programs matching directly, plus programs owning a matching episode.
    const viaEpisode = this.db
      .select({ id: seasons.programId })
      .from(episodes)
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .where(and(isNull(episodes.deletedAt), this.episodeMatch(query)));

    const where = and(
      isNull(programs.deletedAt),
      or(this.programMatch(query), inArray(programs.id, viaEpisode)),
    );

    const rows = await this.db
      .select({ program: programCols })
      .from(programs)
      .where(and(where, keyset))
      .orderBy(desc(programs.id))
      .limit(limit + 1);

    const [totalRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(programs)
      .where(where);

    const page = rows.slice(0, limit).map((r) => r.program);
    const genreMap = await this.genresFor(page.map((p) => p.id));

    // Which of these matched on their own text (vs only via an episode)?
    const directIds = new Set(
      page.length
        ? (
            await this.db
              .select({ id: programs.id })
              .from(programs)
              .where(
                and(
                  inArray(
                    programs.id,
                    page.map((p) => p.id),
                  ),
                  this.programMatch(query),
                ),
              )
          ).map((r) => r.id)
        : [],
    );

    // ONE query for every program on the page, not one per program: a
    // per-program loop meant up to `limit` serial round-trips against a pool of
    // 10, on a public endpoint. Program-matched rows take all their episodes;
    // episode-matched rows take only the episodes that matched.
    const pageIds = page.map((p) => p.id);
    const directList = [...directIds];
    const episodeRows = pageIds.length
      ? await this.db
          .select({ episode: episodeCols, seasonNumber: seasons.number, programId: seasons.programId })
          .from(episodes)
          .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
          .where(
            and(
              inArray(seasons.programId, pageIds),
              isNull(episodes.deletedAt),
              directList.length > 0
                ? or(inArray(seasons.programId, directList), this.episodeMatch(query))
                : this.episodeMatch(query),
            ),
          )
          .orderBy(asc(seasons.number), asc(episodes.number))
      : [];

    const byProgram = new Map<string, EpisodeSummaryView[]>();
    for (const r of episodeRows) {
      const list = byProgram.get(r.programId) ?? [];
      // Cap the per-program payload: an unbounded list let one request
      // serialize an entire program's catalogue for every result on the page.
      if (list.length < MAX_EPISODES_PER_SEARCH_RESULT) {
        list.push(this.toEpisodeSummary(r.episode, r.seasonNumber));
      }
      byProgram.set(r.programId, list);
    }

    const results = page.map((p) => ({
      ...this.toSummary(p, genreMap),
      matchedBy: directIds.has(p.id) ? "program" : "episode",
      episodes: byProgram.get(p.id) ?? [],
    }));

    return {
      query,
      total: totalRow?.total ?? 0,
      nextCursor:
        rows.length > limit && page.length > 0
          ? encodeCursor({ id: page[page.length - 1]!.id })
          : null,
      programs: results.map(({ updatedAt: _updatedAt, ...rest }) => rest),
    };
  }

  // ------------------------------------------------------------ operator

  /**
   * Validates uploads are ready and unattached.
   *
   * This is a friendly pre-check for good error messages, NOT the guarantee:
   * the check and the later INSERT are separate statements, so concurrent
   * requests can both pass here. The partial unique index
   * `episodes_upload_live_uq` (migration 0003) is what actually enforces
   * one-live-episode-per-upload; callers map its 23505 to the same 409.
   *
   * `excludeEpisodeIds` are the episodes being updated in this same request —
   * an episode still holding its own upload must not count as a conflict, or
   * re-sending an unchanged episode body would spuriously 409.
   */
  private async assertUploadsUsable(
    uploadIds: string[],
    excludeEpisodeIds: string[] = [],
  ): Promise<Map<string, number>> {
    if (uploadIds.length === 0) return new Map();
    if (new Set(uploadIds).size !== uploadIds.length) {
      throw errors.conflict(
        "upload_already_attached",
        "An upload is referenced by more than one episode in this request",
      );
    }

    const rows = await this.db
      .select({ id: uploads.id, status: uploads.status, durationSec: uploads.durationSec })
      .from(uploads)
      .where(inArray(uploads.id, uploadIds));

    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of uploadIds) {
      const row = byId.get(id);
      if (!row) throw errors.notFound(`Upload ${id} not found`);
      if (row.status !== "ready") {
        throw errors.conflict("upload_not_ready", `Upload ${id} is not in ready state`);
      }
    }

    // The claim lives in episode_streams now (one row per angle, UNIQUE on
    // upload_id). Stream rows for soft-deleted episodes are removed at delete
    // time, so mere existence of a row means the upload is taken.
    const attached = await this.db
      .select({ uploadId: episodeStreams.uploadId })
      .from(episodeStreams)
      .where(
        and(
          inArray(episodeStreams.uploadId, uploadIds),
          excludeEpisodeIds.length > 0
            ? notInArray(episodeStreams.episodeId, excludeEpisodeIds)
            : undefined,
        ),
      );
    if (attached.length > 0) {
      throw errors.conflict(
        "upload_already_attached",
        `Upload ${attached[0]!.uploadId} is already attached to an episode`,
      );
    }

    return new Map(rows.map((r) => [r.id, r.durationSec ?? 0]));
  }

  /** Every stream list must have 1..n entries with unique angle names. */
  private static assertStreamNames(streams: { name: string }[], where: string): void {
    const names = streams.map((s) => s.name.trim());
    if (names.some((n) => n.length === 0)) {
      throw errors.validationFailed(`Stream names must be non-empty (${where})`);
    }
    if (new Set(names).size !== names.length) {
      throw errors.validationFailed(`Stream names must be unique within an episode (${where})`);
    }
  }

  /**
   * Validates numbering the database also enforces, so client mistakes come
   * back as 400s instead of unique-violation 500s.
   */
  private static assertNumbering(input: CreateProgramInput): void {
    const seasonNumbers = input.season.map((s) => s.number);
    if (new Set(seasonNumbers).size !== seasonNumbers.length) {
      throw errors.validationFailed("Season numbers must be unique within a program");
    }
    for (const s of input.season) {
      const episodeNumbers = s.episodes.map((e) => e.number);
      if (new Set(episodeNumbers).size !== episodeNumbers.length) {
        throw errors.validationFailed(
          `Episode numbers must be unique within season ${String(s.number)}`,
        );
      }
      for (const e of s.episodes) {
        CatalogService.assertStreamNames(
          e.streams,
          `season ${String(s.number)} episode ${String(e.number)}`,
        );
      }
    }
  }

  /** Maps the DB's own uniqueness guarantees onto the contract's 4xx codes. */
  private static rethrowConstraint(this: void, err: unknown): never {
    const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause;
    if (cause?.code === "23505") {
      if (cause.constraint_name === "episode_streams_upload_id_unique") {
        throw errors.conflict(
          "upload_already_attached",
          "Upload is already attached to an episode",
        );
      }
      throw errors.conflict("conflict", "Conflicts with existing catalog data");
    }
    throw err;
  }

  /** Create a program with its seasons and episodes (spec §7.1). */
  async createProgram(ownerAccountId: string, input: CreateProgramInput): Promise<ProgramView> {
    CatalogService.assertNumbering(input);
    const uploadIds = input.season.flatMap((s) =>
      s.episodes.flatMap((e) => e.streams.map((st) => st.uploadID)),
    );
    const durations = await this.assertUploadsUsable(uploadIds);

    // De-duplicated: the composite PK on program_genres would otherwise turn a
    // repeated genre id into a 500.
    const genreIDs = [...new Set(input.genreIDs)];
    const genreRows = await this.db
      .select({ id: genres.id })
      .from(genres)
      .where(and(inArray(genres.id, genreIDs), isNull(genres.deletedAt)));
    if (genreRows.length !== genreIDs.length) {
      throw errors.notFound("One or more genres not found");
    }

    const programId = await this.db.transaction(async (tx) => {
      const [program] = await tx
        .insert(programs)
        .values({
          ownerAccountId,
          title: input.title,
          description: input.description,
          thumbnailUrl: input.thumbnailURL,
        })
        .returning();

      await tx
        .insert(programGenres)
        .values(genreIDs.map((genreId) => ({ programId: program!.id, genreId })));

      for (const s of input.season) {
        const [season] = await tx
          .insert(seasons)
          .values({
            programId: program!.id,
            number: s.number,
            title: s.title,
            description: s.description,
          })
          .returning();

        if (s.episodes.length > 0) {
          const inserted = await tx
            .insert(episodes)
            .values(
              s.episodes.map((e) => ({
                seasonId: season!.id,
                number: e.number,
                title: e.title,
                description: e.description,
                // The default angle's validated upload defines the duration
                // (contract: the client-sent value is advisory only).
                durationSec: durations.get(e.streams[0]!.uploadID) ?? e.durationSec ?? 0,
                thumbnailUrl: e.thumbnailURL ?? null,
                publishedAt: new Date(e.publishedAt),
              })),
            )
            .returning({ id: episodes.id, number: episodes.number });

          const idByNumber = new Map(inserted.map((r) => [r.number, r.id]));
          await tx.insert(episodeStreams).values(
            s.episodes.flatMap((e) =>
              e.streams.map((st, i) => ({
                episodeId: idByNumber.get(e.number)!,
                name: st.name.trim(),
                uploadId: st.uploadID,
                sortOrder: i,
              })),
            ),
          );
        }
      }
      return program!.id;
    }).catch(CatalogService.rethrowConstraint);

    return this.getProgram(programId);
  }

  /** Partial update of a program and/or its episodes (spec §7.2). */
  async updateProgram(programId: string, input: UpdateProgramInput): Promise<ProgramView> {
    const [existing] = await this.db
      .select({ id: programs.id })
      .from(programs)
      .where(and(eq(programs.id, programId), isNull(programs.deletedAt)))
      .limit(1);
    if (!existing) throw errors.notFound("Program not found");

    const streamReplacements = (input.episodes ?? []).filter(
      (e): e is typeof e & { streams: { name: string; uploadID: string }[] } =>
        Array.isArray(e.streams),
    );
    for (const e of streamReplacements) {
      CatalogService.assertStreamNames(e.streams, `episode ${e.episodeID}`);
    }
    const replacementUploads = streamReplacements.flatMap((e) =>
      e.streams.map((st) => st.uploadID),
    );

    // Episodes must belong to this program — otherwise an operator could edit
    // another program's episodes through this endpoint.
    const targetIds = (input.episodes ?? []).map((e) => e.episodeID);

    // Exclude the episodes being updated: an episode still holding its own
    // upload must not read as a conflict, or replaying an unchanged body 409s.
    const durations = await this.assertUploadsUsable(replacementUploads, targetIds);

    const genreIDs = input.genreIDs ? [...new Set(input.genreIDs)] : null;
    if (genreIDs) {
      const found = await this.db
        .select({ id: genres.id })
        .from(genres)
        .where(and(inArray(genres.id, genreIDs), isNull(genres.deletedAt)));
      if (found.length !== genreIDs.length) {
        throw errors.notFound("One or more genres not found");
      }
    }

    if (targetIds.length > 0) {
      if (new Set(targetIds).size !== targetIds.length) {
        throw errors.validationFailed("An episode is listed more than once");
      }
      const owned = await this.db
        .select({ id: episodes.id })
        .from(episodes)
        .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
        .where(
          and(
            inArray(episodes.id, targetIds),
            eq(seasons.programId, programId),
            isNull(episodes.deletedAt),
          ),
        );
      if (owned.length !== new Set(targetIds).size) {
        throw errors.notFound("One or more episodes not found in this program");
      }
    }

    await this.db
      .transaction(async (tx) => {
        const patch: Partial<typeof programs.$inferInsert> = {};
        if (input.title != null) patch.title = input.title;
        if (input.description != null) patch.description = input.description;
        if (input.thumbnailURL != null) patch.thumbnailUrl = input.thumbnailURL;

        const episodePatches = (input.episodes ?? [])
          .map((e) => {
            const ep: Partial<typeof episodes.$inferInsert> = {};
            if (e.title != null) ep.title = e.title;
            if (e.description != null) ep.description = e.description;
            if (e.thumbnailURL != null) ep.thumbnailUrl = e.thumbnailURL;
            if (e.publishedAt != null) ep.publishedAt = new Date(e.publishedAt);
            if (Array.isArray(e.streams)) {
              // The default angle's upload defines the episode duration.
              ep.durationSec = durations.get(e.streams[0]!.uploadID) ?? 0;
            }
            return { episodeID: e.episodeID, ep, streams: e.streams ?? null };
          })
          .filter(({ ep, streams }) => Object.keys(ep).length > 0 || streams !== null);

        const changed =
          Object.keys(patch).length > 0 || genreIDs !== null || episodePatches.length > 0;

        // Only touch updatedAt when something actually changed — a no-op body
        // must not reshuffle "recently updated" ordering.
        if (Object.keys(patch).length > 0 || episodePatches.length > 0 || genreIDs !== null) {
          patch.updatedAt = new Date();
          await tx.update(programs).set(patch).where(eq(programs.id, programId));
        }

        if (genreIDs) {
          await tx.delete(programGenres).where(eq(programGenres.programId, programId));
          if (genreIDs.length > 0) {
            await tx.insert(programGenres).values(genreIDs.map((genreId) => ({ programId, genreId })));
          }
        }

        for (const { episodeID, ep, streams } of episodePatches) {
          if (Object.keys(ep).length > 0) {
            ep.updatedAt = new Date();
            await tx.update(episodes).set(ep).where(eq(episodes.id, episodeID));
          }
          if (streams) {
            // Replace the full angle set. Delete-then-insert inside the tx is
            // safe against the UNIQUE(upload_id): re-sending the current set
            // frees the rows before re-claiming them.
            await tx.delete(episodeStreams).where(eq(episodeStreams.episodeId, episodeID));
            await tx.insert(episodeStreams).values(
              streams.map((st, i) => ({
                episodeId: episodeID,
                name: st.name.trim(),
                uploadId: st.uploadID,
                sortOrder: i,
              })),
            );
          }
        }
        return changed;
      })
      .catch(CatalogService.rethrowConstraint);

    return this.getProgram(programId);
  }

  /**
   * Logical delete (spec §7.3). Program deletion cascades to its episodes;
   * storage cleanup is the janitor's job (step 8).
   */
  async deleteProgram(programId: string) {
    const deletedAt = new Date();
    // One transaction: a partial cascade would leave live episodes under a
    // deleted program — still holding their uploads, invisible to every read,
    // and unreachable for deletion.
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(programs)
        .set({ deletedAt })
        .where(and(eq(programs.id, programId), isNull(programs.deletedAt)))
        .returning({ id: programs.id });
      if (updated.length === 0) throw errors.notFound("Program not found");

      await tx
        .update(episodes)
        .set({ deletedAt })
        .where(
          and(
            isNull(episodes.deletedAt),
            inArray(
              episodes.seasonId,
              tx.select({ id: seasons.id }).from(seasons).where(eq(seasons.programId, programId)),
            ),
          ),
        );

      // Release the episodes' stream claims: with the mapping rows gone, the
      // uploads become "unattached" and the janitor's storage-cleanup rule
      // applies. (Episode restore is not a v1 feature, so nothing needs them.)
      await tx.delete(episodeStreams).where(
        inArray(
          episodeStreams.episodeId,
          tx
            .select({ id: episodes.id })
            .from(episodes)
            .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
            .where(eq(seasons.programId, programId)),
        ),
      );
    });

    return {
      targetType: "program" as const,
      programID: programId,
      episodeID: null,
      deleted: true,
      deletedAt: deletedAt.toISOString(),
    };
  }

  async deleteEpisode(episodeId: string) {
    const [row] = await this.db
      .select({ episodeId: episodes.id, programId: seasons.programId })
      .from(episodes)
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .where(and(eq(episodes.id, episodeId), isNull(episodes.deletedAt)))
      .limit(1);
    if (!row) throw errors.notFound("Episode not found");

    const deletedAt = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(episodes).set({ deletedAt }).where(eq(episodes.id, episodeId));
      // Release the stream claims (see deleteProgram).
      await tx.delete(episodeStreams).where(eq(episodeStreams.episodeId, episodeId));
    });

    return {
      targetType: "episode" as const,
      programID: row.programId,
      episodeID: episodeId,
      deleted: true,
      deletedAt: deletedAt.toISOString(),
    };
  }
}
