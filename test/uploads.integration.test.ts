import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/modules/auth/service.js";
import { UploadService } from "../src/modules/uploads/service.js";
import { AppError } from "../src/lib/errors.js";
import { Storage, storageConfigFromEnv, type StorageConfig } from "../src/lib/storage.js";
import { processUpload, type ProcessContext } from "../src/jobs/extraction.js";
import { MAX_RECOVERIES, recoverStuckUploads } from "../src/jobs/recovery.js";
import { SYMLINK_ATTRS, makeZip, type ZipInput } from "./helpers/zip-builder.js";

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

/**
 * Storage whose first `failures` downloads throw — a stand-in for a storage
 * outage, which must be retried rather than failing the upload.
 */
class FlakyStorage extends Storage {
  constructor(
    config: StorageConfig,
    private failures: number,
    private readonly gate: Promise<void> = Promise.resolve(),
  ) {
    super(config);
  }
  override async getStream(key: string) {
    await this.gate;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("simulated storage outage");
    }
    return super.getStream(key);
  }
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

  const runWorker = (uploadId: string, ctx: ProcessContext = {}, store: Storage = storage) =>
    processUpload({ db: app.db!, storage: store }, uploadId, ctx);

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

  it("reverts to uploading when the queue is down, so complete can be retried", async () => {
    const zip = makeZip(validBundle());
    const init = await app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: authed,
      payload: {
        fileName: "bundle.zip",
        byteSize: zip.length,
        checksum: createHash("sha256").update(zip).digest("hex"),
      },
    });
    const { uploadID, uploadURL } = init.json<{ uploadID: string; uploadURL: string }>();
    await fetch(uploadURL, { method: "PUT", body: new Uint8Array(zip) });
    const [acct] = await app.pgSql!`SELECT id FROM accounts WHERE handle = ${OP}`;

    // Same service wiring as the app, but the queue rejects every add.
    const warned: unknown[] = [];
    const service = new UploadService(
      app.db!,
      storage,
      () => Promise.reject(new Error("redis connection lost")),
      app.env.MEDIA_BASE_URL!,
      { warn: (o) => void warned.push(o) },
    );
    const err: unknown = await service
      .complete(acct!.id as string, uploadID)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(503);
    expect((err as AppError).code).toBe("service_unavailable");
    expect(warned).toHaveLength(1);

    // Not stuck in `queued` with no job behind it: the operator can retry.
    expect((await statusOf(uploadID)).status).toBe("uploading");
    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${uploadID}/complete`,
      headers: authed,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ status: string }>().status).toBe("queued");
  });

  it("answers 503 from complete when storage is unreachable, not 'object missing'", async () => {
    const zip = makeZip(validBundle());
    const init = await app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: authed,
      payload: {
        fileName: "bundle.zip",
        byteSize: zip.length,
        checksum: createHash("sha256").update(zip).digest("hex"),
      },
    });
    const { uploadID } = init.json<{ uploadID: string }>();
    const [acct] = await app.pgSql!`SELECT id FROM accounts WHERE handle = ${OP}`;

    // Nothing listens on port 9: every storage call fails without a 404.
    const dead = new Storage({ ...storageConfigFromEnv(app.env)!, endpoint: "http://127.0.0.1:9" });
    const service = new UploadService(app.db!, dead, () => Promise.resolve(), "", {
      warn: () => undefined,
    });
    const err: unknown = await service
      .complete(acct!.id as string, uploadID)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(503);
    expect((err as AppError).code).toBe("service_unavailable");
    // The row is untouched: once storage is back, complete works normally.
    expect((await statusOf(uploadID)).status).toBe("uploading");
  }, 60_000);

  it("reports a zero-length first variant as 0, not the subtitle track's duration", async () => {
    const tiny = "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:0.3,\nsegment-00001.ts\n#EXT-X-ENDLIST\n";
    const zip = makeZip(
      validBundle()
        .filter((f) => f.path !== "uhd8k/segment-00002.ts")
        .map((f) => (f.path === "uhd8k/playlist.m3u8" ? { ...f, content: tiny } : f)),
    );
    const { uploadID } = await upload(zip);
    await runWorker(uploadID);
    const status = await statusOf(uploadID);
    expect(status.status).toBe("ready");
    expect(status.durationSec).toBe(0);
  });

  describe("rendition agreement", () => {
    const twoVariants = (secondMedia: string): ZipInput[] => [
      {
        path: "index.m3u8",
        content: `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=48000000,RESOLUTION=7680x4320
