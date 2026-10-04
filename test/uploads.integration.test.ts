import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/modules/auth/service.js";
import { Storage, storageConfigFromEnv } from "../src/lib/storage.js";
import { processUpload } from "../src/jobs/extraction.js";
import { makeZip, type ZipInput } from "./helpers/zip-builder.js";

/**
 * Upload-pipeline integration — needs Postgres, Redis, and object storage:
 *   TEST_DATABASE_URL=postgres://tplace:tplace@localhost:5433/tplace \
 *   TEST_REDIS_URL=redis://localhost:6379 \
 *   TEST_S3_ENDPOINT=http://127.0.0.1:9000 pnpm test
 *
 * The queue is bypassed on purpose: the extraction processor is invoked
 * directly so tests assert the pipeline, not BullMQ's delivery.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;
const REDIS_URL = process.env.TEST_REDIS_URL;
const RUN = Date.now();
const OP = `itest-up-${RUN}`;
const PASSWORD = "upload-operator-1";

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="JA",LANGUAGE="ja",URI="subtitles/ja/subtitle.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=48000000,RESOLUTION=7680x4320,SUBTITLES="subs"
uhd8k/playlist.m3u8
`;
const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
segment-00001.ts
#EXTINF:6.0,
segment-00002.ts
#EXT-X-ENDLIST
`;
const SUBS = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg-00001.vtt
#EXT-X-ENDLIST
`;

/** A structurally complete, valid HLS bundle. */
function validBundle(): ZipInput[] {
  return [
    { path: "index.m3u8", content: MASTER },
    { path: "uhd8k/playlist.m3u8", content: MEDIA },
    { path: "uhd8k/segment-00001.ts", content: "segment-one-bytes" },
    { path: "uhd8k/segment-00002.ts", content: "segment-two-bytes" },
    { path: "subtitles/ja/subtitle.m3u8", content: SUBS },
    { path: "subtitles/ja/seg-00001.vtt", content: "WEBVTT\n\n00:00.000 --> 00:06.000\nhello\n" },
  ];
}

