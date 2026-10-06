import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "../src/lib/rate-limit.js";

/** In-process bucket with a controllable clock (the Redis path is covered by the integration suite). */
function limiter(capacity = 60, refillPerSec = 1) {
  let nowMs = 1_000_000;
  const l = new TokenBucketLimiter(undefined, { capacity, refillPerSec, now: () => nowMs });
  return { l, tick: (ms: number) => void (nowMs += ms) };
}

describe("TokenBucketLimiter (in-process)", () => {
  it("allows a full burst, then refuses with a Retry-After", async () => {
    const { l } = limiter(60, 1);
    for (let i = 0; i < 60; i++) {
      const d = await l.take("ip");
      expect(d.allowed, `request ${String(i + 1)}`).toBe(true);
      expect(d.remaining).toBe(59 - i);
    }
    const refused = await l.take("ip");
    expect(refused).toEqual({ allowed: false, remaining: 0, retryAfterSec: 1 });
  });

  it("refills one token per second and never beyond capacity", async () => {
    const { l, tick } = limiter(60, 1);
    for (let i = 0; i < 60; i++) await l.take("ip");
    expect((await l.take("ip")).allowed).toBe(false);
    tick(1000);
    expect((await l.take("ip")).allowed).toBe(true);
    expect((await l.take("ip")).allowed).toBe(false);
    // A long idle period refills to capacity, not past it.
    tick(10 * 60 * 1000);
    for (let i = 0; i < 60; i++) expect((await l.take("ip")).allowed).toBe(true);
    expect((await l.take("ip")).allowed).toBe(false);
  });

  it("rounds the wait up to whole seconds", async () => {
    const { l, tick } = limiter(2, 1);
    await l.take("ip");
    await l.take("ip");
    tick(400);
    const d = await l.take("ip");
    expect(d.allowed).toBe(false);
    // 0.4 tokens refilled; 0.6 s to the next one → advertised as 1 s.
    expect(d.retryAfterSec).toBe(1);
  });

  it("keeps separate buckets per client", async () => {
    const { l } = limiter(1, 1);
    expect((await l.take("a")).allowed).toBe(true);
    expect((await l.take("a")).allowed).toBe(false);
    expect((await l.take("b")).allowed).toBe(true);
  });

  it("falls back to memory when a Redis command fails, and reports it once per call", async () => {
    const degraded: unknown[] = [];
    const broken = { eval: () => Promise.reject(new Error("ECONNREFUSED")) };
    const l = new TokenBucketLimiter(broken as never, {
      capacity: 1,
      refillPerSec: 1,
      onDegraded: (e) => void degraded.push(e),
    });
    expect((await l.take("ip")).allowed).toBe(true);
    expect((await l.take("ip")).allowed).toBe(false);
    expect(degraded).toHaveLength(2);
  });
});
