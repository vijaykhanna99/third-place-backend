import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { createQueueRedis } from "../db/redis.js";
import { processUpload, type ExtractionDeps } from "./extraction.js";

export const EXTRACTION_QUEUE = "upload-extraction";

export interface ExtractionJobData {
  uploadId: string;
}

/**
 * Producer side. Uses a dedicated connection because BullMQ requires
 * `maxRetriesPerRequest: null`, which the API-path Redis client does not use.
 */
export function createExtractionQueue(redisUrl: string): { queue: Queue; connection: Redis } {
  const connection = createQueueRedis(redisUrl);
  const queue = new Queue(EXTRACTION_QUEUE, {
    connection,
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
export function createExtractionWorker(redisUrl: string, deps: ExtractionDeps): Worker {
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
      // Extraction is IO- and memory-heavy; a small concurrency keeps one
      // worker from thrashing on several multi-GB archives at once.
      concurrency: 2,
      lockDuration: 10 * 60 * 1000,
    },
  );
}