uhd8k/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160
uhd4k/playlist.m3u8
`,
      },
      { path: "uhd8k/playlist.m3u8", content: MEDIA },
      { path: "uhd8k/segment-00001.ts", content: "a" },
      { path: "uhd8k/segment-00002.ts", content: "b" },
      { path: "uhd4k/playlist.m3u8", content: secondMedia },
      { path: "uhd4k/segment-00001.ts", content: "c" },
    ];

    it("rejects renditions whose durations disagree beyond the tolerance", async () => {
      const truncated = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment-00001.ts\n#EXT-X-ENDLIST\n";
      const { uploadID } = await upload(makeZip(twoVariants(truncated)));
      await runWorker(uploadID);
      const status = await statusOf(uploadID);
      expect(status.status).toBe("failed");
      expect(status.error).toContain("rendition_duration_mismatch");
      expect(await storage.listPrefix(`media/uploads/${uploadID}`)).toHaveLength(0);
    });

    it("tolerates small encoder drift between renditions", async () => {
      const drifted = "#EXTM3U\n#EXT-X-TARGETDURATION:14\n#EXTINF:13.5,\nsegment-00001.ts\n#EXT-X-ENDLIST\n";
      const { uploadID } = await upload(makeZip(twoVariants(drifted)));
      await runWorker(uploadID);
      const status = await statusOf(uploadID);
      expect(status.status).toBe("ready");
      // The first variant is authoritative for the reported duration.
      expect(status.durationSec).toBe(12);
    });
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

  it("leaves a transiently failed upload retryable, then succeeds on the retry", async () => {
    const { uploadID } = await upload(makeZip(validBundle()));
    const flaky = new FlakyStorage(storageConfigFromEnv(app.env)!, 1);

    // Attempt 1 of 3 hits an outage: the error propagates (so the queue
    // counts the attempt) and the row goes back to `queued`, not `failed`.
    await expect(runWorker(uploadID, { attempt: 1, maxAttempts: 3 }, flaky)).rejects.toThrow(
      /simulated storage outage/,
    );
    expect((await statusOf(uploadID)).status).toBe("queued");

    // Attempt 2 claims the row again and completes normally.
    await runWorker(uploadID, { attempt: 2, maxAttempts: 3 }, flaky);
    const status = await statusOf(uploadID);
    expect(status.status).toBe("ready");
    expect(status.durationSec).toBe(12);
  });

  it("records the failure only on the final attempt", async () => {
    const { uploadID } = await upload(makeZip(validBundle()));
    const flaky = new FlakyStorage(storageConfigFromEnv(app.env)!, 99);

    await expect(runWorker(uploadID, { attempt: 3, maxAttempts: 3 }, flaky)).rejects.toThrow();
    const status = await statusOf(uploadID);
    expect(status.status).toBe("failed");
    expect(status.error).toContain("extraction_error");
    expect(status.error).toContain("simulated storage outage");
  });

  it("lets exactly one of two concurrent workers claim an upload", async () => {
    const { uploadID } = await upload(makeZip(validBundle()));
    await Promise.all([runWorker(uploadID), runWorker(uploadID)]);

    const status = await statusOf(uploadID);
    expect(status.status).toBe("ready");
    expect(status.durationSec).toBe(12);
    // One extraction, one set of objects — nothing written twice or rolled back.
    expect(await storage.listPrefix(`media/uploads/${uploadID}`)).toHaveLength(6);
  });

  it("never downgrades a row that became ready while a stale worker was still running", async () => {
    const { uploadID } = await upload(makeZip(validBundle()));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    // This worker claims the row, then stalls on the download and finally fails.
    const stale = new FlakyStorage(storageConfigFromEnv(app.env)!, 99, gate);
    const run = runWorker(uploadID, { attempt: 1, maxAttempts: 1 }, stale);

    // Meanwhile the upload is recovered and published by someone else.
    await new Promise((r) => setTimeout(r, 200));
    expect((await statusOf(uploadID)).status).toBe("processing");
    const marker = `media/uploads/${uploadID}/index.m3u8`;
    await storage.put(marker, Buffer.from(MASTER));
    await app.pgSql!`UPDATE uploads SET status = 'ready', playlist_key = ${marker}, duration_sec = 12 WHERE id = ${uploadID}`;

    open();
    await expect(run).rejects.toThrow(/simulated storage outage/);

    // The stale worker's failure must not touch the published row or its objects.
    const status = await statusOf(uploadID);
    expect(status.status).toBe("ready");
    expect(status.durationSec).toBe(12);
    expect(await storage.head(marker)).not.toBeNull();
  });

  /** Simulates a worker that died mid-extraction `ageMs` ago. */
  async function strand(uploadID: string, ageMs: number, recoveryCount = 0) {
    const startedAt = new Date(Date.now() - ageMs).toISOString();
    await app.pgSql!`
      UPDATE uploads SET status = 'processing', processing_started_at = ${startedAt}::timestamptz,
        recovery_count = ${recoveryCount} WHERE id = ${uploadID}`;
    // A half-published object the dead worker left behind.
    await storage.put(`media/uploads/${uploadID}/uhd8k/stale.ts`, Buffer.from("stale"));
  }

  it("reclaims an upload stuck in processing, cleaning its prefix first", async () => {
    const { uploadID } = await upload(makeZip(validBundle()));
    await strand(uploadID, 60 * 60 * 1000);

    await runWorker(uploadID);

    const status = await statusOf(uploadID);
    expect(status.status).toBe("ready");
    expect(status.durationSec).toBe(12);
    const keys = await storage.listPrefix(`media/uploads/${uploadID}`);
    expect(keys).toHaveLength(6);
    expect(keys).not.toContain(`media/uploads/${uploadID}/uhd8k/stale.ts`);
    const [row] = await app.pgSql!`SELECT recovery_count FROM uploads WHERE id = ${uploadID}`;
    expect(row!.recovery_count).toBe(1);
  });

  it("leaves a processing row within the threshold to its worker", async () => {
    const { uploadID } = await upload(makeZip(validBundle()));
    await strand(uploadID, 1000);

    await runWorker(uploadID);

    expect((await statusOf(uploadID)).status).toBe("processing");
    // Nothing of the other worker's output was touched.
    expect(await storage.head(`media/uploads/${uploadID}/uhd8k/stale.ts`)).not.toBeNull();
  });

  it("fails a stuck upload once it has been recovered too often", async () => {
    const { uploadID } = await upload(makeZip(validBundle()));
    await strand(uploadID, 60 * 60 * 1000, MAX_RECOVERIES);

    await runWorker(uploadID);

    const status = await statusOf(uploadID);
    expect(status.status).toBe("failed");
    expect(status.error).toContain("stuck_processing");
    expect(await storage.listPrefix(`media/uploads/${uploadID}`)).toHaveLength(0);
  });

  it("sweeps stuck rows at startup: requeues the recoverable, fails the rest", async () => {
    const a = (await upload(makeZip(validBundle()))).uploadID;
    const b = (await upload(makeZip(validBundle()))).uploadID;
    const fresh = (await upload(makeZip(validBundle()))).uploadID;
    await strand(a, 60 * 60 * 1000);
    await strand(b, 60 * 60 * 1000, MAX_RECOVERIES);
    await strand(fresh, 1000);

    const enqueued: string[] = [];
    const result = await recoverStuckUploads(
      { db: app.db!, storage },
      {
        enqueue: (id) => {
          enqueued.push(id);
          return Promise.resolve();
        },
      },
    );

    expect(result.requeued).toContain(a);
    expect(result.failed).toContain(b);
    expect(result.requeued).not.toContain(fresh);
    expect(result.failed).not.toContain(fresh);
    expect(enqueued).toEqual(result.requeued);

    expect((await statusOf(a)).status).toBe("queued");
    expect((await statusOf(b)).status).toBe("failed");
    expect((await statusOf(fresh)).status).toBe("processing");
    // Prefixes of swept rows are cleaned; the fresh one is untouched.
    expect(await storage.listPrefix(`media/uploads/${a}`)).toHaveLength(0);
    expect(await storage.listPrefix(`media/uploads/${b}`)).toHaveLength(0);
    expect(await storage.listPrefix(`media/uploads/${fresh}`)).toHaveLength(1);

    // The requeued upload then processes normally.
    await runWorker(a);
    expect((await statusOf(a)).status).toBe("ready");
  });

  it("uses the configured scratch root and leaves it clean afterwards", async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "itest-scratch-"));
    try {
      const { uploadID } = await upload(makeZip(validBundle()));
      await processUpload({ db: app.db!, storage, scratchDir }, uploadID);
      expect((await statusOf(uploadID)).status).toBe("ready");
      expect(await readdir(scratchDir)).toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it("fails clearly, and retryably, when the scratch root is unusable", async () => {
    const { uploadID } = await upload(makeZip(validBundle()));
    const scratchDir = join(tmpdir(), `itest-missing-${String(RUN)}`);

    await expect(
      processUpload({ db: app.db!, storage, scratchDir }, uploadID, { attempt: 1, maxAttempts: 3 }),
    ).rejects.toThrow();
    // An infrastructure problem, so the row is handed back for a retry...
    expect((await statusOf(uploadID)).status).toBe("queued");

    // ...and on the last attempt the operator sees what went wrong.
    await expect(
      processUpload({ db: app.db!, storage, scratchDir }, uploadID, { attempt: 3, maxAttempts: 3 }),
    ).rejects.toThrow();
    const status = await statusOf(uploadID);
    expect(status.status).toBe("failed");
    expect(status.error).toMatch(/extraction_error: .*itest-missing/);
  });

  describe("hostile archives", () => {
    const failedWith = async (zip: Buffer, code: string, ctxLimits?: Record<string, number>) => {
      const { uploadID } = await upload(zip);
      await processUpload(
        { db: app.db!, storage, ...(ctxLimits ? { limits: ctxLimits } : {}) },
        uploadID,
      );
      const status = await statusOf(uploadID);
      expect(status.status, status.error ?? "").toBe("failed");
      expect(status.error).toContain(code);
      // Nothing is ever left half-published.
      expect(await storage.listPrefix(`media/uploads/${uploadID}`)).toHaveLength(0);
      return status;
    };

    it("rejects an entry whose header understates its real size (lying header)", async () => {
      const bundle = validBundle().map((f) =>
        f.path === "uhd8k/segment-00001.ts"
          ? { ...f, content: Buffer.alloc(64 * 1024, 0x41), declaredSize: 100 }
          : f,
      );
      await failedWith(makeZip(bundle), "entry_size_mismatch");
    });

    it("rejects an entry whose header overstates its real size", async () => {
      const bundle = validBundle().map((f) =>
        f.path === "uhd8k/segment-00001.ts" ? { ...f, declaredSize: 99_999 } : f,
      );
      await failedWith(makeZip(bundle), "entry_size_mismatch");
    });

    it("rejects a lying header on a playlist entry too", async () => {
      const bundle = validBundle().map((f) =>
        f.path === "uhd8k/playlist.m3u8" ? { ...f, declaredSize: 10 } : f,
      );
      await failedWith(makeZip(bundle), "entry_size_mismatch");
    });

    it("accepts stored (uncompressed) entries", async () => {
      const zip = makeZip(validBundle().map((f) => ({ ...f, store: true })));
      const { uploadID } = await upload(zip);
      await runWorker(uploadID);
      expect((await statusOf(uploadID)).status).toBe("ready");
      expect(await storage.listPrefix(`media/uploads/${uploadID}`)).toHaveLength(6);
    });

    it("rejects a stored entry whose sizes disagree", async () => {
      const bundle = validBundle().map((f) =>
        f.path === "uhd8k/segment-00002.ts" ? { ...f, store: true, declaredSize: 5 } : f,
      );
      await failedWith(makeZip(bundle), "entry_size_mismatch");
    });

    it("rejects symlink entries", async () => {
      const zip = makeZip([
        ...validBundle(),
        { path: "uhd8k/link.ts", content: "../../etc/passwd", externalFileAttributes: SYMLINK_ATTRS },
      ]);
      await failedWith(zip, "symlink");
    });

    it("rejects duplicate entry names instead of collapsing them", async () => {
      const literal = makeZip([...validBundle(), { path: "index.m3u8", content: MASTER }]);
      await failedWith(literal, "duplicate_entry");
      // Two spellings of one path count as a duplicate as well.
      const normalized = makeZip([
        ...validBundle(),
        { path: "./uhd8k//segment-00001.ts", content: "other bytes" },
      ]);
      await failedWith(normalized, "duplicate_entry");
    });

    it("enforces the per-entry size cap on inflated bytes", async () => {
      const bundle = validBundle().map((f) =>
        f.path === "uhd8k/segment-00002.ts" ? { ...f, content: Buffer.alloc(4096, 0x42) } : f,
      );
      await failedWith(makeZip(bundle), "too_large", { maxEntryBytes: 1024 });
    });

    it("stops reading the central directory once the file count exceeds the cap", async () => {
      await failedWith(makeZip(validBundle()), "too_many_files", { maxFiles: 3 });
    });

    it("streams a large entry to storage in multipart parts without buffering it", async () => {
      const big = 20 * 1024 * 1024; // > 2 multipart parts at the 8 MiB part size
      const bundle = validBundle().map((f) =>
        f.path === "uhd8k/segment-00001.ts" ? { ...f, content: Buffer.alloc(big, 0x7a) } : f,
      );
      const { uploadID } = await upload(makeZip(bundle));
      await runWorker(uploadID);
      expect((await statusOf(uploadID)).status).toBe("ready");
      const head = await storage.head(`media/uploads/${uploadID}/uhd8k/segment-00001.ts`);
      expect(head?.size).toBe(big);
    });

    it("rejects something that is not a ZIP archive at all", async () => {
      await failedWith(Buffer.from("definitely not a zip file, just bytes"), "invalid_archive");
    });
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