/** 1x1 PNG. */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe.runIf(Boolean(DB_URL && S3_ENDPOINT && REDIS_URL))("uploads integration", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let token: string;

  const authed = { authorization: "" as string };

  beforeAll(async () => {
    app = buildApp(
      loadEnvFrom({
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        DATABASE_URL: DB_URL!,
        // A real queue so `complete` enqueues as it would in production; no
        // worker runs here, so the tests drive processUpload() directly and
        // assert the pipeline rather than BullMQ's delivery.
        REDIS_URL: REDIS_URL!,
        JWT_SIGNING_KEY: "e".repeat(64),
        R2_ENDPOINT: S3_ENDPOINT!,
        R2_ACCESS_KEY_ID: "tplace",
        R2_SECRET_ACCESS_KEY: "tplace-secret",
        R2_BUCKET_MEDIA: "tplace-media-dev",
        MEDIA_BASE_URL: `${S3_ENDPOINT!}/tplace-media-dev`,
      }),
    );
    await app.pgSql!`DELETE FROM uploads WHERE r2_key LIKE ${"tmp/uploads/%"} AND created_by IN (SELECT id FROM accounts WHERE handle LIKE 'itest-up-%')`;
    await app.pgSql!`DELETE FROM images WHERE r2_key LIKE 'media/images/%' AND created_by IN (SELECT id FROM accounts WHERE handle LIKE 'itest-up-%')`;
    await app.pgSql!`DELETE FROM accounts WHERE handle LIKE 'itest-up-%'`;

    const auth = new AuthService(app.db!, app.env);
    await auth.createAccount({
      handle: OP,
      email: `${OP}@example.com`,
      password: PASSWORD,
      displayName: "Upload Op",
      role: "operator",
    });
    await app.ready();

    token = (
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { identifier: OP, password: PASSWORD },
      })
    ).json<{ accessToken: string }>().accessToken;
    authed.authorization = `Bearer ${token}`;

    storage = new Storage(storageConfigFromEnv(app.env)!);
  });

  afterAll(async () => {
    const rows = await app.pgSql!`
      SELECT id FROM uploads WHERE created_by IN (SELECT id FROM accounts WHERE handle LIKE 'itest-up-%')`;
    for (const r of rows) {
      await storage.deletePrefix(`media/uploads/${r.id as string}`).catch(() => undefined);
      await storage.delete([`tmp/uploads/${r.id as string}.zip`]).catch(() => undefined);
    }
    const imgs = await app.pgSql!`
      SELECT r2_key FROM images WHERE created_by IN (SELECT id FROM accounts WHERE handle LIKE 'itest-up-%')`;
    await storage.delete(imgs.map((i) => i.r2_key as string)).catch(() => undefined);

    await app.pgSql!`DELETE FROM images WHERE created_by IN (SELECT id FROM accounts WHERE handle LIKE 'itest-up-%')`;
    await app.pgSql!`DELETE FROM uploads WHERE created_by IN (SELECT id FROM accounts WHERE handle LIKE 'itest-up-%')`;
    await app.pgSql!`DELETE FROM accounts WHERE handle LIKE 'itest-up-%'`;
    await app.close();
  });

  /** Full operator flow: initiate → PUT to the presigned URL → complete. */
  async function upload(zip: Buffer, opts: { corruptChecksum?: boolean } = {}) {
    const checksum = opts.corruptChecksum
      ? "b".repeat(64)
      : createHash("sha256").update(zip).digest("hex");

    const init = await app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: authed,
      payload: { fileName: "bundle.zip", byteSize: zip.length, checksum },
    });
    expect(init.statusCode).toBe(200);
    const { uploadID, uploadURL } = init.json<{ uploadID: string; uploadURL: string }>();

    // Upload straight to storage, exactly as the operator's tool would.
    const put = await fetch(uploadURL, {
      method: "PUT",
      body: new Uint8Array(zip),
      headers: { "content-length": String(zip.length) },
    });
    expect(put.ok, `presigned PUT failed: ${String(put.status)}`).toBe(true);

    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${uploadID}/complete`,
      headers: authed,
    });
    return { uploadID, complete };
  }

  const runWorker = (uploadId: string) =>
    processUpload({ db: app.db!, storage }, uploadId);

  const statusOf = async (uploadID: string) =>
    (
      await app.inject({ method: "GET", url: `/api/v1/uploads/${uploadID}`, headers: authed })
    ).json<{ status: string; playlistURL: string | null; durationSec: number | null; error: string | null }>();

  it("runs a valid HLS bundle end to end and publishes it", async () => {
    const zip = makeZip(validBundle());
    const { uploadID, complete } = await upload(zip);
    expect(complete.statusCode).toBe(200);
    expect(complete.json<{ status: string }>().status).toBe("queued");

    await runWorker(uploadID);

    const status = await statusOf(uploadID);
    expect(status.status).toBe("ready");
    expect(status.error).toBeNull();
    expect(status.durationSec).toBe(12);
    expect(status.playlistURL).toContain(`media/uploads/${uploadID}/index.m3u8`);

    // Every file landed under the per-upload prefix.
    const keys = await storage.listPrefix(`media/uploads/${uploadID}`);
    expect(keys).toHaveLength(6);
    expect(keys).toContain(`media/uploads/${uploadID}/uhd8k/segment-00001.ts`);
    expect(keys).toContain(`media/uploads/${uploadID}/subtitles/ja/seg-00001.vtt`);

    // The temp archive is cleaned up on success.
    expect(await storage.head(`tmp/uploads/${uploadID}.zip`)).toBeNull();
  });

  it("fails a bundle whose playlist references a missing segment, publishing nothing", async () => {
    const zip = makeZip(validBundle().filter((f) => !f.path.endsWith("segment-00002.ts")));
    const { uploadID } = await upload(zip);
    await runWorker(uploadID);

    const status = await statusOf(uploadID);
    expect(status.status).toBe("failed");
    expect(status.error).toContain("missing_reference");
    expect(status.playlistURL).toBeNull();

    // Rolled back: nothing left half-published.
    expect(await storage.listPrefix(`media/uploads/${uploadID}`)).toHaveLength(0);
    // The archive is retained for investigation.
    expect(await storage.head(`tmp/uploads/${uploadID}.zip`)).not.toBeNull();
  });

  it("rejects a Zip Slip archive without writing anything", async () => {
    const zip = makeZip([...validBundle(), { path: "../../escape.ts", content: "pwned" }]);
    const { uploadID } = await upload(zip);
    await runWorker(uploadID);

    const status = await statusOf(uploadID);
    expect(status.status).toBe("failed");
    expect(status.error).toContain("unsafe_path");
    expect(await storage.listPrefix(`media/uploads/${uploadID}`)).toHaveLength(0);
  });

  it("rejects disallowed file types", async () => {
    const zip = makeZip([...validBundle(), { path: "payload.sh", content: "#!/bin/sh\nrm -rf /" }]);
    const { uploadID } = await upload(zip);
    await runWorker(uploadID);
    expect((await statusOf(uploadID)).error).toContain("disallowed_extension");
  });

  it("rejects an archive with no master playlist", async () => {
    const zip = makeZip(validBundle().filter((f) => f.path !== "index.m3u8"));
    const { uploadID } = await upload(zip);
    await runWorker(uploadID);
    expect((await statusOf(uploadID)).error).toContain("missing_master_playlist");
  });

  it("rejects a playlist that points outside its own upload", async () => {
    const zip = makeZip([
      {
        path: "index.m3u8",
        content: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://evil.example/playlist.m3u8\n`,
      },
      { path: "uhd8k/playlist.m3u8", content: MEDIA },
      { path: "uhd8k/segment-00001.ts", content: "a" },
      { path: "uhd8k/segment-00002.ts", content: "b" },
    ]);
    const { uploadID } = await upload(zip);
    await runWorker(uploadID);
    expect((await statusOf(uploadID)).error).toContain("missing_reference");
  });

  it("fails on a checksum mismatch rather than trusting the archive", async () => {
    const zip = makeZip(validBundle());
    const { uploadID, complete } = await upload(zip, { corruptChecksum: true });
    expect(complete.statusCode).toBe(200);
    await runWorker(uploadID);

    const status = await statusOf(uploadID);
    expect(status.status).toBe("failed");
    expect(status.error).toContain("checksum_mismatch");
    expect(await storage.listPrefix(`media/uploads/${uploadID}`)).toHaveLength(0);
  });

  it("refuses to complete when nothing was actually uploaded", async () => {
    const init = await app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: authed,
      payload: { fileName: "ghost.zip", byteSize: 100, checksum: "c".repeat(64) },
    });
    const { uploadID } = init.json<{ uploadID: string }>();
    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${uploadID}/complete`,
      headers: authed,
    });
    expect(complete.statusCode).toBe(400);
  });

  it("detects a size mismatch between declaration and stored object", async () => {
    const zip = makeZip(validBundle());
    const init = await app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: authed,
      // Declare a different size than we will store.
      payload: {
        fileName: "bundle.zip",
        byteSize: zip.length + 1000,
        checksum: createHash("sha256").update(zip).digest("hex"),
      },
    });
    const { uploadID } = init.json<{ uploadID: string }>();
    // Bypass the presigned URL (its signature pins ContentLength) and store
    // directly, simulating a truncated or padded upload.
    await storage.put(`tmp/uploads/${uploadID}.zip`, zip);

    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${uploadID}/complete`,
      headers: authed,
    });
    expect(complete.statusCode).toBe(409);
    expect(complete.json<{ error: { code: string } }>().error.code).toBe("checksum_mismatch");
  });

  it("processes each upload once — re-running the worker is a no-op", async () => {
    const zip = makeZip(validBundle());
    const { uploadID } = await upload(zip);
    await runWorker(uploadID);
    expect((await statusOf(uploadID)).status).toBe("ready");

    // A duplicate job delivery must not re-extract or clobber the result.
    await runWorker(uploadID);
    const after = await statusOf(uploadID);
    expect(after.status).toBe("ready");
    expect(after.durationSec).toBe(12);
  });

  it("hides other operators' uploads behind 404", async () => {
    const auth = new AuthService(app.db!, app.env);
    const other = `itest-up-other-${RUN}`;
    await auth.createAccount({
      handle: other,
      email: `${other}@example.com`,
      password: "other-operator-pw",
      displayName: "Other",
      role: "operator",
    });
    const otherToken = (
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { identifier: other, password: "other-operator-pw" },
      })
    ).json<{ accessToken: string }>().accessToken;

    const { uploadID } = await upload(makeZip(validBundle()));
    const peek = await app.inject({
      method: "GET",
      url: `/api/v1/uploads/${uploadID}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(peek.statusCode).toBe(404);
  });

  it("requires the operator role for every upload endpoint", async () => {
    for (const [method, url] of [
      ["POST", "/api/v1/uploads"],
      ["POST", "/api/v1/uploads/01890a5d-ac96-774b-b111-000000000801/complete"],
      ["GET", "/api/v1/uploads/01890a5d-ac96-774b-b111-000000000801"],
      ["POST", "/api/v1/uploads/images"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  /** Builds a multipart body for inject() — FormData isn't directly injectable. */
  async function multipartImage(bytes: Buffer, mime: string, filename: string) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    const res = new Response(form);
    return {
      payload: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type")!,
    };
  }

  it("stores a thumbnail and reports its real dimensions", async () => {
    const { payload, contentType } = await multipartImage(PNG_1x1, "image/png", "thumb.png");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/images",
      headers: { ...authed, "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ imageID: string; url: string; width: number; height: number }>();
    expect(body.width).toBe(1);
    expect(body.height).toBe(1);
    expect(body.url).toContain(`media/images/${body.imageID}.png`);
    expect(await storage.head(`media/images/${body.imageID}.png`)).not.toBeNull();
  });

  it("rejects a non-image masquerading as a PNG", async () => {
    const { payload, contentType } = await multipartImage(
      Buffer.from("not an image at all"),
      "image/png",
      "fake.png",
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/images",
      headers: { ...authed, "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it("attaches a ready upload to an episode as a camera angle", async () => {
    const zip = makeZip(validBundle());
    const { uploadID } = await upload(zip);
    await runWorker(uploadID);

    const [genre] = await app.pgSql!`
      INSERT INTO genres (id, name, description)
      VALUES (gen_random_uuid(), ${"itest-up:G" + RUN}, 'g') RETURNING id`;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/programs",
      headers: authed,
      payload: {
        title: `itest-up:Program ${RUN}`,
        description: "d",
        genreIDs: [genre!.id],
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
                streams: [{ name: "Main", uploadID }],
              },
            ],
          },
        ],
      },
    });
    expect(created.statusCode).toBe(200);
    // The episode's duration comes from what the worker computed.
    expect(
      created.json<{ season: { episodes: { durationSec: number }[] }[] }>().season[0]!.episodes[0]!
        .durationSec,
    ).toBe(12);

    // Clean up catalog rows created here.
    const programId = created.json<{ id: string }>().id;
    await app.pgSql!`DELETE FROM episode_streams WHERE upload_id = ${uploadID}`;
    await app.pgSql!`DELETE FROM episodes e USING seasons s WHERE e.season_id = s.id AND s.program_id = ${programId}`;
    await app.pgSql!`DELETE FROM seasons WHERE program_id = ${programId}`;
    await app.pgSql!`DELETE FROM program_genres WHERE program_id = ${programId}`;
    await app.pgSql!`DELETE FROM programs WHERE id = ${programId}`;
    await app.pgSql!`DELETE FROM genres WHERE name LIKE 'itest-up:%'`;
  });
});
