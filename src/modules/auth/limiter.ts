import type { Redis } from "ioredis";

/**
 * Login failure limiter (spec §2.4): 5 failures per account per 15 min,
 * 20 per IP per 15 min.
 *
 * Counting keys, and why there are three:
 *  - account id — the authoritative per-account budget. Login accepts handle
 *    OR email, so keying only on the submitted string would hand one account
 *    two independent budgets.
 *  - identifier  — pre-resolution bucket, and the only bucket available for
 *    identifiers that match no account (so probing is still throttled without
 *    creating an existence oracle).
 *  - ip          — coarse per-source budget.
 *
 * Backed by Redis when available, with an in-process Map fallback used both
 * when Redis is unconfigured and when a Redis command fails: a cache outage
 * must degrade the limiter, never turn every login into a 500.
 */
export class LoginLimiter {
  private readonly mem = new Map<string, { count: number; resetAt: number }>();
  private readonly evalSha: { incr?: string } = {};

  constructor(
    private readonly redis: Redis | undefined,
    private readonly windowSec = 900,
    private readonly accountMax = 5,
    private readonly ipMax = 20,
    private readonly onDegraded: (err: unknown) => void = () => {},
  ) {}

  private memCount(key: string): number {
    const entry = this.mem.get(key);
    if (!entry || entry.resetAt < Date.now()) return 0;
    return entry.count;
  }

  private memIncrement(key: string): void {
    const now = Date.now();
    const entry = this.mem.get(key);
    if (!entry || entry.resetAt < now) {
      this.mem.set(key, { count: 1, resetAt: now + this.windowSec * 1000 });
    } else {
      entry.count += 1;
    }
    // Bound the map: expired entries are dead weight and an unauthenticated
    // caller controls how many keys exist.
    if (this.mem.size > 10_000) {
      for (const [k, v] of this.mem) if (v.resetAt < now) this.mem.delete(k);
    }
  }

  private async count(key: string): Promise<number> {
    if (this.redis) {
      try {
        const v = await this.redis.get(key);
        return v ? Number(v) : 0;
      } catch (err) {
        this.onDegraded(err);
      }
    }
    return this.memCount(key);
  }

  private async increment(key: string): Promise<void> {
    if (this.redis) {
      try {
        // Atomic: a crash between INCR and EXPIRE would otherwise leave a
        // TTL-less counter, locking that key out permanently.
        await this.redis.eval(
          "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n",
          1,
          key,
          String(this.windowSec),
        );
        return;
      } catch (err) {
        this.onDegraded(err);
      }
    }
    this.memIncrement(key);
  }

  private async del(key: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(key);
        return;
      } catch (err) {
        this.onDegraded(err);
      }
    }
    this.mem.delete(key);
  }

  private accountKey(accountId: string): string {
    return `login:fail:acct:${accountId}`;
  }

  private identifierKey(identifier: string): string {
    return `login:fail:ident:${identifier.toLowerCase()}`;
  }

  private ipKey(ip: string): string {
    return `login:fail:ip:${ip}`;
  }

  /** Pre-resolution check: identifier and IP budgets. */
  async isBlocked(identifier: string, ip: string): Promise<boolean> {
    const [byIdentifier, byIp] = await Promise.all([
      this.count(this.identifierKey(identifier)),
      this.count(this.ipKey(ip)),
    ]);
    return byIdentifier >= this.accountMax || byIp >= this.ipMax;
  }

  /** Authoritative per-account check, once login has resolved the account. */
  async isAccountBlocked(accountId: string): Promise<boolean> {
    return (await this.count(this.accountKey(accountId))) >= this.accountMax;
  }

  async recordFailure(identifier: string, ip: string, accountId?: string | null): Promise<void> {
    await Promise.all([
      this.increment(this.identifierKey(identifier)),
      this.increment(this.ipKey(ip)),
      accountId ? this.increment(this.accountKey(accountId)) : Promise.resolve(),
    ]);
  }

  /** Successful login clears the account/identifier counters (never the IP one). */
  async clear(identifier: string, accountId?: string | null): Promise<void> {
    await Promise.all([
      this.del(this.identifierKey(identifier)),
      accountId ? this.del(this.accountKey(accountId)) : Promise.resolve(),
    ]);
  }
}
