import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/modules/auth/service.js";
import { uploads } from "../src/db/schema/index.js";
import { expectContract } from "./helpers/contract.js";

/**
 * Catalog integration tests — require real Postgres. Run via:
 *   TEST_DATABASE_URL=postgres://tplace:tplace@localhost:5433/tplace pnpm test
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const KEY = "d".repeat(64);
const APP_KEY = "test-app-key";
const RUN = Date.now();
const OP = `itest-cat-${RUN}`;
const PASSWORD = "catalog-operator-1";

describe.runIf(Boolean(DB_URL))("catalog integration", () => {
  let app: FastifyInstance;
  let token: string;
  let userToken: string;
  let genreId: string;
  let otherGenreId: string;

  /** Uploads are created directly — the upload pipeline itself lands in step 6. */
  async function seedUpload(durationSec = 1800): Promise<string> {
    const [row] = await app
      .db!.insert(uploads)
      .values({
        r2Key: `itest/${RUN}/${Math.random().toString(36).slice(2)}.zip`,
        byteSize: 1024,
        checksum: "a".repeat(64),
        status: "ready",
        durationSec,
        createdBy: opAccountId,
      })
      .returning();
    return row!.id;
  }

  let opAccountId: string;

  const authed = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });
  const withKey = { "x-app-key": APP_KEY };

  beforeAll(async () => {
    app = buildApp(
      loadEnvFrom({
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        DATABASE_URL: DB_URL!,
        JWT_SIGNING_KEY: KEY,
        APP_KEYS: `${APP_KEY},rotating-second-key`,
        // Stream URLs are absolute URIs on the public media origin (contract).
        MEDIA_BASE_URL: "https://media.test.example",
      }),
    );
    await app.pgSql!`DELETE FROM playback_events WHERE quality = 'itest-cat'`;
    await app.pgSql!`DELETE FROM programs WHERE title LIKE 'itest-cat:%'`;
    await app.pgSql!`DELETE FROM genres WHERE name LIKE 'itest-cat:%'`;
    // Must precede the accounts delete: uploads.created_by references accounts.
    await app.pgSql!`DELETE FROM uploads WHERE r2_key LIKE 'itest/%'`;
    await app.pgSql!`DELETE FROM accounts WHERE handle LIKE 'itest-cat-%'`;

    const service = new AuthService(app.db!, app.env);
    const op = await service.createAccount({
      handle: OP,
      email: `${OP}@example.com`,
      password: PASSWORD,
      displayName: "Catalog Op",
      role: "operator",
    });
    opAccountId = op.id;
    await service.createAccount({
      handle: `${OP}-user`,
      email: `${OP}-user@example.com`,
      password: "plain-user-pw-99",
      displayName: "Plain",
      role: "user",
    });
    await app.ready();

    const login = async (h: string, p: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { identifier: h, password: p },
        })
      ).json<{ accessToken: string }>().accessToken;
    token = await login(OP, PASSWORD);
    userToken = await login(`${OP}-user`, "plain-user-pw-99");

    const [g1] = await app.pgSql!`
      INSERT INTO genres (id, name, description) VALUES (gen_random_uuid(), ${"itest-cat:Music" + RUN}, 'Live music')
      RETURNING id`;
    const [g2] = await app.pgSql!`
      INSERT INTO genres (id, name, description) VALUES (gen_random_uuid(), ${"itest-cat:Talk" + RUN}, 'Talk')
      RETURNING id`;
    genreId = g1!.id as string;
    otherGenreId = g2!.id as string;
  });

  afterAll(async () => {
    await app.pgSql!`DELETE FROM playback_events WHERE quality = 'itest-cat'`;
    await app.pgSql!`DELETE FROM programs WHERE title LIKE 'itest-cat:%'`;
    await app.pgSql!`DELETE FROM genres WHERE name LIKE 'itest-cat:%'`;
    await app.pgSql!`DELETE FROM uploads WHERE r2_key LIKE ${"itest/" + RUN + "/%"}`;
    await app.pgSql!`DELETE FROM accounts WHERE handle LIKE 'itest-cat-%'`;
    await app.close();
  });

  async function createProgram(title: string, episodeTitles: string[][]) {
    const season = [];
    for (let s = 0; s < episodeTitles.length; s++) {
      const eps = [];
      for (let e = 0; e < episodeTitles[s]!.length; e++) {
        eps.push({
          number: e + 1,
          title: episodeTitles[s]![e]!,
          description: `Episode ${String(e + 1)} description`,
          publishedAt: new Date(Date.UTC(2026, 6, 1 + s * 10 + e)).toISOString(),
          streams: [{ name: "Main", uploadID: await seedUpload(1800 + e) }],
        });
      }
      season.push({
        number: s + 1,
        title: `Season ${String(s + 1)}`,
        description: "Season description",
        episodes: eps,
      });
    }
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/programs",
      headers: authed(),
      payload: {
        title,
        description: "An immersive concert series",
        genreIDs: [genreId],
        thumbnailURL: "https://example.com/t.jpg",
        season,
      },
    });
    return res;
  }

  // ------------------------------------------------------------- app key

  it("public reads require a valid X-App-Key", async () => {
    const noKey = await app.inject({ method: "GET", url: "/api/v1/genres" });
    expect(noKey.statusCode).toBe(403);
    expect(noKey.json<{ error: { code: string } }>().error.code).toBe("app_key_required");

    const wrongKey = await app.inject({
      method: "GET",
      url: "/api/v1/genres",
      headers: { "x-app-key": "nope" },
    });
    expect(wrongKey.statusCode).toBe(403);

    const ok = await app.inject({ method: "GET", url: "/api/v1/genres", headers: withKey });
    expect(ok.statusCode).toBe(200);
    expectContract("GET", "/api/v1/genres", 200, ok.json());
    expectContract("GET", "/api/v1/genres", 403, noKey.json());

    // Rotation: the second configured key is accepted too.
    const rotated = await app.inject({
      method: "GET",
      url: "/api/v1/genres",
      headers: { "x-app-key": "rotating-second-key" },
    });
    expect(rotated.statusCode).toBe(200);

    // The gate must cover EVERY public route, not just /genres.
    const { id } = (await createProgram(`itest-cat:Gated ${RUN}`, [["E"]])).json<{ id: string }>();
    for (const url of [
      `/api/v1/programs/${id}`,
      `/api/v1/genres/${genreId}/programs`,
      `/api/v1/programs/${id}/episodes/search?query=abc`,
      "/api/v1/search?query=abc",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code, url).toBe("app_key_required");
      expect((await app.inject({ method: "GET", url, headers: withKey })).statusCode, url).toBe(200);
    }
  });

  // ------------------------------------------------------------ operator

  it("rejects catalog writes without the operator role", async () => {
    const anon = await app.inject({
      method: "POST",
      url: "/api/v1/programs",
      payload: { title: "x" },
    });
    expect(anon.statusCode).toBe(401);

    const asUser = await app.inject({
      method: "POST",
      url: "/api/v1/programs",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        title: "itest-cat:Nope",
        description: "d",
        genreIDs: [genreId],
        thumbnailURL: "https://example.com/t.jpg",
        season: [
          {
            number: 1,
            title: "S1",
            description: "d",
            episodes: [
              {
                number: 1,
                title: "E1",
                description: "d",
                publishedAt: "2026-07-01T00:00:00Z",
                streams: [{ name: "Main", uploadID: "01890a5d-ac96-774b-b111-000000000801" }],
              },
            ],
          },
        ],
      },
    });
    expect(asUser.statusCode).toBe(403);
    expect(asUser.json<{ error: { code: string } }>().error.code).toBe("forbidden");
  });

  it("creates a program with seasons and episodes, using the upload's duration", async () => {
    const res = await createProgram(`itest-cat:Neon Nights ${RUN}`, [
      ["Opening Night Tokyo", "Second Night Tokyo"],
      ["Studio Session"],
    ]);
    expect(res.statusCode).toBe(200);
    expectContract("POST", "/api/v1/programs", 200, res.json());
    const body = res.json<{
      id: string;
      viewCount: number;
      season: {
        number: number;
        episodes: { durationSec: number; streams: { name: string; streamURL: string }[] }[];
      }[];
      genre: { id: string }[];
      viewer: { isFollowing: boolean; isFavorited: boolean };
    }>();
    expect(body.season).toHaveLength(2);
    expect(body.season[0]!.episodes).toHaveLength(2);
    // Duration comes from the default angle's validated upload, not the request.
    expect(body.season[0]!.episodes[0]!.durationSec).toBe(1800);
    expect(body.season[0]!.episodes[0]!.streams).toHaveLength(1);
    expect(body.season[0]!.episodes[0]!.streams[0]!.name).toBe("Main");
    expect(body.season[0]!.episodes[0]!.streams[0]!.streamURL).toContain("/uploads/");
    expect(body.season[0]!.episodes[0]!.streams[0]!.streamURL).toContain("/index.m3u8");
    expect(body.viewCount).toBe(0);
    expect(body.genre[0]!.id).toBe(genreId);
    expect(body.viewer).toEqual({ isFollowing: false, isFavorited: false });
  });

  it("refuses an upload that is not ready or already attached", async () => {
    const [pending] = await app
      .db!.insert(uploads)
      .values({
        r2Key: `itest/${RUN}/pending.zip`,
        byteSize: 10,
        checksum: "b".repeat(64),
        status: "queued",
        createdBy: opAccountId,
      })
      .returning();

    const notReady = await app.inject({
      method: "POST",
      url: "/api/v1/programs",
      headers: authed(),
      payload: {
        title: "itest-cat:NotReady",
        description: "d",
        genreIDs: [genreId],
        thumbnailURL: "https://example.com/t.jpg",
        season: [
          {
            number: 1,
            title: "S1",
            description: "d",
            episodes: [
              {
                number: 1,
                title: "E1",
                description: "d",
                publishedAt: "2026-07-01T00:00:00Z",
                streams: [{ name: "Main", uploadID: pending!.id }],
              },
            ],
          },
        ],
      },
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json<{ error: { code: string } }>().error.code).toBe("upload_not_ready");

    // Re-using an upload already bound to an episode.
    const created = await createProgram(`itest-cat:Reuse ${RUN}`, [["Only"]]);
    const usedUpload = await app.pgSql!`
      SELECT es.upload_id FROM episode_streams es
      JOIN episodes e ON e.id = es.episode_id
      JOIN seasons s ON s.id = e.season_id
      WHERE s.program_id = ${created.json<{ id: string }>().id} LIMIT 1`;

    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/programs",
      headers: authed(),
      payload: {
        title: "itest-cat:Dup",
        description: "d",
        genreIDs: [genreId],
        thumbnailURL: "https://example.com/t.jpg",
        season: [
          {
            number: 1,
            title: "S1",
            description: "d",
            episodes: [
              {
                number: 1,
                title: "E1",
                description: "d",
                publishedAt: "2026-07-01T00:00:00Z",
                streams: [{ name: "Main", uploadID: usedUpload[0]!.upload_id as string }],
              },
            ],
          },
        ],
      },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ error: { code: string } }>().error.code).toBe("upload_already_attached");
  });

  it("filters program detail by seasonNumber and 404s unknown ones", async () => {
    const { id } = (await createProgram(`itest-cat:Seasons ${RUN}`, [["A"], ["B"]])).json<{
      id: string;
    }>();

    const one = await app.inject({
      method: "GET",
      url: `/api/v1/programs/${id}?seasonNumber=2`,
      headers: withKey,
    });
    expect(one.statusCode).toBe(200);
    expectContract("GET", "/api/v1/programs/{programID}", 200, one.json());
    const seasons = one.json<{ season: { number: number }[] }>().season;
    expect(seasons).toHaveLength(1);
    expect(seasons[0]!.number).toBe(2);

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/programs/${id}?seasonNumber=9`,
      headers: withKey,
    });
    expect(missing.statusCode).toBe(404);
    expectContract("GET", "/api/v1/programs/{programID}", 404, missing.json());
  });

  it("searches episodes within a program, and general search groups by program", async () => {
    const title = `itest-cat:Searchable ${RUN}`;
    const { id } = (
      await createProgram(title, [["Tokyo Dome Finale", "Osaka Warmup", "Kyoto Encore"]])
    ).json<{ id: string }>();

    const scoped = await app.inject({
      method: "GET",
      url: `/api/v1/programs/${id}/episodes/search?query=tokyo`,
      headers: withKey,
    });
    expect(scoped.statusCode).toBe(200);
    expectContract("GET", "/api/v1/programs/{programID}/episodes/search", 200, scoped.json());
    const scopedBody = scoped.json<{ total: number; episodes: { title: string }[] }>();
    expect(scopedBody.episodes).toHaveLength(1);
    expect(scopedBody.episodes[0]!.title).toBe("Tokyo Dome Finale");

    // Program-title match → every episode of that program.
    const byProgram = await app.inject({
      method: "GET",
      url: `/api/v1/search?query=${encodeURIComponent("Searchable " + String(RUN))}`,
      headers: withKey,
    });
    expectContract("GET", "/api/v1/search", 200, byProgram.json());
    const progHit = byProgram
      .json<{ programs: { id: string; matchedBy: string; episodes: unknown[] }[] }>()
      .programs.find((p) => p.id === id)!;
    expect(progHit.matchedBy).toBe("program");
    expect(progHit.episodes).toHaveLength(3);

    // Episode-only match → just the matching episode.
    const byEpisode = await app.inject({
      method: "GET",
      url: "/api/v1/search?query=Osaka",
      headers: withKey,
    });
    const epHit = byEpisode
      .json<{ programs: { id: string; matchedBy: string; episodes: { title: string }[] }[] }>()
      .programs.find((p) => p.id === id)!;
    expect(epHit.matchedBy).toBe("episode");
    expect(epHit.episodes).toHaveLength(1);
    expect(epHit.episodes[0]!.title).toBe("Osaka Warmup");
  });

  it("finds Japanese titles by substring (FTS alone cannot segment them)", async () => {
    const { id } = (await createProgram(`itest-cat:JP ${RUN}`, [["東京ドーム公演", "大阪公演"]])).json<{
      id: string;
    }>();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/programs/${id}/episodes/search?query=${encodeURIComponent("ドーム")}`,
      headers: withKey,
    });
    expect(res.statusCode).toBe(200);
    const found = res.json<{ episodes: { title: string }[] }>().episodes;
    expect(found).toHaveLength(1);
    expect(found[0]!.title).toBe("東京ドーム公演");
  });

  it("paginates genre listings by cursor without repeats", async () => {
    const titles = [`itest-cat:P1 ${RUN}`, `itest-cat:P2 ${RUN}`, `itest-cat:P3 ${RUN}`];
    for (const t of titles) expect((await createProgram(t, [["E"]])).statusCode).toBe(200);

    const first = await app.inject({
      method: "GET",
      url: `/api/v1/genres/${genreId}/programs?limit=2`,
      headers: withKey,
    });
    expectContract("GET", "/api/v1/genres/{genreID}/programs", 200, first.json());
    const page1 = first.json<{
      total: number;
      nextCursor: string | null;
      programs: { id: string }[];
    }>();
    expect(page1.programs).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.total).toBeGreaterThanOrEqual(3);

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/genres/${genreId}/programs?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      headers: withKey,
    });
    const page2 = second.json<{ programs: { id: string }[] }>();
    const ids1 = page1.programs.map((p) => p.id);
    const ids2 = page2.programs.map((p) => p.id);
    expect(ids1.filter((i) => ids2.includes(i))).toHaveLength(0);

    const bad = await app.inject({
      method: "GET",
      url: `/api/v1/genres/${genreId}/programs?cursor=not-a-cursor`,
      headers: withKey,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("updates a program partially and replaces genres", async () => {
    const created = (await createProgram(`itest-cat:Updatable ${RUN}`, [["First"]])).json<{
      id: string;
      season: { episodes: { id: string }[] }[];
    }>();
    const episodeId = created.season[0]!.episodes[0]!.id;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/programs/${created.id}/update`,
      headers: authed(),
      payload: {
        title: `itest-cat:Renamed ${RUN}`,
        description: null,
        genreIDs: [otherGenreId],
        episodes: [{ episodeID: episodeId, title: "Renamed Episode" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      title: string;
      description: string;
      genre: { id: string }[];
      season: { episodes: { title: string }[] }[];
    }>();
    expect(body.title).toBe(`itest-cat:Renamed ${RUN}`);
    // null means untouched.
    expect(body.description).toBe("An immersive concert series");
    expect(body.genre.map((g) => g.id)).toEqual([otherGenreId]);
    expect(body.season[0]!.episodes[0]!.title).toBe("Renamed Episode");
  });

  it("refuses to edit an episode belonging to another program", async () => {
    const a = (await createProgram(`itest-cat:OwnerA ${RUN}`, [["A"]])).json<{ id: string }>();
    const b = (await createProgram(`itest-cat:OwnerB ${RUN}`, [["B"]])).json<{
      id: string;
      season: { episodes: { id: string }[] }[];
    }>();
    const foreignEpisode = b.season[0]!.episodes[0]!.id;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/programs/${a.id}/update`,
      headers: authed(),
      payload: { episodes: [{ episodeID: foreignEpisode, title: "Hijacked" }] },
    });
    expect(res.statusCode).toBe(404);

    // And the target is untouched.
    const check = await app.inject({
      method: "GET",
      url: `/api/v1/programs/${b.id}`,
      headers: withKey,
    });
    expect(check.json<{ season: { episodes: { title: string }[] }[] }>().season[0]!.episodes[0]!.title).toBe(
      "B",
    );
  });

  it("soft-deletes a program, cascading to episodes and hiding it from all reads", async () => {
    const created = (await createProgram(`itest-cat:Doomed ${RUN}`, [["Gone"]])).json<{
      id: string;
    }>();

    const del = await app.inject({
      method: "POST",
      url: `/api/v1/programs/${created.id}/delete`,
      headers: authed(),
    });
    expect(del.statusCode).toBe(200);
    expectContract("POST", "/api/v1/programs/{programID}/delete", 200, del.json());
    expect(del.json<{ deleted: boolean; episodeID: null }>()).toMatchObject({
      targetType: "program",
      deleted: true,
      episodeID: null,
    });

    expect(
      (await app.inject({ method: "GET", url: `/api/v1/programs/${created.id}`, headers: withKey }))
        .statusCode,
    ).toBe(404);

    const search = await app.inject({
      method: "GET",
      url: `/api/v1/search?query=${encodeURIComponent("Doomed " + String(RUN))}`,
      headers: withKey,
    });
    expect(search.json<{ programs: unknown[] }>().programs).toHaveLength(0);

    // Episodes cascaded.
    const remaining = await app.pgSql!`
      SELECT count(*)::int AS n FROM episodes e
      JOIN seasons s ON s.id = e.season_id
      WHERE s.program_id = ${created.id} AND e.deleted_at IS NULL`;
    expect(remaining[0]!.n).toBe(0);

    // Deleting twice is a 404, not a second success.
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/programs/${created.id}/delete`,
          headers: authed(),
        })
      ).statusCode,
    ).toBe(404);
  });

  it("soft-deletes a single episode without touching its siblings", async () => {
    const created = (await createProgram(`itest-cat:PartialDelete ${RUN}`, [["Keep", "Remove"]])).json<{
      id: string;
      season: { episodes: { id: string; title: string }[] }[];
    }>();
    const target = created.season[0]!.episodes.find((e) => e.title === "Remove")!;

    const del = await app.inject({
      method: "POST",
      url: `/api/v1/episodes/${target.id}/delete`,
      headers: authed(),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ programID: string }>().programID).toBe(created.id);

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/programs/${created.id}`,
      headers: withKey,
    });
    const eps = after.json<{ season: { episodes: { title: string }[] }[] }>().season[0]!.episodes;
    expect(eps).toHaveLength(1);
    expect(eps[0]!.title).toBe("Keep");
  });

  it("treats LIKE metacharacters in the query as literal text", async () => {
    const { id } = (
      await createProgram(`itest-cat:Wildcards ${RUN}`, [["100% Off Deal", "Plain Episode"]])
    ).json<{ id: string }>();

    const search = async (q: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/programs/${id}/episodes/search?query=${encodeURIComponent(q)}`,
          headers: withKey,
        })
      ).json<{ episodes: { title: string }[] }>().episodes;

    // A literal % must match only the episode containing it — not everything.
    const pct = await search("100% Off");
    expect(pct).toHaveLength(1);
    expect(pct[0]!.title).toBe("100% Off Deal");

    // A bare wildcard must match nothing, rather than dumping the catalogue.
    expect(await search("%%%")).toHaveLength(0);
    // `_` is a single-char wildcard in LIKE; here it is just an underscore.
    expect(await search("1_0")).toHaveLength(0);
  });

  it("paginates without skipping rows even when programs are updated mid-sweep", async () => {
    const [fresh] = await app.pgSql!`
      INSERT INTO genres (id, name, description)
      VALUES (gen_random_uuid(), ${"itest-cat:Paged" + RUN}, 'p') RETURNING id`;
    const pagedGenre = fresh!.id as string;

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const created = (await createProgram(`itest-cat:Page${String(i)} ${RUN}`, [["E"]])).json<{
        id: string;
      }>();
      await app.inject({
        method: "POST",
        url: `/api/v1/programs/${created.id}/update`,
        headers: authed(),
        payload: { genreIDs: [pagedGenre] },
      });
      ids.push(created.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url: string =
        `/api/v1/genres/${pagedGenre}/programs?limit=2` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const body: { nextCursor: string | null; programs: { id: string }[] } = (
        await app.inject({ method: "GET", url, headers: withKey })
      ).json();
      seen.push(...body.programs.map((p) => p.id));
      cursor = body.nextCursor;
      if (!cursor) break;
      // Mutate a program the sweep has ALREADY passed. With a cursor keyed on
      // updatedAt this would reshuffle the ordering and skip unseen rows.
      await app.inject({
        method: "POST",
        url: `/api/v1/programs/${ids[0]!}/update`,
        headers: authed(),
        payload: { description: `touched ${String(guard)}` },
      });
    }

    expect(new Set(seen).size).toBe(seen.length); // no repeats
    for (const id of ids) expect(seen).toContain(id); // no skips
  });

  it("replaces an episode's stream set and tolerates re-sending the current one", async () => {
    const created = (await createProgram(`itest-cat:Replace ${RUN}`, [["Original"]])).json<{
      id: string;
      season: { episodes: { id: string; durationSec: number }[] }[];
    }>();
    const episodeId = created.season[0]!.episodes[0]!.id;

    // Replace the single angle with two: a new Main plus a Side angle.
    const newMain = await seedUpload(9999);
    const side = await seedUpload(9998);
    const swap = await app.inject({
      method: "POST",
      url: `/api/v1/programs/${created.id}/update`,
      headers: authed(),
      payload: {
        episodes: [
          {
            episodeID: episodeId,
            streams: [
              { name: "Main", uploadID: newMain },
              { name: "Side", uploadID: side },
            ],
          },
        ],
      },
    });
    expect(swap.statusCode).toBe(200);
    const swapped = swap.json<{
      season: { episodes: { durationSec: number; streams: { name: string }[] }[] }[];
    }>().season[0]!.episodes[0]!;
    // Duration follows the new default angle; order is preserved.
    expect(swapped.durationSec).toBe(9999);
    expect(swapped.streams.map((st) => st.name)).toEqual(["Main", "Side"]);

    // Replaying the same body must be idempotent, not a spurious conflict.
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/programs/${created.id}/update`,
      headers: authed(),
      payload: {
        episodes: [
          {
            episodeID: episodeId,
            streams: [
              { name: "Main", uploadID: newMain },
              { name: "Side", uploadID: side },
            ],
          },
        ],
      },
    });
    expect(replay.statusCode).toBe(200);

    // But an upload held by a different live episode is still a conflict.
    const other = (await createProgram(`itest-cat:Holder ${RUN}`, [["Holder"]])).json<{
      season: { episodes: { id: string }[] }[];
    }>();
    const heldUpload = (
      await app.pgSql!`SELECT upload_id FROM episode_streams WHERE episode_id = ${other.season[0]!.episodes[0]!.id}`
    )[0]!.upload_id as string;
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/programs/${created.id}/update`,
      headers: authed(),
      payload: {
        episodes: [{ episodeID: episodeId, streams: [{ name: "Main", uploadID: heldUpload }] }],
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe("upload_already_attached");

    // Duplicate angle names within one episode are a 400.
    const dupNames = await app.inject({
      method: "POST",
      url: `/api/v1/programs/${created.id}/update`,
      headers: authed(),
      payload: {
        episodes: [
          {
            episodeID: episodeId,
            streams: [
              { name: "Main", uploadID: newMain },
              { name: "Main", uploadID: side },
            ],
          },
        ],
      },
    });
    expect(dupNames.statusCode).toBe(400);
  });

  it("returns multi-angle streams in order and viewCount from playback starts", async () => {
    const created = (await createProgram(`itest-cat:Angles ${RUN}`, [["Multi"]])).json<{
      id: string;
      season: { episodes: { id: string }[] }[];
    }>();
    const episodeId = created.season[0]!.episodes[0]!.id;
    const overhead = await seedUpload(7777);
    const side = await seedUpload(8888);

    // Grow the episode to three angles.
    const mainUpload = (
      await app.pgSql!`SELECT upload_id FROM episode_streams WHERE episode_id = ${episodeId}`
    )[0]!.upload_id as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/programs/${created.id}/update`,
      headers: authed(),
      payload: {
        episodes: [
          {
            episodeID: episodeId,
            streams: [
              { name: "Main", uploadID: mainUpload },
              { name: "Side", uploadID: side },
              { name: "Overhead", uploadID: overhead },
            ],
          },
        ],
      },
    });

    // Seed playback telemetry: 3 starts + noise that must not count.
    for (const event of ["start", "start", "start", "progress", "complete"]) {
      await app.pgSql!`
        INSERT INTO playback_events (id, episode_id, event, position_sec, quality, session_uuid)
        VALUES (gen_random_uuid(), ${episodeId}, ${event}, 0, 'itest-cat', gen_random_uuid())`;
    }

    const detail = (
      await app.inject({ method: "GET", url: `/api/v1/programs/${created.id}`, headers: withKey })
    ).json<{
      viewCount: number;
      season: { episodes: { streams: { name: string; streamURL: string }[] }[] }[];
    }>();
    expect(detail.viewCount).toBe(3);
    const names = detail.season[0]!.episodes[0]!.streams.map((st) => st.name);
    expect(names).toEqual(["Main", "Side", "Overhead"]);
    for (const st of detail.season[0]!.episodes[0]!.streams) {
      expect(st.streamURL).toMatch(/\/uploads\/[0-9a-f-]+\/index\.m3u8$/);
    }
  });

  it("frees a deleted episode's uploads for reuse", async () => {
    const a = (await createProgram(`itest-cat:Freed ${RUN}`, [["Recycled"]])).json<{
      id: string;
      season: { episodes: { id: string }[] }[];
    }>();
    const episodeId = a.season[0]!.episodes[0]!.id;
    const upload = (
      await app.pgSql!`SELECT upload_id FROM episode_streams WHERE episode_id = ${episodeId}`
    )[0]!.upload_id as string;

    await app.inject({
      method: "POST",
      url: `/api/v1/episodes/${episodeId}/delete`,
      headers: authed(),
    });

    // The upload is unclaimed now — a new program can use it.
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/programs",
      headers: authed(),
      payload: {
        title: `itest-cat:Recycler ${RUN}`,
        description: "d",
        genreIDs: [genreId],
        thumbnailURL: "https://example.com/t.jpg",
        season: [
          {
            number: 1,
            title: "S1",
            description: "d",
            episodes: [
              {
                number: 1,
                title: "E1",
                description: "d",
                publishedAt: "2026-07-01T00:00:00Z",
                streams: [{ name: "Main", uploadID: upload }],
              },
            ],
          },
        ],
      },
    });
    expect(reuse.statusCode).toBe(200);
  });

  it("rejects duplicate season/episode numbers with a 4xx, not a 500", async () => {
    const title = `itest-cat:Dupes ${RUN}`;
    const mkSeason = (number: number, epNumbers: number[]) => ({
      number,
      title: `S${String(number)}`,
      description: "d",
      episodes: epNumbers.map((n) => ({
        number: n,
        title: `E${String(n)}`,
        description: "d",
        publishedAt: "2026-07-01T00:00:00Z",
        streams: [{ name: "Main", uploadID: "" }],
      })),
    });

    const dupSeasons = mkSeason(1, [1]);
    const second = mkSeason(1, [1]);
    dupSeasons.episodes[0]!.streams[0]!.uploadID = await seedUpload();
    second.episodes[0]!.streams[0]!.uploadID = await seedUpload();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/programs",
      headers: authed(),
      payload: {
        title,
        description: "d",
        genreIDs: [genreId],
        thumbnailURL: "https://example.com/t.jpg",
        season: [dupSeasons, second],
      },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);

    // Nothing was persisted.
    const rows = await app.pgSql!`SELECT count(*)::int AS n FROM programs WHERE title = ${title}`;
    expect(rows[0]!.n).toBe(0);
  });

  it("counts only live programs in genre listings", async () => {
    const before = (
      await app.inject({ method: "GET", url: "/api/v1/genres", headers: withKey })
    ).json<{ genres: { id: string; programCount: number }[] }>();
    const countBefore = before.genres.find((g) => g.id === genreId)!.programCount;

    const created = (await createProgram(`itest-cat:Counted ${RUN}`, [["E"]])).json<{ id: string }>();
    await app.inject({
      method: "POST",
      url: `/api/v1/programs/${created.id}/delete`,
      headers: authed(),
    });

    const after = (
      await app.inject({ method: "GET", url: "/api/v1/genres", headers: withKey })
    ).json<{ genres: { id: string; programCount: number }[] }>();
    expect(after.genres.find((g) => g.id === genreId)!.programCount).toBe(countBefore);
  });
});
