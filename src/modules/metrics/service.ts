import { z } from "zod";
import type { Db } from "../../db/client.js";
import { playbackEvents } from "../../db/schema/index.js";
import { QUALITIES } from "../../lib/quality.js";

/**
 * Anonymous playback telemetry (spec §9). Fire-and-forget from the client's
 * point of view: the endpoint answers 202 whatever the payload, and invalid
 * events are dropped here rather than reported — a telemetry failure must
 * never surface in the player.
 */
export const playbackEventSchema = z
  .object({
    episodeID: z.string().uuid(),
    event: z.enum(["start", "progress", "complete", "error"]),
    positionSec: z.number().finite().min(0).max(7 * 24 * 60 * 60),
    quality: z.enum(QUALITIES).nullable().optional(),
    sessionUUID: z.string().uuid(),
  })
  .strict();

export type PlaybackEventInput = z.infer<typeof playbackEventSchema>;

export type RecordOutcome = "stored" | "dropped" | "failed";

export class MetricsService {
  constructor(
    private readonly db: Db,
    private readonly log?: { warn: (o: unknown, m?: string) => void; debug: (o: unknown, m?: string) => void },
  ) {}

  /**
   * Validates and stores one event. Never throws: an invalid body is dropped
   * (debug-logged, since a buggy client build would otherwise go unnoticed),
   * a database failure is warned about and the event is lost — telemetry is
   * not worth a retry queue in v1.
   */
  async record(body: unknown): Promise<RecordOutcome> {
    const parsed = playbackEventSchema.safeParse(body);
    if (!parsed.success) {
      this.log?.debug({ issues: parsed.error.issues.map((i) => i.path.join(".")) }, "playback event dropped");
      return "dropped";
    }
    const e = parsed.data;
    try {
      await this.db.insert(playbackEvents).values({
        episodeId: e.episodeID,
        event: e.event,
        positionSec: e.positionSec,
        quality: e.quality ?? null,
        sessionUuid: e.sessionUUID,
      });
      return "stored";
    } catch (err) {
      this.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "playback event not stored");
      return "failed";
    }
  }
}
