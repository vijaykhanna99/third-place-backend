import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { uploads } from "../src/db/schema/index.js";
import { AuthService } from "../src/modules/auth/service.js";
import { streamPrefixForUpload, verifyStreamToken } from "../src/lib/stream-token.js";
import { expectContract } from "./helpers/contract.js";

/**
 * Stream-URL issuance (spec §5.3) — requires Postgres:
 *   TEST_DATABASE_URL=postgres://tplace:tplace@localhost:5433/tplace pnpm test
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const RUN = Date.now();
const OP = `itest-media-${RUN}`;
const PASSWORD = "media-operator-1";
const APP_KEY = "media-test-app-key";
const SECRET = "media-test-stream-secret-0123456789";
const BASE = "https://media.test.example";
const TTL = 900;

describe.runIf(Boolean(DB_URL))("media integration", () => {
  let app: FastifyInstance;
  let token: string;
  let opAccountId: string;
  let genreId: string;
  const withKey = { "x-app-key": APP_KEY };

  async function seedUpload(): Promise<string> {
    const [row] = await app
      .db!.insert(uploads)
      .values({
        r2Key: `itest-media/${RUN}/${Math.random().toString(36).slice(2)}.zip`,
        byteSize: 1024,
        checksum: "a".repeat(64),
        status: "ready",
        durationSec: 1800,
        createdBy: opAccountId,
      })
      .returning();
    return row!.id;
  }

  async function cleanDatabase() {
    const sql = app.pgSql!;
    await sql`DELETE FROM programs WHERE title LIKE 'itest-media:%'`;
    await sql`DELETE FROM genres WHERE name LIKE 'itest-media:%'`;
    await sql`DELETE FROM uploads WHERE r2_key LIKE 'itest-media/%'`;
    await sql`DELETE FROM accounts WHERE handle LIKE 'itest-media-%'`;
  }

  beforeAll(async () => {
    app = buildApp(
      loadEnvFrom({
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        DATABASE_URL: DB_URL!,
        JWT_SIGNING_KEY: "f".repeat(64),
        APP_KEYS: APP_KEY,
        MEDIA_BASE_URL: BASE,
        STREAM_TOKEN_SECRET: SECRET,
        STREAM_TOKEN_TTL_SEC: String(TTL),
      }),
    );
    await cleanDatabase();
    const auth = new AuthService(app.db!, app.env);
    const op = await auth.createAccount({
      handle: OP,
      email: `${OP}@example.com`,
      password: PASSWORD,
      displayName: "Media Op",
      role: "operator",
    });
    opAccountId = op.id;
    await app.ready();
    token = (
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { identifier: OP, password: PASSWORD },
      })
    ).json<{ accessToken: string }>().accessToken;
    const [g] = await app.pgSql!`
      INSERT INTO genres (id, name, description) VALUES (gen_random_uuid(), ${"itest-media:G" + String(RUN)}, 'g')
      RETURNING id`;
    genreId = g!.id as string;
  });

  afterAll(async () => {
    await cleanDatabase();
    await app.close();
  });

  /** One program, one season, one episode with the given angle names. */
  async function createEpisode(title: string, angles: string[]) {
    const streams = [];
    for (const name of angles) streams.push({ name, uploadID: await seedUpload() });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/programs",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: `itest-media:${title} ${String(RUN)}`,
        description: "d",
        genreIDs: [genreId],
        thumbnailURL: "https://example.com/t.jpg",
        season: [
          {
            number: 1,
            title: "S1",
            description: "d",
            episodes: [
              { number: 1, title: "E1", description: "d", publishedAt: "2026-07-01T00:00:00Z", streams },
            ],
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      id: string;
      season: { episodes: { id: string; streams: { name: string; streamURL: string }[] }[] }[];
    }>();
    return { programId: body.id, episode: body.season[0]!.episodes[0]!, uploadIds: streams.map((s) => s.uploadID) };
  }

  /** Parses `?token=` off a stream URL and verifies it against the issuing secret. */
  function tokenOf(streamURL: string, uploadId: string) {
    const url = new URL(streamURL);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/uploads/${uploadId}/index.m3u8`);
    const t = url.searchParams.get("token");
    expect(t, streamURL).toBeTruthy();
    const verified = verifyStreamToken(SECRET, t!, { path: `uploads/${uploadId}/uhd8k/segment-00001.ts` });
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
    return verified.ok ? verified.claims : null;
  }

  it("issues one tokenised URL per camera angle, in presentation order, with a shared expiry", async () => {
    const { episode, uploadIds } = await createEpisode("Angles", ["Main", "Side", "Overhead"]);
    const before = Math.floor(Date.now() / 1000);

    const res = await app.inject({ method: "GET", url: `/api/v1/episodes/${episode.id}/stream`, headers: withKey });
    expect(res.statusCode).toBe(200);
    expectContract("GET", "/api/v1/episodes/{episodeID}/stream", 200, res.json());
    const body = res.json<{ episodeID: string; streams: { name: string; streamURL: string }[]; expiresAt: string }>();

    expect(body.episodeID).toBe(episode.id);
    expect(body.streams.map((s) => s.name)).toEqual(["Main", "Side", "Overhead"]);
    const expiresAt = Math.floor(new Date(body.expiresAt).getTime() / 1000);
    expect(expiresAt).toBeGreaterThanOrEqual(before + TTL);
    expect(expiresAt).toBeLessThanOrEqual(before + TTL + 5);
    body.streams.forEach((s, i) => {
      const claims = tokenOf(s.streamURL, uploadIds[i]!)!;
      // Each token is scoped to exactly its own upload and expires with the response.
      expect(claims.pathPrefix).toBe(streamPrefixForUpload(uploadIds[i]!));
      expect(claims.exp).toBe(expiresAt);
    });
    // One angle's token does not open another angle's files.
    const main = new URL(body.streams[0]!.streamURL).searchParams.get("token")!;
    expect(verifyStreamToken(SECRET, main, { path: `uploads/${uploadIds[1]!}/index.m3u8` })).toEqual({
      ok: false,
      reason: "prefix_mismatch",
    });
  });

  it("program detail carries the same tokenised URLs", async () => {
    const { programId, episode, uploadIds } = await createEpisode("Detail", ["Main"]);
    // The create response itself already carried a token.
    tokenOf(episode.streams[0]!.streamURL, uploadIds[0]!);

    const detail = await app.inject({ method: "GET", url: `/api/v1/programs/${programId}`, headers: withKey });
    expect(detail.statusCode).toBe(200);
    expectContract("GET", "/api/v1/programs/{programID}", 200, detail.json());
    const streams = detail.json<{ season: { episodes: { streams: { streamURL: string }[] }[] }[] }>().season[0]!
      .episodes[0]!.streams;
    tokenOf(streams[0]!.streamURL, uploadIds[0]!);
  });

  it("requires the app key", async () => {
    const { episode } = await createEpisode("Gated", ["Main"]);
    const res = await app.inject({ method: "GET", url: `/api/v1/episodes/${episode.id}/stream` });
    expect(res.statusCode).toBe(403);
    expectContract("GET", "/api/v1/episodes/{episodeID}/stream", 403, res.json());
    expect(res.json<{ error: { code: string } }>().error.code).toBe("app_key_required");
  });

  it("stops issuing tokens the moment an episode or its program is deleted", async () => {
    const a = await createEpisode("DeletedEpisode", ["Main"]);
    const b = await createEpisode("DeletedProgram", ["Main"]);
    const authed = { authorization: `Bearer ${token}` };
    expect(
      (await app.inject({ method: "POST", url: `/api/v1/episodes/${a.episode.id}/delete`, headers: authed }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: `/api/v1/programs/${b.programId}/delete`, headers: authed }))
        .statusCode,
    ).toBe(200);

    for (const id of [a.episode.id, b.episode.id, "01890a5d-ac96-774b-b111-0000000000ff"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/episodes/${id}/stream`, headers: withKey });
      expect(res.statusCode, id).toBe(404);
      expectContract("GET", "/api/v1/episodes/{episodeID}/stream", 404, res.json());
    }
  });

  it("rejects a malformed episode id with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/episodes/not-a-uuid/stream", headers: withKey });
    expect(res.statusCode).toBe(400);
  });
});
