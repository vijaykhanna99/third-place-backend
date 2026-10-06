import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { PLAYBACK_EVENT_BODY_LIMIT } from "../src/modules/metrics/routes.js";
import { expectContract } from "./helpers/contract.js";

/**
 * Playback telemetry (spec §9) — requires Postgres:
 *   TEST_DATABASE_URL=postgres://tplace:tplace@localhost:5433/tplace pnpm test
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = Date.now();
const APP_KEY = "metrics-test-app-key";
/** Every event this suite stores carries this session id, so cleanup is exact. */
const SESSION = `7d444840-9dc0-11d1-b245-${String(RUN).slice(-12).padStart(12, "0")}`;
const EPISODE = "01890a5d-ac96-774b-b111-000000000301";

describe.runIf(Boolean(DB_URL))("metrics integration", () => {
  let app: FastifyInstance;
  const withKey = { "x-app-key": APP_KEY };

  beforeAll(async () => {
    app = buildApp(
      loadEnvFrom({
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        DATABASE_URL: DB_URL!,
        JWT_SIGNING_KEY: "9".repeat(64),
        APP_KEYS: APP_KEY,
      }),
    );
    await app.pgSql!`DELETE FROM playback_events WHERE session_uuid = ${SESSION}`;
    await app.ready();
  });

  afterAll(async () => {
    await app.pgSql!`DELETE FROM playback_events WHERE session_uuid = ${SESSION}`;
    await app.close();
  });

  const stored = async () =>
    (await app.pgSql!`SELECT event, position_sec, quality FROM playback_events WHERE session_uuid = ${SESSION} ORDER BY created_at`) as {
      event: string;
      position_sec: number;
      quality: string | null;
    }[];

  const post = (payload: unknown, headers: Record<string, string> = withKey) =>
    app.inject({ method: "POST", url: "/api/v1/metrics/playback", headers, payload: payload as string });

  it("stores a valid event and answers 202 with no body", async () => {
    const res = await post({ episodeID: EPISODE, event: "start", positionSec: 0, quality: "uhd8k", sessionUUID: SESSION });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe("");
    const nullQuality = await post({ episodeID: EPISODE, event: "progress", positionSec: 421.5, quality: null, sessionUUID: SESSION });
    expect(nullQuality.statusCode).toBe(202);
    const omitted = await post({ episodeID: EPISODE, event: "complete", positionSec: 5400, sessionUUID: SESSION });
    expect(omitted.statusCode).toBe(202);

    expect(await stored()).toEqual([
      { event: "start", position_sec: 0, quality: "uhd8k" },
      { event: "progress", position_sec: 421.5, quality: null },
      { event: "complete", position_sec: 5400, quality: null },
    ]);
  });

  it("drops invalid payloads silently — still 202, nothing stored", async () => {
    const before = (await stored()).length;
    const invalid = [
      { episodeID: EPISODE, event: "pause", positionSec: 1, sessionUUID: SESSION },
      { episodeID: EPISODE, event: "start", positionSec: -1, sessionUUID: SESSION },
      { episodeID: EPISODE, event: "start", positionSec: 1, quality: "4k", sessionUUID: SESSION },
      { episodeID: "not-a-uuid", event: "start", positionSec: 1, sessionUUID: SESSION },
      { episodeID: EPISODE, event: "start", positionSec: 1, sessionUUID: "nope" },
      { episodeID: EPISODE, event: "start", positionSec: "1", sessionUUID: SESSION },
      { episodeID: EPISODE, event: "start", positionSec: 1, sessionUUID: SESSION, extra: "field" },
      { event: "start" },
      [],
      "a string",
      null,
    ];
    for (const payload of invalid) {
      const res = await post(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(202);
    }
    expect((await stored()).length).toBe(before);
  });

  it("treats unparseable requests as invalid payloads too", async () => {
    const before = (await stored()).length;
    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/metrics/playback",
      headers: { ...withKey, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(malformed.statusCode).toBe(202);
    const wrongType = await app.inject({
      method: "POST",
      url: "/api/v1/metrics/playback",
      headers: { ...withKey, "content-type": "text/plain" },
      payload: "hello",
    });
    expect(wrongType.statusCode).toBe(202);
    const oversized = await app.inject({
      method: "POST",
      url: "/api/v1/metrics/playback",
      headers: { ...withKey, "content-type": "application/json" },
      payload: JSON.stringify({ episodeID: EPISODE, event: "start", positionSec: 0, sessionUUID: SESSION, pad: "x".repeat(PLAYBACK_EVENT_BODY_LIMIT) }),
    });
    expect(oversized.statusCode).toBe(202);
    expect((await stored()).length).toBe(before);
  });

  it("still requires the app key and keeps the gate's error shape", async () => {
    const res = await post({ episodeID: EPISODE, event: "start", positionSec: 0, sessionUUID: SESSION }, {});
    expect(res.statusCode).toBe(403);
    expectContract("POST", "/api/v1/metrics/playback", 403, res.json());
    // Unparseable AND unauthenticated: the gate wins, nothing is swallowed.
    const gated = await app.inject({
      method: "POST",
      url: "/api/v1/metrics/playback",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(gated.statusCode).toBe(403);
  });
});
