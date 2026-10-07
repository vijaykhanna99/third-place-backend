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
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import { mailerFromEnv, type Mailer } from "./lib/mailer.js";
import { registerCatalogRoutes } from "./modules/catalog/routes.js";
import { registerMediaRoutes } from "./modules/media/routes.js";
import { StreamUrlIssuer } from "./modules/media/stream-urls.js";
import { registerMetricsRoutes } from "./modules/metrics/routes.js";
import { registerPublicRateLimit } from "./plugins/rate-limit.js";

/**
 * Largest JSON body any endpoint accepts. The biggest legitimate payload is a
 * program with many seasons of 5,000-character descriptions, far below this;
 * routes with smaller needs (telemetry) set their own bodyLimit.
 */
export const BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Builds the Fastify application. Kept separate from the listener (index.ts)
 * so tests can exercise the full app via app.inject() without opening a port.
 *
 * DB and Redis clients are created only when their URLs are configured —
 * unit tests stay hermetic without either; /healthz reports "skipped" for
 * unconfigured components.
 */
export interface AppDependencies {
  /** Outbound account email; defaults to the transport MAIL_TRANSPORT names. */
  mailer?: Mailer;
}

export function buildApp(env: Env, deps: AppDependencies = {}): FastifyInstance {
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
    bodyLimit: BODY_LIMIT_BYTES,
    // Slow-loris protection: a request that cannot deliver its headers and
    // body in this time (a 10 MB thumbnail needs ~1.4 Mbps) is not a native
    // client on a bad link, it is a socket being held open.
    requestTimeout: 60_000,
  });

  // Security headers on every response (CSP et al. are harmless on a JSON API
  // and protect the error pages a browser might render). CORS stays closed
  // (spec §2.5): no CORS plugin is registered at all.
  void app.register(helmet, {
    global: true,
    // A JSON API embeds nothing; the strictest policy costs nothing here.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-origin" },
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
  });

  // CORS stays closed unless exact browser origins are allowlisted (spec
  // §2.5): the operator console is the only browser client. No credentials
  // mode — the console authenticates with a bearer token, never a cookie.
  if (env.corsOrigins.length > 0) {
    void app.register(cors, {
      origin: env.corsOrigins,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "X-App-Key"],
      exposedHeaders: ["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"],
      maxAge: 600,
      credentials: false,
    });
  }

  app.decorate("env", env);
  app.decorate("mailer", deps.mailer ?? mailerFromEnv(env, app.log));

  // Several POST endpoints take no body (complete, delete, revoke). Clients
  // routinely send `Content-Type: application/json` on every request, which
  // Fastify's default parser rejects when the body is empty. Treat an empty
  // body as "no body"; route schemas still 400 where a body is required.
  const parseJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (typeof body === "string" && body.trim().length === 0) {
      done(null, undefined);
      return;
    }
    void parseJson(req, body as string, done);
  });

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
    registerPublicRateLimit(app);
    registerAuthRoutes(app);

    // Stream tokens (spec §5.2). Unsigned URLs without a secret: local dev
    // against MinIO has no Worker to validate them; production requires it.
    app.decorate(
      "streamUrls",
      new StreamUrlIssuer(env.MEDIA_BASE_URL ?? "", env.STREAM_TOKEN_SECRET, env.STREAM_TOKEN_TTL_SEC),
    );
    if (!env.STREAM_TOKEN_SECRET) {
      app.log.warn("stream URLs are unsigned: STREAM_TOKEN_SECRET not configured");
    }
    registerCatalogRoutes(app);
    registerMediaRoutes(app);
    registerMetricsRoutes(app);

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
        const { queue, connection } = createExtractionQueue(env.REDIS_URL, {
          prefix: env.QUEUE_PREFIX,
        });
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

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
    mailer: Mailer;
    streamUrls: StreamUrlIssuer;
    storage?: Storage;
    uploadService?: UploadService;
    db?: Db;
    pgSql?: PgSql;
    redis?: Redis;
  }
}
