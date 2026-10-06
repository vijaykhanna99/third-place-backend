import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Env } from "./config/env.js";
import { createDb, type Db, type PgSql } from "./db/client.js";
import { attachRedisLogging, createRedis } from "./db/redis.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerAuthGuard } from "./plugins/auth.js";
import { registerAppKeyGuard } from "./plugins/app-key.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerUploadRoutes } from "./modules/uploads/routes.js";
import { UploadService } from "./modules/uploads/service.js";
import { Storage, storageConfigFromEnv } from "./lib/storage.js";
import { createExtractionQueue } from "./jobs/queue.js";
import multipart from "@fastify/multipart";
import { registerCatalogRoutes } from "./modules/catalog/routes.js";

/**
 * Builds the Fastify application. Kept separate from the listener (index.ts)
 * so tests can exercise the full app via app.inject() without opening a port.
 *
 * DB and Redis clients are created only when their URLs are configured —
 * unit tests stay hermetic without either; /healthz reports "skipped" for
 * unconfigured components.
 */
export function buildApp(env: Env): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === "development"
        ? { transport: { target: "pino/file", options: { destination: 1 } } }
        : {}),
    },
    // Request IDs on every log line; header override for tracing across services.
    requestIdHeader: "x-request-id",
    // Only honour X-Forwarded-For from explicitly trusted hops (see env.ts).
    // Defaults to false so a directly-exposed listener can't be spoofed.
    trustProxy: env.trustProxy,
  });

  app.decorate("env", env);

  if (env.DATABASE_URL) {
    const { sql, db } = createDb(env.DATABASE_URL);
    app.decorate("db", db);
    app.decorate("pgSql", sql);
    app.addHook("onClose", async () => {
      await sql.end({ timeout: 5 });
    });
  }

  if (env.REDIS_URL) {
    const redis = createRedis(env.REDIS_URL);
    // A Redis outage must appear in logs without depending on healthz scraping.
    attachRedisLogging(redis, app.log, "api");
    app.decorate("redis", redis);
    app.addHook("onClose", async () => {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    });
  }

  registerErrorHandler(app);
  registerHealthRoutes(app);

  // Auth needs both a database and a signing key. Absent either (hermetic unit
  // tests, bare dev boot), the routes simply don't exist — /healthz still works.
  if (app.db && env.JWT_SIGNING_KEY) {
    if (!env.REDIS_URL) {
      app.log.warn(
        "login rate limiting is in-process only (REDIS_URL unset) — budgets are per-instance",
      );
    }
    registerAuthGuard(app);
    registerAppKeyGuard(app);
    registerAuthRoutes(app);
    registerCatalogRoutes(app);

    // Uploads need object storage; without it the endpoints simply don't exist
    // rather than failing at request time.
    const storageConfig = storageConfigFromEnv(env);
    if (storageConfig) {
      // Thumbnails are the only multipart route; the cap is enforced here as
      // well as in the handler so oversized bodies are cut off at the socket.
      void app.register(multipart, {
        limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4 },
      });
      const storage = new Storage(storageConfig);
      let enqueue: ((uploadId: string) => Promise<void>) | null = null;
      if (env.REDIS_URL) {
        const { queue, connection } = createExtractionQueue(env.REDIS_URL);
        attachRedisLogging(connection, app.log, "extraction-queue");
        enqueue = async (uploadId) => {
          await queue.add("extract", { uploadId }, { jobId: uploadId });
        };
        app.addHook("onClose", async () => {
          await queue.close();
          try {
            await connection.quit();
          } catch {
            connection.disconnect();
          }
        });
      }
      app.decorate("storage", storage);
      const uploadService = new UploadService(
        app.db,
        storage,
        enqueue,
        env.MEDIA_BASE_URL ?? "",
        app.log,
      );
      app.decorate("uploadService", uploadService);
      registerUploadRoutes(app, uploadService);
    } else {
      app.log.warn("upload routes disabled: object storage (R2_*) not configured");
    }
    if (env.appKeys.length === 0) {
      app.log.warn("X-App-Key gate disabled: APP_KEYS not configured — public reads are open");
    }
  } else {
    app.log.warn("auth routes disabled: DATABASE_URL and/or JWT_SIGNING_KEY not configured");
  }

  // step 7: media module routes (/api/v1/episodes/{id}/stream)
  // step 8: metrics module routes (/api/v1/metrics/playback)

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
    storage?: Storage;
    uploadService?: UploadService;
    db?: Db;
    pgSql?: PgSql;
    redis?: Redis;
  }
}
