import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { episodeStreams, episodes, programs, seasons } from "../../db/schema/index.js";
import { errors } from "../../lib/errors.js";
import type { StreamUrlIssuer } from "./stream-urls.js";

export interface StreamsResponse {
  episodeID: string;
  streams: { name: string; streamURL: string }[];
  expiresAt: string;
}

/**
 * Stream-URL issuance (spec §5.3): all camera angles of one live episode,
 * presentation order, each with a fresh token and one shared expiry.
 *
 * A logically deleted episode — or an episode of a deleted program — stops
 * being issued tokens immediately (spec §7.3); tokens already in the wild die
 * within the TTL on their own.
 */
export class MediaService {
  constructor(
    private readonly db: Db,
    private readonly issuer: StreamUrlIssuer,
  ) {}

  async streamsFor(episodeId: string): Promise<StreamsResponse> {
    const [live] = await this.db
      .select({ id: episodes.id })
      .from(episodes)
      .innerJoin(seasons, eq(episodes.seasonId, seasons.id))
      .innerJoin(programs, eq(seasons.programId, programs.id))
      .where(and(eq(episodes.id, episodeId), isNull(episodes.deletedAt), isNull(programs.deletedAt)))
      .limit(1);
    if (!live) throw errors.notFound("Episode not found");

    const rows = await this.db
      .select({ name: episodeStreams.name, uploadId: episodeStreams.uploadId })
      .from(episodeStreams)
      .where(eq(episodeStreams.episodeId, episodeId))
      .orderBy(asc(episodeStreams.sortOrder), asc(episodeStreams.id));
    // Every live episode carries at least one angle (CMS invariant); a row
    // without any is unplayable and must not be answered with an empty list.
    if (rows.length === 0) throw errors.notFound("Episode has no streams");

    const now = new Date();
    return {
      episodeID: episodeId,
      streams: rows.map((r) => ({ name: r.name, streamURL: this.issuer.issue(r.uploadId, now).url })),
      expiresAt: this.issuer.expiresAt(now).toISOString(),
    };
  }
}
