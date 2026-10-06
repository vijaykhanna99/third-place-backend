import { loadEnv } from "../config/env.js";
import { createDb } from "../db/client.js";
import { attachRedisLogging } from "../db/redis.js";
import { Storage, storageConfigFromEnv } from "../lib/storage.js";
import { createShutdown, scratchRoot, sweepScratch } from "./lifecycle.js";
import { createExtractionQueue, createExtractionWorker } from "./queue.js";
import { recoverStuckUploads } from "./recovery.js";

/**
 * Extraction worker entrypoint (`pnpm worker`). Separate process from the API:
 * a multi-GB extraction must never compete with request handling.
 */
const env = loadEnv();
if (!env.DATABASE_URL || !env.REDIS_URL) {
  console.error("worker requires DATABASE_URL and REDIS_URL");
  process.exit(1);
}
const storageConfig = storageConfigFromEnv(env);
if (!storageConfig) {
  console.error("worker requires R2_* storage configuration");
  process.exit(1);
}

const log = {
  info: (o: unknown, m?: string) => {
    console.log(JSON.stringify({ level: "info", msg: m, ...(o as object) }));
  },
  warn: (o: unknown, m?: string) => {
    console.warn(JSON.stringify({ level: "warn", msg: m, ...(o as object) }));
  },
  debug: (o: unknown, m?: string) => {
    if (env.LOG_LEVEL === "debug" || env.LOG_LEVEL === "trace") {
      console.log(JSON.stringify({ level: "debug", msg: m, ...(o as object) }));
    }
  },
};

const { sql, db } = createDb(env.DATABASE_URL);
const storage = new Storage(storageConfig);
const scratchDir = scratchRoot(env.SCRATCH_DIR);
const deps = {
  db,
  storage,
  log,
  stuckAfterMs: env.UPLOAD_STUCK_AFTER_MS,
  limits: { maxEntryBytes: env.UPLOAD_MAX_ENTRY_BYTES },
  scratchDir,
};

// A previous instance that died mid-job left its archive on disk; clear it
// before taking work so a crash loop cannot fill the volume.
await sweepScratch(scratchDir, log);

// Producer handle for re-enqueueing recovered uploads. A recovered upload gets
// a fresh job id: the original id may still sit in the completed/failed sets,
// where BullMQ would silently drop a duplicate.
const queueOptions = { prefix: env.QUEUE_PREFIX };
const { queue, connection: queueConnection } = createExtractionQueue(env.REDIS_URL, queueOptions);
attachRedisLogging(queueConnection, log, "extraction-queue");
const requeue = async (uploadId: string) => {
  await queue.add("extract", { uploadId }, { jobId: `${uploadId}:recovery:${String(Date.now())}` });
};

const worker = createExtractionWorker(env.REDIS_URL, deps, queueOptions);

worker.on("failed", (job, err) => {
  console.error(
    JSON.stringify({ level: "error", msg: "job failed", jobId: job?.id, err: err.message }),
  );
});

/**
 * Stuck-row sweep: at startup (a previous instance may have died mid-job) and
 * periodically, so a row abandoned by another instance is not left waiting for
 * the next restart.
 */
const sweep = async () => {
  try {
    const { requeued, failed } = await recoverStuckUploads(deps, {
      stuckAfterMs: env.UPLOAD_STUCK_AFTER_MS,
      enqueue: requeue,
    });
    if (requeued.length > 0 || failed.length > 0) {
      log.info({ requeued, failed }, "stuck upload sweep");
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "stuck upload sweep failed");
  }
};
await sweep();
const sweepTimer = setInterval(() => void sweep(), Math.min(env.UPLOAD_STUCK_AFTER_MS, 5 * 60 * 1000));

log.info(
  {
    scratchDir,
    queuePrefix: env.QUEUE_PREFIX ?? "bull",
    stuckAfterMs: env.UPLOAD_STUCK_AFTER_MS,
    maxEntryBytes: env.UPLOAD_MAX_ENTRY_BYTES,
    shutdownTimeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
  },
  "extraction worker started",
);

// In-flight jobs get WORKER_SHUTDOWN_TIMEOUT_MS to finish; after that the
// close is forced (BullMQ's stalled-job detection hands the job to another
// instance, and processUpload's finally still removes the scratch dir).
const shutdown = createShutdown(worker, {
  timeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
  log,
  after: async () => {
    clearInterval(sweepTimer);
    await queue.close();
    await sql.end({ timeout: 5 });
  },
});
const onSignal = (signal: string) => {
  void shutdown(signal).then((outcome) => process.exit(outcome === "graceful" ? 0 : 1));
};
process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));
