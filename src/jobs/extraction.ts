import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import yauzl from "yauzl";
import type { Db } from "../db/client.js";
import { uploads } from "../db/schema/index.js";
import { isMasterPlaylist, parseMaster, parseMedia, resolveRelative } from "../lib/hls.js";
import type { Storage } from "../lib/storage.js";
import { ZIP_LIMITS, isRejection, planExtraction, type ZipEntryInfo } from "../lib/zip.js";

export interface ExtractionDeps {
  db: Db;
  storage: Storage;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

/** Temp key where the operator's presigned PUT lands (spec §8.1). */
export function tempKeyFor(uploadId: string): string {
  return `tmp/uploads/${uploadId}.zip`;
}

/** Published media prefix — keyed per upload (one upload = one camera angle). */
export function mediaPrefixFor(uploadId: string): string {
  return `media/uploads/${uploadId}`;
}

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
      if (err || !zip) reject(err ?? new Error("Failed to open archive"));
      else resolve(zip);
    });
  });
}

/** Reads the full central directory without extracting anything. */
function readEntries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, yauzl.Entry>();
    zip.on("entry", (entry: yauzl.Entry) => {
      out.set(entry.fileName, entry);
      zip.readEntry();
    });
    zip.on("end", () => {
      resolve(out);
    });
    zip.on("error", (err: Error) => {
      // yauzl refuses traversal entries itself — defense in depth behind our
      // own check. Translate so the operator sees the real reason.
      if (/invalid relative path|absolute path/i.test(err.message)) {
        reject(new ExtractionError("unsafe_path", `Unsafe path in archive: ${err.message}`));
        return;
      }
      reject(err);
    });
    zip.readEntry();
  });
}

function readEntryBuffer(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error("Failed to read archive entry"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (c: Buffer) => {
        size += c.length;
        // Guards against a lying central directory: stop the moment the real
        // stream exceeds what we budgeted for this entry.
        if (size > limit) {
          stream.destroy();
          reject(new ExtractionError("too_large", "Archive entry exceeds its declared size"));
          return;
        }
        chunks.push(c);
      });
      stream.on("end", () => {
        resolve(Buffer.concat(chunks));
      });
      stream.on("error", reject);
    });
  });
}

/**
 * Runs the full upload pipeline for one upload (spec §8.4):
 *   download ZIP → validate central directory → extract entry-by-entry to
 *   storage → verify playlist integrity → publish or roll back.
 *
 * Written as a plain function (not a BullMQ handler) so tests can drive it
 * directly with a real database and real storage, no queue involved.
 */
export async function processUpload(deps: ExtractionDeps, uploadId: string): Promise<void> {
  const { db, storage } = deps;

  const [upload] = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
  if (!upload) {
    // The row was deleted between enqueue and pickup. Retrying cannot help, so
    // treat it as done rather than burning the retry budget on a 404.
    deps.log?.warn({ uploadId }, "extraction skipped: upload no longer exists");
    return;
  }
  // Only queued work is processed; anything else is a duplicate delivery.
  if (upload.status !== "queued") return;

  await db.update(uploads).set({ status: "processing" }).where(eq(uploads.id, uploadId));

  const tempKey = tempKeyFor(uploadId);
  const mediaPrefix = mediaPrefixFor(uploadId);
  const scratch = await mkdtemp(join(tmpdir(), `tplace-upload-${uploadId}-`));
  const localZip = join(scratch, "upload.zip");
  let zip: yauzl.ZipFile | undefined;

  const fail = async (code: string, message: string): Promise<void> => {
    // Nothing half-published: remove anything already written.
    await storage.deletePrefix(mediaPrefix).catch(() => undefined);
    await db
      .update(uploads)
      .set({ status: "failed", error: `${code}: ${message}` })
      .where(eq(uploads.id, uploadId));
    deps.log?.warn({ uploadId, code, message }, "upload extraction failed");
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
    const entries = await readEntries(zip);
    const infos: ZipEntryInfo[] = [...entries.values()].map((e) => ({
      fileName: e.fileName,
      uncompressedSize: e.uncompressedSize,
      externalFileAttributes: e.externalFileAttributes,
    }));

    const plan = planExtraction(infos);
    if (isRejection(plan)) {
      await fail(plan.code, plan.message);
      return;
    }

    // 3. Extract to storage, enforcing the cumulative size cap against ACTUAL
    //    bytes (the ZIP-bomb guard: declared sizes are not trusted).
    let extractedBytes = 0;
    const written = new Set<string>();
    const playlists = new Map<string, string>();

    for (const { entry, path } of plan.files) {
      const original = entries.get(entry.fileName)!;
      const remaining = ZIP_LIMITS.maxTotalBytes - extractedBytes;
      const buf = await readEntryBuffer(zip, original, remaining);
      extractedBytes += buf.length;

      if (path.endsWith(".m3u8")) playlists.set(path, buf.toString("utf8"));
      await storage.put(`${mediaPrefix}/${path}`, buf, { contentType: contentTypeFor(path) });
      written.add(path);
    }

    // 4. Playlist integrity: every URI a playlist references must exist in the
    //    files we just wrote (spec §8.4).
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
      if (target === null || !written.has(target)) {
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
        if (target === null || !written.has(target)) {
          await fail("missing_reference", `Playlist references a missing segment: ${uri}`);
          return;
        }
      }
      // Duration comes from the first variant; renditions of one stream all
      // describe the same wall-clock content.
      if (durationSec === 0) durationSec = parsed.durationSec;
    }

    // 5. Publish.
    await db
      .update(uploads)
      .set({
        status: "ready",
        playlistKey: `${mediaPrefix}/${plan.masterPath}`,
        durationSec,
        error: null,
      })
      .where(eq(uploads.id, uploadId));

    // The temp archive has served its purpose; failures keep theirs so an
    // operator can investigate (the janitor sweeps them after 7 days).
    await storage.delete([tempKey]).catch(() => undefined);
    deps.log?.info({ uploadId, durationSec, files: written.size }, "upload ready");
  } catch (err) {
    if (err instanceof ExtractionError) {
      // A bad archive will never become good: record it and let the job
      // succeed, so BullMQ does not retry a guaranteed failure three times.
      await fail(err.code, err.message);
      return;
    }
    // Genuinely unexpected (storage, network, disk): fail the upload but
    // rethrow so the queue retries.
    await fail("extraction_error", err instanceof Error ? err.message : "Extraction failed");
    throw err;
  } finally {
    zip?.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
