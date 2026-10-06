import { afterAll, describe, expect, it } from "vitest";
import { Queue, type Worker } from "bullmq";
import { createDb, type DbBundle } from "../src/db/client.js";
import { createQueueRedis } from "../src/db/redis.js";
import type { JanitorReport } from "../src/jobs/janitor.js";
import { JANITOR_QUEUE, JANITOR_SCHEDULER_ID, createJanitorWorker, scheduleJanitor } from "../src/jobs/queue.js";
import { Storage } from "../src/lib/storage.js";

/**
 * Janitor scheduling through BullMQ — requires Postgres, Redis and object storage
 * (the sweep itself runs against them). Namespaced under its own key prefix.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL;
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;
const PREFIX = `itest-jq-${String(Date.now())}`;

describe.runIf(Boolean(DB_URL && REDIS_URL && S3_ENDPOINT))("janitor queue", () => {
  let bundle: DbBundle | undefined;
  let worker: Worker | undefined;
  const closers: (() => Promise<unknown>)[] = [];

  afterAll(async () => {
    await worker?.close();
    for (const close of closers) await close();
    const connection = createQueueRedis(REDIS_URL!);
    const queue = new Queue(JANITOR_QUEUE, { connection, prefix: PREFIX });
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
    await bundle?.sql.end({ timeout: 5 });
  });

  it("upserts a single repeatable schedule and removes it when disabled", async () => {
    const first = await scheduleJanitor(REDIS_URL!, 60_000, { prefix: PREFIX });
    closers.push(() => first.queue.close(), () => first.connection.quit());
    let schedulers = await first.queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ key: JANITOR_SCHEDULER_ID, every: 60000 });

    // A changed interval replaces the schedule instead of adding a second one.
    const second = await scheduleJanitor(REDIS_URL!, 120_000, { prefix: PREFIX });
    closers.push(() => second.queue.close(), () => second.connection.quit());
    schedulers = await second.queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]!.every).toBe(120000);

    const off = await scheduleJanitor(REDIS_URL!, 0, { prefix: PREFIX });
    closers.push(() => off.queue.close(), () => off.connection.quit());
    expect(await off.queue.getJobSchedulers()).toHaveLength(0);
  });

  it("runs a sweep when a job is delivered and reports its result", async () => {
    bundle = createDb(DB_URL!);
    const storage = new Storage({
      endpoint: S3_ENDPOINT!,
      region: "auto",
      accessKeyId: "tplace",
      secretAccessKey: "tplace-secret",
      bucket: "tplace-media-dev",
    });
    worker = createJanitorWorker(REDIS_URL!, { db: bundle.db, storage }, { prefix: PREFIX });
    const done = new Promise<JanitorReport>((resolve, reject) => {
      worker!.on("completed", (_job, result) => resolve(result as JanitorReport));
      worker!.on("failed", (_job, err) => reject(err));
    });
    const connection = createQueueRedis(REDIS_URL!);
    const queue = new Queue(JANITOR_QUEUE, { connection, prefix: PREFIX });
    closers.push(() => queue.close(), () => connection.quit());
    await queue.add("sweep", {});

    const report = await done;
    expect(report.errors).toEqual([]);
    expect(Array.isArray(report.reclaimedUploads)).toBe(true);
    expect(typeof report.defaultPartitionRows).toBe("number");
  }, 30_000);
});
