import { readdir, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Worker process lifecycle helpers: scratch-space hygiene and a bounded
 * shutdown. Kept free of BullMQ and database imports so they unit-test on a
 * temp directory and a fake worker.
 */

/** Every extraction scratch directory starts with this, so a sweep can find them. */
export const SCRATCH_PREFIX = "tplace-upload-";

export interface Log {
  info: (o: unknown, m?: string) => void;
  warn: (o: unknown, m?: string) => void;
}

export function scratchRoot(configured?: string): string {
  return configured && configured.length > 0 ? configured : tmpdir();
}

/**
 * Removes scratch directories left by a previous instance that died
 * mid-extraction (its finally block never ran). Run before taking jobs: a
 * crash-looping worker would otherwise fill the disk one archive at a time.
 * Only our own prefix is touched; anything else in the root is not ours.
 */
export async function sweepScratch(root: string, log?: Log): Promise<string[]> {
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
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch (err) {
      log?.warn({ path, err: err instanceof Error ? err.message : String(err) }, "scratch dir not removed");
    }
  }
  if (removed.length > 0) log?.info({ root, removed: removed.length }, "stale scratch directories removed");
  return removed;
}

/** Headroom kept beyond the archive itself (filesystem metadata, other tenants of the volume). */
export const SCRATCH_HEADROOM_BYTES = 64 * 1024 * 1024;

/** Bytes available to this process on the filesystem holding `root`. */
export async function freeScratchBytes(root: string): Promise<number> {
  const fs = await statfs(root);
  return Number(fs.bavail) * Number(fs.bsize);
}

/**
 * Refuses to start a download that cannot fit. ENOSPC halfway through a
 * multi-GB transfer is both wasteful and opaque; this fails up front with a
 * message that says what was needed and what was there.
 */
export async function ensureScratchSpace(root: string, neededBytes: number): Promise<void> {
  const required = neededBytes + SCRATCH_HEADROOM_BYTES;
  const free = await freeScratchBytes(root);
  if (free < required) {
    throw new Error(
      `insufficient scratch space in ${root}: need ${String(required)} bytes, ${String(free)} available`,
    );
  }
}

export interface Closable {
  /** Graceful close; `force` abandons in-flight work. */
  close(force?: boolean): Promise<void>;
}

/**
 * Builds a shutdown function that is safe to call from several signals at
 * once: the first call starts the shutdown, every later call returns the same
 * promise. A graceful close that outlives `timeoutMs` is forced — the
 * orchestrator's SIGKILL would otherwise land mid-extraction and skip every
 * cleanup path.
 */
export function createShutdown(
  worker: Closable,
  opts: { timeoutMs: number; log?: Log; after?: () => Promise<void> },
): (signal: string) => Promise<"graceful" | "forced"> {
  let inFlight: Promise<"graceful" | "forced"> | undefined;
  return (signal) => {
    if (inFlight) {
      opts.log?.info({ signal }, "shutdown already in progress");
      return inFlight;
    }
    inFlight = (async () => {
      opts.log?.info({ signal, timeoutMs: opts.timeoutMs }, "shutting down");
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"forced">((resolve) => {
        timer = setTimeout(() => resolve("forced"), opts.timeoutMs);
      });
      const graceful = worker.close().then((): "graceful" => "graceful");
      let outcome: "graceful" | "forced";
      try {
        outcome = await Promise.race([graceful, timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (outcome === "forced") {
        opts.log?.warn({ signal }, "graceful shutdown timed out: forcing close");
        // Swallow: the whole point is to get out even when close() is wedged.
        await worker.close(true).catch(() => undefined);
        // Settle the abandoned graceful promise so nothing reports it as unhandled.
        graceful.catch(() => undefined);
      }
      try {
        await opts.after?.();
      } catch (err) {
        opts.log?.warn({ err: err instanceof Error ? err.message : String(err) }, "shutdown cleanup failed");
      }
      return outcome;
    })();
    return inFlight;
  };
}
