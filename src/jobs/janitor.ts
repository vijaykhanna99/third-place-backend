import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { episodeStreams, episodes, genres, images, programs, uploads } from "../db/schema/index.js";
import { publicMediaPath } from "../lib/media-url.js";
import type { Storage } from "../lib/storage.js";
import { mediaPrefixFor, tempKeyFor } from "./keys.js";
import { SCRATCH_PREFIX, type Log, scratchRoot } from "./lifecycle.js";

/**
 * Janitor (spec §8.5, §7.3, §8.4): the scheduled sweep that reclaims what the
 * request path deliberately leaves behind.
 *
 *   - temp archives of failed uploads, 7 days after the failure (spec §8.4)
 *   - handshakes that never completed, 7 days after initiate (their presigned
 *     URL expired after 6 hours; the row would otherwise sit in `uploading` forever)
 *   - `ready` uploads nobody attached, 14 days after they became ready (spec §8.5)
 *   - media of deleted episodes, 30 days after detachment (spec §7.3)
 *   - thumbnails no program, episode or genre references, 14 days after upload
 *   - scratch directories a dead worker left behind, once they are old enough
 *     that no live extraction can still be using them
 *   - playback_events partitions for the coming months, created ahead of time
 *     (migration 0001 explains why this must never be left to the default partition)
 *
 * Every rule is a plain function over the database and storage so it can run
 * under a test with a pinned clock; worker.ts schedules it, the CLI runs it on demand.
 */
export interface JanitorDeps {
  db: Db;
  storage: Storage;
  log?: Log;
  scratchDir?: string;
}

export interface JanitorOptions {
  now?: Date;
  /** Temp archives (failed and abandoned uploads) live this long. */
  tempRetentionMs?: number;
  /** A `ready` upload that was never attached is reclaimed after this. */
  unattachedRetentionMs?: number;
  /** A detached upload (its episode was deleted or replaced) is reclaimed after this. */
  detachedRetentionMs?: number;
  /** An unreferenced thumbnail is removed after this. */
  imageRetentionMs?: number;
  /** Scratch directories untouched for this long are not in use. */
  scratchMaxAgeMs?: number;
  /** Partitions are kept this many months ahead of `now`. */
  partitionMonthsAhead?: number;
  /** Rows handled per rule per run; the next run takes the rest. */
  batch?: number;
}

export interface JanitorReport {
  abandonedUploads: string[];
  tempArchivesDeleted: string[];
  reclaimedUploads: string[];
  orphanImagesDeleted: string[];
  scratchRemoved: string[];
  partitionsCreated: string[];
  /** Rows sitting in playback_events_default — must be zero; see migration 0001. */
  defaultPartitionRows: number;
  errors: string[];
}

const DAY = 24 * 60 * 60 * 1000;
export const JANITOR_DEFAULTS = {
  tempRetentionMs: 7 * DAY,
  unattachedRetentionMs: 14 * DAY,
  detachedRetentionMs: 30 * DAY,
  imageRetentionMs: 14 * DAY,
  scratchMaxAgeMs: 6 * 60 * 60 * 1000,
  partitionMonthsAhead: 2,
  batch: 200,
} as const;

