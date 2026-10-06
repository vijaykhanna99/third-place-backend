import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, isNull, sql } from "drizzle-orm";
import yauzl from "yauzl";
import type { Db } from "../db/client.js";
import { uploads } from "../db/schema/index.js";
import { isMasterPlaylist, parseMaster, parseMedia, resolveRelative } from "../lib/hls.js";
import type { Storage } from "../lib/storage.js";
import {
  ZIP_LIMITS,
  isDirectoryEntry,
  isRejection,
  planExtraction,
  type ZipEntryInfo,
  type ZipLimits,
} from "../lib/zip.js";
import { mediaPrefixFor, tempKeyFor } from "./keys.js";
import { DEFAULT_STUCK_AFTER_MS, MAX_RECOVERIES, STUCK_ERROR_CODE, isStuck } from "./recovery.js";

export interface ExtractionDeps {
  db: Db;
  storage: Storage;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  /** Age after which a `processing` row counts as abandoned and may be reclaimed. */
  stuckAfterMs?: number;
  /** Overrides for the numeric archive limits (per-entry cap from env, smaller caps in tests). */
  limits?: Partial<ZipLimits>;
}

/**
 * Delivery context from the queue. `attempt` is 1-based; a transient failure
 * before the last attempt leaves the row retryable, the last attempt marks it
 * failed. Direct callers (tests, one-off tooling) get a single attempt.
 */
export interface ProcessContext {
  attempt?: number;
  maxAttempts?: number;
}

export { mediaPrefixFor, tempKeyFor };

const CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot).toLowerCase()]) ?? "application/octet-stream";
}

/** A rejection the operator caused: fail the upload, never retry it. */
class ExtractionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // lazyEntries so we control the pace; autoClose off so we can re-read.
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) reject(translateZipError(err ?? new Error("Failed to open archive")));
      else resolve(zip);
    });
  });
}

/**
 * Maps yauzl's own integrity errors onto operator-facing rejections. Anything
 * not recognised stays a plain Error, i.e. a retryable infrastructure fault.
 */
function translateZipError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  // yauzl refuses traversal entries itself — defense in depth behind our own
  // check. Translate so the operator sees the real reason.
  if (/invalid relative path|absolute path/i.test(err.message)) {
    return new ExtractionError("unsafe_path", `Unsafe path in archive: ${err.message}`);
  }
  // A central directory whose sizes do not match the entry data (lying header).
  if (/too many bytes|not enough bytes|size mismatch for stored file/i.test(err.message)) {
    return new ExtractionError("entry_size_mismatch", `Archive entry size mismatch: ${err.message}`);
  }
  if (/invalid|corrupt|unsupported|not a zip|end of central directory/i.test(err.message)) {
    return new ExtractionError("invalid_archive", `Archive could not be read: ${err.message}`);
  }
  return err;
}

interface ArchiveEntry {
  info: ZipEntryInfo;
  entry: yauzl.Entry;
}

/**
 * Reads the central directory without extracting anything. Directory entries
 * are dropped as they stream past and the file count is enforced as it grows,
 * so memory is bounded by the limit rather than by whatever the archive claims.
 */
function readEntries(zip: yauzl.ZipFile, maxFiles: number): Promise<ArchiveEntry[]> {
  return new Promise((resolve, reject) => {
    const out: ArchiveEntry[] = [];
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(translateZipError(err));
    };
    zip.on("entry", (entry: yauzl.Entry) => {
      if (settled) return;
      if (!isDirectoryEntry(entry.fileName)) {
        if (out.length >= maxFiles) {
          fail(
            new ExtractionError(
              "too_many_files",
              `Archive contains more than ${String(maxFiles)} files`,
            ),
          );
          return;
        }
        out.push({
          info: {
            fileName: entry.fileName,
            uncompressedSize: entry.uncompressedSize,
            externalFileAttributes: entry.externalFileAttributes,
          },
          entry,
        });
      }
      zip.readEntry();
    });
    zip.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(out);
      }
    });
    zip.on("error", fail);
    zip.readEntry();
  });
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(translateZipError(err ?? new Error("Failed to read archive entry")));
      else resolve(stream);
    });
  });
}

/** What a single entry may expand to: the tightest of its own header and our caps. */
interface EntryBudget {
  declared: number;
  cap: number;
}

/**
 * Pass-through that aborts the moment an entry grows past its budget. This is
 * the ZIP-bomb guard that matters: central-directory sizes are untrusted, so
 * the cap is applied to the bytes actually inflating out of the archive.
 */
