import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { PUBLIC_RATE_LIMIT } from "../src/plugins/rate-limit.js";
import { expectContract } from "./helpers/contract.js";

/**
 * Public-read rate limiting through the real app (spec §2.4) — requires
 * Postgres (the public routes need a database); uses Redis when
 * TEST_REDIS_URL is set, the in-process fallback otherwise.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL;
const APP_KEY = "ratelimit-test-app-key";
/** Unique client addresses per run so parallel/previous runs never share a bucket. */
const OCTET = Number(String(Date.now()).slice(-3)) % 200 + 10;
const ip = (n: number) => `10.77.${String(OCTET)}.${String(n)}`;

describe.runIf(Boolean(DB_URL))("public rate limiting", () => {
  const apps: FastifyInstance[] = [];
  const build = (trustedProxies?: string) => {
    const app = buildApp(
      loadEnvFrom({
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        DATABASE_URL: DB_URL!,
        ...(REDIS_URL ? { REDIS_URL } : {}),
        JWT_SIGNING_KEY: "8".repeat(64),
        APP_KEYS: APP_KEY,
        ...(trustedProxies ? { TRUSTED_PROXIES: trustedProxies } : {}),
      }),
    );
    apps.push(app);
    return app;
  };

  afterAll(async () => {
    for (const app of apps) {
      if (app.redis) {
        const keys = await app.redis.keys(`rl:public:10.77.${String(OCTET)}.*`);
        if (keys.length > 0) await app.redis.del(...keys);
      }
      await app.close();
    }
  });

  const read = (app: FastifyInstance, remoteAddress: string, extra: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: "/api/v1/genres", headers: { "x-app-key": APP_KEY, ...extra }, remoteAddress });

  it("allows a 60-request burst per IP, then answers 429 with Retry-After", async () => {
    const app = build();
    for (let i = 0; i < PUBLIC_RATE_LIMIT.capacity; i++) {
      const res = await read(app, ip(1));
      expect(res.statusCode, `request ${String(i + 1)}`).toBe(200);
      expect(res.headers["ratelimit-limit"]).toBe("60");
      expect(Number(res.headers["ratelimit-remaining"])).toBeLessThanOrEqual(59 - i);
    }
    const refused = await read(app, ip(1));
    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("rate_limited");
    expectContract("GET", "/api/v1/genres", 429, refused.json());
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(refused.headers["ratelimit-remaining"]).toBe("0");

    // Another client is unaffected.
    expect((await read(app, ip(2))).statusCode).toBe(200);
  });

  it("limits before the app-key check, so key guessing is throttled too", async () => {
    const app = build();
    for (let i = 0; i < PUBLIC_RATE_LIMIT.capacity; i++) {
      await app.inject({ method: "GET", url: "/api/v1/genres", headers: { "x-app-key": "wrong" }, remoteAddress: ip(3) });
    }
    const res = await app.inject({ method: "GET", url: "/api/v1/genres", headers: { "x-app-key": "wrong" }, remoteAddress: ip(3) });
    expect(res.statusCode).toBe(429);
  });

  it("covers every public read and the metrics sink with one shared budget per IP", async () => {
    const app = build();
    for (let i = 0; i < PUBLIC_RATE_LIMIT.capacity; i++) await read(app, ip(4));
    for (const [method, url] of [
      ["GET", "/api/v1/search?query=abc"],
      ["GET", "/api/v1/programs/01890a5d-ac96-774b-b111-000000000101"],
      ["GET", "/api/v1/episodes/01890a5d-ac96-774b-b111-000000000301/stream"],
      ["POST", "/api/v1/metrics/playback"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { "x-app-key": APP_KEY },
        remoteAddress: ip(4),
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect(res.statusCode, url).toBe(429);
    }
    // Operator endpoints and health are not public reads: untouched.
    expect((await app.inject({ method: "GET", url: "/healthz", remoteAddress: ip(4) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/programs", remoteAddress: ip(4), payload: {} })).statusCode).toBe(401);
  });

  it("honours X-Forwarded-For only from trusted proxies", async () => {
    // Not behind a proxy: the header is ignored, every forwarded client shares the peer's bucket.
    const direct = build();
    for (let i = 0; i < PUBLIC_RATE_LIMIT.capacity; i++) {
      await read(direct, ip(5), { "x-forwarded-for": `198.51.100.${String(i)}` });
    }
    expect((await read(direct, ip(5), { "x-forwarded-for": "198.51.100.250" })).statusCode).toBe(429);

    // Behind a trusted proxy: each forwarded client gets its own bucket...
    const proxied = build(ip(6));
    for (let i = 0; i < PUBLIC_RATE_LIMIT.capacity; i++) {
      await read(proxied, ip(6), { "x-forwarded-for": `10.77.${String(OCTET)}.100` });
    }
    expect((await read(proxied, ip(6), { "x-forwarded-for": `10.77.${String(OCTET)}.100` })).statusCode).toBe(429);
    expect((await read(proxied, ip(6), { "x-forwarded-for": `10.77.${String(OCTET)}.101` })).statusCode).toBe(200);
    // ...and a client the proxy does not vouch for cannot pick its own bucket.
    const untrusted = build(ip(6));
    for (let i = 0; i < PUBLIC_RATE_LIMIT.capacity; i++) {
      await read(untrusted, ip(7), { "x-forwarded-for": `10.77.${String(OCTET)}.${String(120 + (i % 50))}` });
    }
    expect((await read(untrusted, ip(7), { "x-forwarded-for": `10.77.${String(OCTET)}.200` })).statusCode).toBe(429);
  });
});
