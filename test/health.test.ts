import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";

// Hermetic: tests never read process.env or the developer's .env.
const testEnv = () => loadEnvFrom({ NODE_ENV: "test", LOG_LEVEL: "error" });

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("healthz", () => {
  it("returns ok without auth or app key", async () => {
    app = buildApp(testEnv());
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      checks: { db: "skipped", redis: "skipped" },
    });
  });

  it("unknown routes return the spec error shape", async () => {
    app = buildApp(testEnv());
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
  });
});

describe("readyz", () => {
  it("is ready when no dependency is configured (nothing can be down)", async () => {
    app = buildApp(testEnv());
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: { db: "skipped", redis: "skipped" } });
  });

  it("answers 503 while a configured dependency is unreachable, but healthz stays 200", async () => {
    // Nothing listens on port 9: connections are refused immediately.
    app = buildApp(
      loadEnvFrom({
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        DATABASE_URL: "postgres://u:p@127.0.0.1:9/nope",
        REDIS_URL: "redis://127.0.0.1:9",
      }),
    );
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "not_ready", checks: { db: "down", redis: "down" } });
    const live = await app.inject({ method: "GET", url: "/healthz" });
    expect(live.statusCode).toBe(200);
    expect(live.json<{ status: string }>().status).toBe("degraded");
  }, 15_000);
});

describe("hardening headers", () => {
  it("sets security headers on every response, including errors", async () => {
    app = buildApp(testEnv());
    for (const url of ["/healthz", "/nope"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["x-content-type-options"], url).toBe("nosniff");
      expect(res.headers["strict-transport-security"], url).toContain("max-age=63072000");
      expect(res.headers["content-security-policy"], url).toContain("default-src 'none'");
      expect(res.headers["x-frame-options"], url).toBeDefined();
      // CORS is closed: no allow-origin header is ever emitted.
      expect(res.headers["access-control-allow-origin"], url).toBeUndefined();
    }
  });

  it("refuses JSON bodies above the global limit with the error shape", async () => {
    app = buildApp(testEnv());
    app.post("/echo", () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ pad: "x".repeat(1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("validation_failed");
  });
});