class ByteLimit extends Transform {
  bytes = 0;
  constructor(private readonly budget: EntryBudget) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    const limit = Math.min(this.budget.declared, this.budget.cap);
    if (this.bytes > limit) {
      cb(
        this.budget.declared <= this.budget.cap
          ? new ExtractionError("entry_size_mismatch", "Archive entry exceeds its declared size")
          : new ExtractionError("too_large", "Archive entry exceeds the size limit"),
      );
      return;
    }
    cb(null, chunk);
  }
}

/**
 * Inflates one entry through the byte limit and into `sink`, which consumes
 * the limited stream (to storage, or into memory for small text entries).
 * Resolves to the number of bytes the entry really expanded to.
 */
async function extractEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  budget: EntryBudget,
  sink: (body: Readable) => Promise<void>,
): Promise<number> {
  const source = await openEntryStream(zip, entry);
  const limiter = new ByteLimit(budget);
  const piped = pipeline(source, limiter);
  // If the sink gives up (storage outage) nothing would drain the limiter and
  // the pipeline would hang on backpressure — tear it down with the sink's error.
  const consumed = sink(limiter).catch((err: unknown) => {
    limiter.destroy(err instanceof Error ? err : new Error(String(err)));
    throw err;
  });
  const [p, c] = await Promise.allSettled([piped, consumed]);
  // The pipeline error carries the operator-facing reason (limit, bad header);
  // the sink's is the infrastructure one. Prefer the former.
  if (p.status === "rejected") throw translateZipError(p.reason);
  if (c.status === "rejected") throw c.reason;
  return limiter.bytes;
}

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Entries that are parsed for validation and therefore held in memory (bounded by maxTextBytes). */
function isTextEntry(path: string): boolean {
  return path.endsWith(".m3u8") || path.endsWith(".vtt");
}

/**
 * Runs the full upload pipeline for one upload (spec §8.4):
 *   download ZIP → validate central directory → extract entry-by-entry to
 *   storage → verify playlist integrity → publish or roll back.
 *
 * Written as a plain function (not a BullMQ handler) so tests can drive it
 * directly with a real database and real storage, no queue involved.
 */
