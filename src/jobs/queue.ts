import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { createQueueRedis } from "../db/redis.js";
import { processUpload, type ExtractionDeps } from "./extraction.js";
import { runJanitor, type JanitorDeps, type JanitorReport } from "./janitor.js";

export const EXTRACTION_QUEUE = "upload-extraction";
export const JANITOR_QUEUE = "janitor";
export const JANITOR_SCHEDULER_ID = "janitor-sweep";

export interface ExtractionJobData {
  uploadId: string;
}

export interface QueueOptions {
  /** Redis key namespace (env QUEUE_PREFIX); BullMQ's default "bull" when unset. */
  prefix?: string | undefined;
}

/** Only the defined options are passed on: BullMQ treats `prefix: undefined` as a prefix. */
function prefixOption(opts: QueueOptions): { prefix?: string } {
  return opts.prefix === undefined ? {} : { prefix: opts.prefix };
}

/**
 * Producer side. Uses a dedicated connection because BullMQ requires
 * `maxRetriesPerRequest: null`, which the API-path Redis client does not use.
 */
export function createExtractionQueue(
  redisUrl: string,
  opts: QueueOptions = {},
): { queue: Queue; connection: Redis } {
  const connection = createQueueRedis(redisUrl);
  const queue = new Queue(EXTRACTION_QUEUE, {
    connection,
    ...prefixOption(opts),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });
  return { queue, connection };
}

/** Consumer side — run in its own process (`pnpm worker`). */
export function createExtractionWorker(
  redisUrl: string,
  deps: ExtractionDeps,
  opts: QueueOptions = {},
): Worker<ExtractionJobData> {
  const connection = createQueueRedis(redisUrl);
  return new Worker<ExtractionJobData>(
    EXTRACTION_QUEUE,
    async (job: Job<ExtractionJobData>) => {
      // attemptsMade counts prior failures, so this delivery is attempt N+1.
      await processUpload(deps, job.data.uploadId, {
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts ?? 1,
      });
    },
    {
      connection,
      ...prefixOption(opts),
      // Extraction is IO- and memory-heavy; a small concurrency keeps one
      // worker from thrashing on several multi-GB archives at once.
      concurrency: 2,
      lockDuration: 10 * 60 * 1000,
    },
  );
}

/**
 * Janitor schedule (step 8): one repeatable job every `everyMs`, upserted so a
 * restart or a changed interval replaces the schedule instead of adding one.
 * `everyMs` 0 removes any existing schedule.
 */
export async function scheduleJanitor(
  redisUrl: string,
  everyMs: number,
  opts: QueueOptions = {},
): Promise<{ queue: Queue; connection: Redis }> {
  const connection = createQueueRedis(redisUrl);
  const queue = new Queue(JANITOR_QUEUE, {
    connection,
    ...prefixOption(opts),
    defaultJobOptions: { removeOnComplete: { count: 48 }, removeOnFail: { count: 48 } },
  });
  if (everyMs > 0) {
    await queue.upsertJobScheduler(JANITOR_SCHEDULER_ID, { every: everyMs }, { name: "sweep" });
  } else {
    await queue.removeJobScheduler(JANITOR_SCHEDULER_ID);
  }
  return { queue, connection };
}

/** Janitor consumer: one sweep at a time, in the worker process. */
export function createJanitorWorker(
  redisUrl: string,
  deps: JanitorDeps,
  opts: QueueOptions = {},
): Worker<Record<string, never>, JanitorReport> {
  const connection = createQueueRedis(redisUrl);
  return new Worker<Record<string, never>, JanitorReport>(JANITOR_QUEUE, () => runJanitor(deps), {
    connection,
    ...prefixOption(opts),
    concurrency: 1,
    lockDuration: 10 * 60 * 1000,
  });
}
