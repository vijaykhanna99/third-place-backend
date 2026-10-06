import { Redis, type RedisOptions } from "ioredis";

/**
 * Shared Redis factory for API-path usage (health probes, caching).
 * lazyConnect so app boot doesn't block on Redis being up. Callers must
 * attach an "error" listener (ioredis crashes the process on unhandled error
 * events) — app.ts does this.
 *
 * BullMQ callers MUST NOT use these defaults: BullMQ workers require
 * `maxRetriesPerRequest: null` and throw at construction otherwise. Use
 * createQueueRedis() for anything passed to Queue/Worker (step 6).
 */
export function createRedis(url: string, overrides: RedisOptions = {}): Redis {
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 500, 5000),
    ...overrides,
  });
}

export interface RedisLog {
  warn: (o: unknown, m?: string) => void;
  info: (o: unknown, m?: string) => void;
  debug: (o: unknown, m?: string) => void;
}

/**
 * Attaches the error listener every ioredis client needs (an unhandled "error"
 * event crashes the process) with outage-aware logging: the DOWN transition
 * is logged once at warn, repeats at debug — so an outage is visible at the
 * production log level without flooding it — and recovery at info.
 */
export function attachRedisLogging(redis: Redis, log: RedisLog, name: string): void {
  let down = false;
  redis.on("error", (err: Error) => {
    if (!down) {
      down = true;
      log.warn({ err: { message: err.message }, client: name }, `${name} redis connection down`);
    } else {
      log.debug({ err: { message: err.message }, client: name }, `${name} redis still down`);
    }
  });
  redis.on("ready", () => {
    if (down) {
      down = false;
      log.info({ client: name }, `${name} redis connection recovered`);
    }
  });
}

/** Redis connection for BullMQ Queue/Worker instances (step 6). */
export function createQueueRedis(url: string): Redis {
  return createRedis(url, { maxRetriesPerRequest: null });
}
