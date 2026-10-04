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
