import type { Redis } from "ioredis";

/**
 * Token-bucket rate limiter for public reads (spec §2.4: 60 req/min per IP,
 * burstable). Each key holds `capacity` tokens, refilled at `refillPerSec`;
 * a request takes one token or is refused with the wait until the next one.
 *
 * Redis-backed and atomic (one Lua script per decision) so every API instance
 * shares one budget per client. When Redis is unconfigured or a command fails
 * the limiter degrades to an in-process bucket rather than failing requests —
 * the same posture as the login limiter: a cache outage must never turn the
 * public catalog into a wall of 500s.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Tokens left after this decision (floored). */
  remaining: number;
  /** Seconds until a token is available when refused; 0 when allowed. */
  retryAfterSec: number;
}

export interface RateLimitOptions {
  capacity?: number;
  refillPerSec?: number;
  keyPrefix?: string;
  now?: () => number;
  onDegraded?: (err: unknown) => void;
}

/**
 * KEYS[1] bucket key; ARGV: capacity, refillPerSec, nowMs, ttlSec.
 * Returns {allowed(0|1), remainingTokens, retryAfterMs}.
 */
const TAKE_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local tokens = tonumber(redis.call('HGET', KEYS[1], 't'))
local updated = tonumber(redis.call('HGET', KEYS[1], 'u'))
if tokens == nil or updated == nil then
  tokens = capacity
  updated = now
end
local elapsed = math.max(0, now - updated) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / refill * 1000)
end
redis.call('HSET', KEYS[1], 't', tokens, 'u', now)
redis.call('EXPIRE', KEYS[1], ttl)
return {allowed, math.floor(tokens), retry}
`;

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export class TokenBucketLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly keyPrefix: string;
  private readonly now: () => number;
  private readonly onDegraded: (err: unknown) => void;
  private readonly mem = new Map<string, Bucket>();

  constructor(
    private readonly redis: Redis | undefined,
    opts: RateLimitOptions = {},
  ) {
    this.capacity = opts.capacity ?? 60;
    this.refillPerSec = opts.refillPerSec ?? 1;
    this.keyPrefix = opts.keyPrefix ?? "rl:public:";
    this.now = opts.now ?? (() => Date.now());
    this.onDegraded = opts.onDegraded ?? (() => {});
  }

  /** Seconds after which an idle bucket is full again and may be forgotten. */
  private get ttlSec(): number {
    return Math.ceil(this.capacity / this.refillPerSec) + 1;
  }

  async take(id: string): Promise<RateLimitDecision> {
    const nowMs = this.now();
    if (this.redis) {
      try {
        const res = (await this.redis.eval(
          TAKE_SCRIPT,
          1,
          `${this.keyPrefix}${id}`,
          String(this.capacity),
          String(this.refillPerSec),
          String(nowMs),
          String(this.ttlSec),
        )) as [number, number, number];
        return {
          allowed: res[0] === 1,
          remaining: res[1],
          retryAfterSec: res[2] === 0 ? 0 : Math.max(1, Math.ceil(res[2] / 1000)),
        };
      } catch (err) {
        this.onDegraded(err);
      }
    }
    return this.takeInMemory(id, nowMs);
  }

  private takeInMemory(id: string, nowMs: number): RateLimitDecision {
    let bucket = this.mem.get(id);
    if (!bucket) {
      bucket = { tokens: this.capacity, updatedMs: nowMs };
      this.mem.set(id, bucket);
    }
    const elapsedSec = Math.max(0, nowMs - bucket.updatedMs) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.updatedMs = nowMs;
    // Bound the map: an unauthenticated caller controls how many ids exist.
    if (this.mem.size > 10_000) {
      for (const [k, v] of this.mem) if (v.tokens >= this.capacity && k !== id) this.mem.delete(k);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSec: 0 };
    }
    const retryMs = ((1 - bucket.tokens) / this.refillPerSec) * 1000;
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) };
  }
}
