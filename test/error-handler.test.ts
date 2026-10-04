import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { errors } from "../src/lib/errors.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function appWithRoutes(): FastifyInstance {
  const a = buildApp(loadEnvFrom({ NODE_ENV: "test", LOG_LEVEL: "error" }));
  a.get("/boom-app-error", () => {
    throw errors.conflict("handle_taken", "Handle is already in use");
  });
  a.get("/boom-unknown", () => {
    // Non-Error throw — must never leak details to the client.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately hostile input
    throw { weird: "object", secret: "do-not-leak" };
  });
  a.post(
    "/validated",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    },
    () => ({ ok: true }),
  );
  return a;
}

describe("error handler (spec §2.3 shape)", () => {
  it("AppError maps to its status and code", async () => {
    app = appWithRoutes();
    const res = await app.inject({ method: "GET", url: "/boom-app-error" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: "handle_taken", message: "Handle is already in use" },
    });
  });

  it("unexpected non-Error throws become an opaque 500", async () => {
    app = appWithRoutes();
    const res = await app.inject({ method: "GET", url: "/boom-unknown" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    expect(res.body).not.toContain("do-not-leak");
  });

  it("schema validation failures return validation_failed", async () => {
    app = appWithRoutes();
    const res = await app.inject({
      method: "POST",
      url: "/validated",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("validation_failed");
  });

  it("malformed JSON bodies return validation_failed, not a crash", async () => {
    app = appWithRoutes();
    const res = await app.inject({
      method: "POST",
      url: "/validated",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("validation_failed");
  });
});
