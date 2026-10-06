import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { uploads } from "../db/schema/index.js";
import type { ExtractionDeps } from "./extraction.js";
import { mediaPrefixFor } from "./keys.js";

/**
 * Recovery of uploads stuck in `processing`.
 *
 * A worker killed mid-extraction (SIGKILL, OOM, host loss) never reaches its
 * finally block, so its row stays `processing` with nothing to move it on.
 * Two paths pull such rows back:
 *   - a queue redelivery for the same upload reclaims it in processUpload()
 *     once it is older than the threshold (see claimUpload);
 *   - the worker sweeps at startup and periodically, requeueing stuck rows —
 *     or failing them once they have been recovered MAX_RECOVERIES times, so
 *     an archive that reliably crashes the worker cannot loop forever.
 */
export const DEFAULT_STUCK_AFTER_MS = 30 * 60 * 1000;

/** Recoveries allowed before a stuck upload is failed instead of requeued. */
export const MAX_RECOVERIES = 2;

export const STUCK_ERROR_CODE = "stuck_processing";

/** A `processing` row is stuck when its claim is older than the threshold (or predates the column). */
export function isStuck(
  processingStartedAt: Date | null,
  stuckAfterMs: number,
  now: Date = new Date(),
): boolean {
  if (processingStartedAt === null) return true;
  return now.getTime() - processingStartedAt.getTime() > stuckAfterMs;
}

export interface RecoveryOptions {
  stuckAfterMs?: number;
  /** Re-enqueues an upload for extraction. Omit to only reset rows (a queue redelivery will pick them up). */
  enqueue?: (uploadId: string) => Promise<void>;
  now?: Date;
}

export interface RecoveryResult {
  requeued: string[];
  failed: string[];
}

/**
 * Sweeps every stuck `processing` row. Each transition is a compare-and-swap
 * on (status, processing_started_at), so a worker that is in fact still
 * working on the row — it would have refreshed nothing, but another sweep may
 * have moved it first — can never be raced into a double requeue.
 */
export async function recoverStuckUploads(
  deps: ExtractionDeps,
  opts: RecoveryOptions = {},
): Promise<RecoveryResult> {
  const { db, log } = deps;
  const stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - stuckAfterMs);

  const stuck = await db
    .select({
      id: uploads.id,
      processingStartedAt: uploads.processingStartedAt,
      recoveryCount: uploads.recoveryCount,
    })
    .from(uploads)
    .where(
      and(
        eq(uploads.status, "processing"),
        or(isNull(uploads.processingStartedAt), lt(uploads.processingStartedAt, cutoff)),
      ),
    );

  const result: RecoveryResult = { requeued: [], failed: [] };
  for (const row of stuck) {
    const owned = and(
      eq(uploads.id, row.id),
      eq(uploads.status, "processing"),
      row.processingStartedAt === null
        ? isNull(uploads.processingStartedAt)
        : eq(uploads.processingStartedAt, row.processingStartedAt),
    );

    if (row.recoveryCount >= MAX_RECOVERIES) {
      const [failed] = await db
        .update(uploads)
        .set({
          status: "failed",
          error: `${STUCK_ERROR_CODE}: extraction did not complete after ${String(row.recoveryCount)} recoveries`,
        })
        .where(owned)
        .returning({ id: uploads.id });
      if (!failed) continue;
      await cleanPrefix(deps, row.id);
      result.failed.push(row.id);
      log?.warn({ uploadId: row.id, recoveries: row.recoveryCount }, "stuck upload failed");
      continue;
    }

    const [requeued] = await db
      .update(uploads)
      .set({
        status: "queued",
        processingStartedAt: null,
        recoveryCount: sql`${uploads.recoveryCount} + 1`,
      })
      .where(owned)
      .returning({ id: uploads.id });
    if (!requeued) continue;
    await cleanPrefix(deps, row.id);
    if (opts.enqueue) await opts.enqueue(row.id);
    result.requeued.push(row.id);
    log?.warn({ uploadId: row.id, recoveries: row.recoveryCount + 1 }, "stuck upload requeued");
  }

  return result;
}

/** Removes whatever a dead worker left under the upload's media prefix. */
async function cleanPrefix(deps: ExtractionDeps, uploadId: string): Promise<void> {
  try {
    await deps.storage.deletePrefix(mediaPrefixFor(uploadId));
  } catch (err) {
    deps.log?.warn(
      { uploadId, err: err instanceof Error ? err.message : String(err) },
      "could not clean media prefix of stuck upload",
    );
  }
}