/** `playback_events_YYYY_MM` and its [from, to) bounds for the month containing `date`, offset by `plus` months. */
export function monthPartition(date: Date, plus = 0): { name: string; from: string; to: string } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + plus, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const tag = `${String(start.getUTCFullYear())}_${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { name: `playback_events_${tag}`, from: start.toISOString(), to: end.toISOString() };
}

/** Does any catalog row point at this image? Matched on the public path, so a changed media origin cannot orphan everything. */
export function isReferenced(imageKey: string, thumbnailUrls: Iterable<string>): boolean {
  const suffix = `/${publicMediaPath(imageKey)}`;
  for (const url of thumbnailUrls) if (url.endsWith(suffix)) return true;
  return false;
}

export async function runJanitor(deps: JanitorDeps, opts: JanitorOptions = {}): Promise<JanitorReport> {
  const { db, storage, log } = deps;
  const o = { ...JANITOR_DEFAULTS, ...opts };
  const now = opts.now ?? new Date();
  const before = (ms: number) => new Date(now.getTime() - ms);
  const report: JanitorReport = {
    abandonedUploads: [],
    tempArchivesDeleted: [],
    reclaimedUploads: [],
    orphanImagesDeleted: [],
    scratchRemoved: [],
    partitionsCreated: [],
    defaultPartitionRows: 0,
    errors: [],
  };
  const failure = (rule: string, err: unknown) => {
    const message = `${rule}: ${err instanceof Error ? err.message : String(err)}`;
    report.errors.push(message);
    log?.warn({ rule, err: err instanceof Error ? err.message : String(err) }, "janitor rule failed");
  };

  // 1. Handshakes that never completed.
  try {
    const abandoned = await db
      .select({ id: uploads.id })
      .from(uploads)
      .where(and(eq(uploads.status, "uploading"), lt(uploads.createdAt, before(o.tempRetentionMs))))
      .limit(o.batch);
    for (const row of abandoned) {
      await storage.delete([tempKeyFor(row.id)]);
      const [updated] = await db
        .update(uploads)
        .set({ status: "failed", error: "abandoned: upload never completed", tempDeletedAt: now })
        .where(and(eq(uploads.id, row.id), eq(uploads.status, "uploading")))
        .returning({ id: uploads.id });
      if (updated) report.abandonedUploads.push(row.id);
    }
  } catch (err) {
    failure("abandoned uploads", err);
  }

  // 2. Temp archives of failed uploads (kept 7 days for investigation, spec §8.4).
  try {
    const expired = await db
      .select({ id: uploads.id })
      .from(uploads)
      .where(
        and(
          eq(uploads.status, "failed"),
          isNull(uploads.tempDeletedAt),
          lt(uploads.updatedAt, before(o.tempRetentionMs)),
        ),
      )
      .limit(o.batch);
    for (const row of expired) {
      await storage.delete([tempKeyFor(row.id)]);
      await db.update(uploads).set({ tempDeletedAt: now }).where(eq(uploads.id, row.id));
      report.tempArchivesDeleted.push(row.id);
    }
  } catch (err) {
    failure("expired temp archives", err);
  }

  // 3. Ready uploads nobody is using: never attached (14 days) or detached (30 days).
  try {
    const attached = db
      .select({ one: sql`1` })
      .from(episodeStreams)
      .where(eq(episodeStreams.uploadId, uploads.id));
    const unused = await db
      .select({ id: uploads.id, detachedAt: uploads.detachedAt })
      .from(uploads)
      .where(
        and(
          eq(uploads.status, "ready"),
          notExists(attached),
          or(
            and(isNull(uploads.detachedAt), lt(uploads.updatedAt, before(o.unattachedRetentionMs))),
            lt(uploads.detachedAt, before(o.detachedRetentionMs)),
          ),
        ),
      )
      .limit(o.batch);
    for (const row of unused) {
      const reason =
        row.detachedAt === null
          ? `reclaimed: not attached to any episode within ${String(Math.round(o.unattachedRetentionMs / DAY))} days`
          : `reclaimed: detached from its episode for ${String(Math.round(o.detachedRetentionMs / DAY))} days`;
      // Claim the row first: a concurrent attach after this point is refused by
      // the CMS (status is no longer `ready`), so the objects can go safely.
      const [claimed] = await db
        .update(uploads)
        .set({ status: "failed", error: reason, playlistKey: null, tempDeletedAt: now })
        .where(and(eq(uploads.id, row.id), eq(uploads.status, "ready")))
        .returning({ id: uploads.id });
      if (!claimed) continue;
      await storage.deletePrefix(mediaPrefixFor(row.id));
      await storage.delete([tempKeyFor(row.id)]);
      report.reclaimedUploads.push(row.id);
      log?.info({ uploadId: row.id, reason }, "upload reclaimed");
    }
  } catch (err) {
    failure("unused uploads", err);
  }

  // 4. Thumbnails nothing references.
  try {
    const candidates = await db
      .select({ id: images.id, key: images.r2Key })
      .from(images)
      .where(lt(images.createdAt, before(o.imageRetentionMs)))
      .limit(o.batch);
    if (candidates.length > 0) {
      const referenced = new Set<string>();
      for (const table of [programs, episodes, genres]) {
        const rows = await db
          .selectDistinct({ url: table.thumbnailUrl })
          .from(table)
          .where(sql`${table.thumbnailUrl} IS NOT NULL`);
        for (const r of rows) if (r.url) referenced.add(r.url);
      }
      for (const image of candidates) {
        if (isReferenced(image.key, referenced)) continue;
        await storage.delete([image.key]);
        await db.delete(images).where(eq(images.id, image.id));
        report.orphanImagesDeleted.push(image.id);
      }
    }
  } catch (err) {
    failure("orphan images", err);
  }

  // 5. Scratch directories no extraction can still be using.
  try {
    report.scratchRemoved = await sweepStaleScratch(scratchRoot(deps.scratchDir), before(o.scratchMaxAgeMs), log);
  } catch (err) {
    failure("scratch sweep", err);
  }

  // 6. Partition maintenance for playback_events (see migration 0001).
  for (let plus = 0; plus <= o.partitionMonthsAhead; plus++) {
    const p = monthPartition(now, plus);
    try {
      const [exists] = await db.execute<{ found: boolean }>(
        sql`SELECT to_regclass(${p.name}) IS NOT NULL AS found`,
      );
      if (exists?.found) continue;
      // DDL takes no bind parameters; the bounds are ISO strings we generated.
      await db.execute(
        sql`CREATE TABLE ${sql.identifier(p.name)} PARTITION OF playback_events FOR VALUES FROM (${sql.raw(`'${p.from}'`)}) TO (${sql.raw(`'${p.to}'`)})`,
      );
      report.partitionsCreated.push(p.name);
      log?.info({ partition: p.name }, "playback_events partition created");
    } catch (err) {
      // Most likely cause: the default partition already holds rows for this
      // month. Migration 0001 documents the manual recovery.
      failure(`partition ${p.name}`, err);
    }
  }
  try {
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ONLY playback_events_default`);
    report.defaultPartitionRows = row?.n ?? 0;
    if (report.defaultPartitionRows > 0) {
      log?.warn(
        { rows: report.defaultPartitionRows },
        "playback_events_default holds rows: a monthly partition is missing (see migration 0001)",
      );
    }
  } catch (err) {
    failure("default partition check", err);
  }

  log?.info(
    {
      abandoned: report.abandonedUploads.length,
      tempArchives: report.tempArchivesDeleted.length,
      reclaimed: report.reclaimedUploads.length,
      orphanImages: report.orphanImagesDeleted.length,
      scratch: report.scratchRemoved.length,
      partitions: report.partitionsCreated,
      defaultPartitionRows: report.defaultPartitionRows,
      errors: report.errors.length,
    },
    "janitor sweep done",
  );
  return report;
}

/**
 * Removes our scratch directories whose newest file is older than `cutoff`.
 * Unlike the startup sweep, this runs beside live extractions, so age is the
 * guard: a directory still being written to is never older than the cutoff.
 */
export async function sweepStaleScratch(root: string, cutoff: Date, log?: Log): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    log?.warn({ root, err: err instanceof Error ? err.message : String(err) }, "scratch sweep skipped");
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const path = join(root, name);
    try {
      let newest = (await stat(path)).mtimeMs;
      for (const child of await readdir(path).catch(() => [] as string[])) {
        const s = await stat(join(path, child)).catch(() => null);
        if (s && s.mtimeMs > newest) newest = s.mtimeMs;
      }
      if (newest >= cutoff.getTime()) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch (err) {
      log?.warn({ path, err: err instanceof Error ? err.message : String(err) }, "scratch dir not removed");
    }
  }
  if (removed.length > 0) log?.info({ root, removed: removed.length }, "stale scratch directories removed");
  return removed;
}
