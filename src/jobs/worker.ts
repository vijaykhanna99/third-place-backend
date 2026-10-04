import { loadEnv } from "../config/env.js";
import { createDb } from "../db/client.js";
import { Storage, storageConfigFromEnv } from "../lib/storage.js";
import { createExtractionWorker } from "./queue.js";

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

const { sql, db } = createDb(env.DATABASE_URL);
const storage = new Storage(storageConfig);

const worker = createExtractionWorker(env.REDIS_URL, {
  db,
  storage,
  log: {
    info: (o, m) => {
      console.log(JSON.stringify({ level: "info", msg: m, ...(o as object) }));
    },
    warn: (o, m) => {
      console.warn(JSON.stringify({ level: "warn", msg: m, ...(o as object) }));
    },
  },
});

worker.on("failed", (job, err) => {
  console.error(
    JSON.stringify({ level: "error", msg: "job failed", jobId: job?.id, err: err.message }),
  );
});

console.log(JSON.stringify({ level: "info", msg: "extraction worker started" }));

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
  await worker.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
