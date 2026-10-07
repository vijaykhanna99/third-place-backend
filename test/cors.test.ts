import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";

/** CORS allowlist for the operator console (spec §2.5) — hermetic, no database. */
describe("CORS allowlist", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("stays closed when CORS_ORIGINS is unset", async () => {
    app = buildApp(loadEnvFrom({ NODE_ENV: "test", LOG_LEVEL: "error" }));
    const res = await app.inject({ url: "/healthz", headers: { origin: "https://console.example" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/healthz",
      headers: { origin: "https://console.example", "access-control-request-method": "GET" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers exactly the allowlisted origins, with the console's headers", async () => {
    app = buildApp(
      loadEnvFrom({
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        CORS_ORIGINS: "https://console.example, http://127.0.0.1:5173",
      }),
    );
    const allowed = await app.inject({ url: "/healthz", headers: { origin: "http://127.0.0.1:5173" } });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(String(allowed.headers["access-control-expose-headers"])).toContain("RateLimit-Remaining");

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/programs",
      headers: {
        origin: "https://console.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type, x-app-key",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://console.example");
    expect(String(preflight.headers["access-control-allow-headers"]).toLowerCase()).toContain("x-app-key");
    expect(String(preflight.headers["access-control-allow-methods"])).toContain("POST");

    const other = await app.inject({ url: "/healthz", headers: { origin: "https://evil.example" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    // A sub-path or a different port is a different origin.
    const port = await app.inject({ url: "/healthz", headers: { origin: "http://127.0.0.1:5174" } });
    expect(port.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses wildcards, paths and bare hosts in CORS_ORIGINS", () => {
    for (const bad of ["*", "https://*.example", "https://console.example/app", "console.example", "ftp://x.example"]) {
      expect(() => loadEnvFrom({ CORS_ORIGINS: bad }), bad).toThrow(/CORS_ORIGINS/);
    }
    expect(loadEnvFrom({ CORS_ORIGINS: "https://Console.Example/" }).corsOrigins).toEqual(["https://console.example"]);
  });
});
