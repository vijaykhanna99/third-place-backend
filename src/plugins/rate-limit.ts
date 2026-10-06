import type { FastifyInstance, preValidationAsyncHookHandler } from "fastify";
import { errors } from "../lib/errors.js";
import { TokenBucketLimiter } from "../lib/rate-limit.js";

/** Spec §2.4: 60 requests per minute per IP, burstable. */
export const PUBLIC_RATE_LIMIT = { capacity: 60, refillPerSec: 1 } as const;

/**
 * Per-IP limiter for public reads (catalog, search, stream, metrics).
 *
 * The client identity is `req.ip`, which Fastify derives from X-Forwarded-For
 * only for hops listed in TRUSTED_PROXIES (env.ts) — so behind the CDN every
 * end user gets their own bucket, while a directly exposed listener can never
 * be talked into rate-limiting someone else's address.
 *
 * Refusals answer 429 `rate_limited` with `Retry-After`; every answer carries
 * `RateLimit-Limit` / `RateLimit-Remaining` so clients can pace themselves.
 */
export function registerPublicRateLimit(app: FastifyInstance): void {
  let degradedLogged = false;
  const limiter = new TokenBucketLimiter(app.redis, {
    ...PUBLIC_RATE_LIMIT,
    onDegraded: (err) => {
      if (degradedLogged) return;
      degradedLogged = true;
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "public rate limiter degraded to in-process buckets (redis unavailable)",
      );
    },
  });

  app.decorate("publicRateLimit", (): preValidationAsyncHookHandler => {
    return async (req, reply) => {
      const decision = await limiter.take(req.ip);
      void reply.header("ratelimit-limit", String(PUBLIC_RATE_LIMIT.capacity));
      void reply.header("ratelimit-remaining", String(decision.remaining));
      if (!decision.allowed) {
        void reply.header("retry-after", String(decision.retryAfterSec));
        throw errors.rateLimited();
      }
    };
  });
}

declare module "fastify" {
  interface FastifyInstance {
    publicRateLimit: () => preValidationAsyncHookHandler;
  }
}