export async function processUpload(
  deps: ExtractionDeps,
  uploadId: string,
  ctx: ProcessContext = {},
): Promise<void> {
  const { db, storage } = deps;
  const attempt = ctx.attempt ?? 1;
  const maxAttempts = ctx.maxAttempts ?? 1;
  const log = deps.log;

  const [upload] = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
  if (!upload) {
    // The row was deleted between enqueue and pickup. Retrying cannot help, so
    // treat it as done rather than burning the retry budget on a 404.
    log?.warn({ uploadId }, "extraction skipped: upload no longer exists");
    return;
  }
  // Only queued work is processed — plus a `processing` row whose worker
  // evidently died, once it is older than the threshold. Anything else is a
  // duplicate delivery.
  const now = new Date();
  const stuck =
    upload.status === "processing" &&
    isStuck(upload.processingStartedAt, deps.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS, now);
  if (upload.status !== "queued" && !stuck) return;

  // Atomic claim: the predicates make this a compare-and-swap on exactly the
  // row state we observed, so two workers handed the same upload (duplicate
  // delivery, stalled-job redispatch) can never both extract into one prefix.
  const observed = and(
    eq(uploads.id, uploadId),
    eq(uploads.status, upload.status),
    upload.processingStartedAt === null
      ? isNull(uploads.processingStartedAt)
      : eq(uploads.processingStartedAt, upload.processingStartedAt),
  );

  if (stuck && upload.recoveryCount >= MAX_RECOVERIES) {
    // Recovered too often already: whatever this archive does to a worker,
    // it is not going to succeed. Fail it rather than loop.
    const [failed] = await db
      .update(uploads)
      .set({
        status: "failed",
        error: `${STUCK_ERROR_CODE}: extraction did not complete after ${String(upload.recoveryCount)} recoveries`,
      })
      .where(observed)
      .returning({ id: uploads.id });
    if (failed) {
      await storage.deletePrefix(mediaPrefixFor(uploadId));
      log?.warn({ uploadId, recoveries: upload.recoveryCount }, "stuck upload failed");
    }
    return;
  }

  const [claimed] = await db
    .update(uploads)
    .set({
      status: "processing",
      processingStartedAt: now,
      error: null,
      ...(stuck ? { recoveryCount: sql`${uploads.recoveryCount} + 1` } : {}),
    })
    .where(observed)
    .returning();
  if (!claimed) {
    log?.info({ uploadId }, "extraction skipped: claimed by another worker");
    return;
  }
  if (stuck) {
    // The dead worker may have published part of the bundle; start clean.
    log?.warn({ uploadId, recoveries: claimed.recoveryCount }, "reclaiming stuck upload");
    await storage.deletePrefix(mediaPrefixFor(uploadId));
  }

  const limits: ZipLimits = { ...ZIP_LIMITS, ...deps.limits };
  const tempKey = tempKeyFor(uploadId);
  const mediaPrefix = mediaPrefixFor(uploadId);
  const scratch = await mkdtemp(join(tmpdir(), `tplace-upload-${uploadId}-`));
  const localZip = join(scratch, "upload.zip");
  let zip: yauzl.ZipFile | undefined;

  /**
   * Terminal failure. The UPDATE is conditional on the row still being ours
   * (`processing`): a row another worker has since published as `ready` is
   * never downgraded, and its objects are never touched.
   */
  const fail = async (code: string, message: string): Promise<void> => {
    const [row] = await db
      .update(uploads)
      .set({ status: "failed", error: `${code}: ${message}` })
      .where(and(eq(uploads.id, uploadId), eq(uploads.status, "processing")))
      .returning({ id: uploads.id });
    if (!row) {
      log?.warn({ uploadId, code }, "upload no longer processing: failure not recorded");
      return;
    }
    // Nothing half-published: remove anything already written. A rollback
    // failure is logged — orphaned objects must never go unnoticed.
    try {
      await storage.deletePrefix(mediaPrefix);
    } catch (err) {
      log?.warn(
        { uploadId, err: err instanceof Error ? err.message : String(err) },
        "rollback failed: published objects may be orphaned",
      );
    }
    log?.warn({ uploadId, code, message }, "upload extraction failed");
  };

  /** Hands the row back to the queue so the next delivery can claim it. */
  const release = async (reason: string): Promise<void> => {
    await db
      .update(uploads)
      .set({ status: "queued" })
      .where(and(eq(uploads.id, uploadId), eq(uploads.status, "processing")));
    log?.warn({ uploadId, attempt, maxAttempts, reason }, "transient extraction failure: retrying");
  };

  try {
    // 1. Pull the archive down, verifying the operator-declared checksum as we
    //    stream (spec §8.2 — the checksum is the integrity gate).
    const hash = createHash("sha256");
    const source = await storage.getStream(tempKey);
    source.on("data", (c: Buffer) => hash.update(c));
    await pipeline(source, createWriteStream(localZip));
    const digest = hash.digest("hex");
    if (digest !== upload.checksum.toLowerCase()) {
      await fail("checksum_mismatch", "Stored object does not match the declared checksum");
      return;
    }

    // 2. Central-directory validation — before a single byte is extracted.
    zip = await openZip(localZip);
    const archive = await readEntries(zip, limits.maxFiles);
    const entryFor = new Map<ZipEntryInfo, yauzl.Entry>(archive.map((a) => [a.info, a.entry]));

    const plan = planExtraction(
      archive.map((a) => a.info),
      limits,
    );
    if (isRejection(plan)) {
      await fail(plan.code, plan.message);
      return;
    }
    const planned = new Set(plan.files.map((f) => f.path));

    // 3. Inflate the small text entries (playlists, subtitles) into memory and
    //    validate the whole bundle against the planned file set BEFORE any
    //    segment moves: a broken bundle must not cost gigabytes of transfer.
    let extractedBytes = 0;
    const budgetFor = (entry: ZipEntryInfo, cap: number): EntryBudget => ({
      declared: entry.uncompressedSize,
      cap: Math.min(cap, limits.maxTotalBytes - extractedBytes),
    });

    const texts = new Map<string, Buffer>();
    for (const { entry, path } of plan.files) {
      if (!isTextEntry(path)) continue;
      let buf!: Buffer;
      extractedBytes += await extractEntry(
        zip,
        entryFor.get(entry)!,
        budgetFor(entry, limits.maxTextBytes),
        async (body) => {
          buf = await collect(body);
        },
      );
      texts.set(path, buf);
    }

    const playlists = new Map<string, string>();
    for (const [path, buf] of texts) {
      if (path.endsWith(".m3u8")) playlists.set(path, buf.toString("utf8"));
    }

    // 4. Playlist integrity: every URI a playlist references must exist among
    //    the files this archive will publish (spec §8.4).
    const masterText = playlists.get(plan.masterPath);
    if (!masterText || !isMasterPlaylist(masterText)) {
      await fail("invalid_master_playlist", "index.m3u8 is not a valid HLS master playlist");
      return;
    }

    const master = parseMaster(masterText);
    if (master.variants.length === 0) {
      await fail("invalid_master_playlist", "Master playlist declares no variant streams");
      return;
    }

    const referenced: { from: string; uri: string }[] = [
      ...master.variants.map((uri) => ({ from: plan.masterPath, uri })),
      ...master.media.map((m) => ({ from: plan.masterPath, uri: m.uri })),
    ];

    const mediaPlaylistPaths: string[] = [];
    for (const { from, uri } of referenced) {
      const target = resolveRelative(from, uri);
      if (target === null || !planned.has(target)) {
        await fail("missing_reference", `Master playlist references a missing file: ${uri}`);
        return;
      }
      if (target.endsWith(".m3u8")) mediaPlaylistPaths.push(target);
    }

    let durationSec = 0;
    for (const playlistPath of mediaPlaylistPaths) {
      const text = playlists.get(playlistPath);
      if (text === undefined) {
        await fail("missing_reference", `Referenced playlist is missing: ${playlistPath}`);
        return;
      }
      const parsed = parseMedia(text);
      if (parsed.segments.length === 0) {
        await fail("empty_playlist", `Playlist contains no segments: ${playlistPath}`);
        return;
      }
      for (const uri of [...parsed.segments, ...parsed.initSegments]) {
        const target = resolveRelative(playlistPath, uri);
        if (target === null || !planned.has(target)) {
          await fail("missing_reference", `Playlist references a missing segment: ${uri}`);
          return;
        }
      }
      // Duration comes from the first variant; renditions of one stream all
      // describe the same wall-clock content.
      if (durationSec === 0) durationSec = parsed.durationSec;
    }

    // 5. Extract to storage. Text entries are already in memory; everything
    //    else streams straight from the archive into a multipart upload, with
    //    the per-entry and cumulative caps applied to the inflated bytes.
    const written = new Set<string>();
    for (const { entry, path } of plan.files) {
      const key = `${mediaPrefix}/${path}`;
      const contentType = contentTypeFor(path);
      const text = texts.get(path);
      if (text) {
        await storage.put(key, text, { contentType });
      } else {
        extractedBytes += await extractEntry(
          zip,
          entryFor.get(entry)!,
          budgetFor(entry, limits.maxEntryBytes),
          (body) => storage.putStream(key, body, { contentType }),
        );
      }
      written.add(path);
    }

    // 6. Publish — conditional on still owning the row, for the same reason
    //    fail() is.
    const [published] = await db
      .update(uploads)
      .set({
        status: "ready",
        playlistKey: `${mediaPrefix}/${plan.masterPath}`,
        durationSec,
        error: null,
      })
      .where(and(eq(uploads.id, uploadId), eq(uploads.status, "processing")))
      .returning({ id: uploads.id });
    if (!published) {
      log?.warn({ uploadId }, "upload no longer processing: result not published");
      return;
    }

    // The temp archive has served its purpose; failures keep theirs so an
    // operator can investigate (expired temp objects are swept by the janitor, step 8).
    try {
      await storage.delete([tempKey]);
    } catch (err) {
      log?.warn(
        { uploadId, err: err instanceof Error ? err.message : String(err) },
        "temp archive not deleted",
      );
    }
    log?.info({ uploadId, durationSec, files: written.size }, "upload ready");
  } catch (err) {
    if (err instanceof ExtractionError) {
      // A bad archive will never become good: record it and let the job
      // succeed, so BullMQ does not retry a guaranteed failure three times.
      await fail(err.code, err.message);
      return;
    }
    // Genuinely unexpected (storage, network, disk). Before the last attempt
    // the row goes back to `queued` so the retry can claim it; only the final
    // attempt records the failure. Either way the error is rethrown so the
    // queue sees the attempt fail — and a bookkeeping failure on a dead
    // connection is logged rather than allowed to mask the original error.
    const message = err instanceof Error ? err.message : "Extraction failed";
    try {
      if (attempt < maxAttempts) await release(message);
      else await fail("extraction_error", message);
    } catch (bookkeepingErr) {
      log?.warn(
        { uploadId, err: bookkeepingErr instanceof Error ? bookkeepingErr.message : String(bookkeepingErr) },
        "could not record extraction failure",
      );
    }
    throw err;
  } finally {
    zip?.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
