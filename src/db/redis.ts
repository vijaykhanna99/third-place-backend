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

/** Redis connection for BullMQ Queue/Worker instances (step 6). */
export function createQueueRedis(url: string): Redis {
  return createRedis(url, { maxRetriesPerRequest: null });
}
