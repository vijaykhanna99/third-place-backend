import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as raw } from "drizzle-orm";
import { createDb, type DbBundle } from "../src/db/client.js";
import { JANITOR_DEFAULTS, monthPartition, runJanitor, type JanitorReport } from "../src/jobs/janitor.js";
import { SCRATCH_PREFIX } from "../src/jobs/lifecycle.js";
import { Storage } from "../src/lib/storage.js";

/**
 * Janitor sweep (spec §8.5) — requires Postgres and object storage:
 *   TEST_DATABASE_URL=postgres://tplace:tplace@localhost:5433/tplace \
 *   TEST_S3_ENDPOINT=http://127.0.0.1:9000 pnpm test
 *
 * Rows are seeded with back-dated timestamps and the sweep runs with the real
 * clock, so nothing another suite creates during the run (all of it fresh) is
 * ever within reach of a retention rule. Note that genuinely old rows in a
 * shared development database are treated exactly as production would.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;
const RUN = Date.now();
const DAY = 24 * 60 * 60 * 1000;

describe.runIf(Boolean(DB_URL && S3_ENDPOINT))("janitor integration", () => {
  let bundle: DbBundle;
  let storage: Storage;
  let opId: string;
  let scratch: string;
  const created: string[] = [];

  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  beforeAll(async () => {
    bundle = createDb(DB_URL!);
    storage = new Storage({
      endpoint: S3_ENDPOINT!,
      region: "auto",
      accessKeyId: "tplace",
      secretAccessKey: "tplace-secret",
      bucket: "tplace-media-dev",
    });
    scratch = await mkdtemp(join(tmpdir(), "janitor-itest-"));
    await cleanup();
    const [op] = await bundle.sql`
      INSERT INTO accounts (id, did, handle, email, display_name, password_hash, role)
      VALUES (gen_random_uuid(), ${"did:tplace:itest-jan-" + String(RUN)}, ${"itest-jan-" + String(RUN)}, ${"itest-jan-" + String(RUN) + "@example.com"}, 'Janitor', 'x', 'operator')
      RETURNING id`;
    opId = op!.id as string;
  });

  afterAll(async () => {
    await cleanup();
    await rm(scratch, { recursive: true, force: true });
    await bundle.sql.end({ timeout: 5 });
  });

  async function cleanup() {
    const sql = bundle.sql;
    const ids = (await sql`SELECT id FROM uploads WHERE r2_key LIKE 'tmp/uploads/%' AND created_by IN (SELECT id FROM accounts WHERE handle LIKE 'itest-jan-%')`) as {
      id: string;
    }[];
    for (const { id } of ids) {
      await storage.deletePrefix(`media/uploads/${id}`).catch(() => undefined);
      await storage.delete([`tmp/uploads/${id}.zip`]).catch(() => undefined);
    }
    const imgs = (await sql`SELECT r2_key FROM images WHERE created_by IN (SELECT id FROM accounts WHERE handle LIKE 'itest-jan-%')`) as {
      r2_key: string;
    }[];
    if (imgs.length > 0) await storage.delete(imgs.map((i) => i.r2_key)).catch(() => undefined);
    await sql`DELETE FROM programs WHERE title LIKE 'itest-jan:%'`;
    await sql`DELETE FROM genres WHERE name LIKE 'itest-jan:%'`;
    await sql`DELETE FROM images WHERE created_by IN (SELECT id FROM accounts WHERE handle LIKE 'itest-jan-%')`;
    await sql`DELETE FROM uploads WHERE created_by IN (SELECT id FROM accounts WHERE handle LIKE 'itest-jan-%')`;
    await sql`DELETE FROM accounts WHERE handle LIKE 'itest-jan-%'`;
    await sql`DELETE FROM playback_events WHERE quality = 'itest-jan'`;
    for (const p of created) await sql.unsafe(`DROP TABLE IF EXISTS ${p}`);
  }

  /** Seeds an upload row in `status` with back-dated timestamps and the given storage objects. */
  async function seed(
    status: string,
    at: { createdDays: number; updatedDays?: number; detachedDays?: number },
    objects: { temp?: boolean; media?: boolean } = {},
  ): Promise<string> {
    const [row] = await bundle.sql`
      INSERT INTO uploads (id, r2_key, byte_size, checksum, status, created_by, playlist_key, duration_sec,
                           created_at, updated_at, detached_at)
      VALUES (gen_random_uuid(), 'pending', 10, ${"a".repeat(64)}, ${status}::upload_status, ${opId},
              ${status === "ready" ? "pending" : null}, ${status === "ready" ? 12 : null},
              ${ago(at.createdDays)}::timestamptz, ${ago(at.updatedDays ?? at.createdDays)}::timestamptz,
              ${at.detachedDays === undefined ? null : ago(at.detachedDays)}::timestamptz)
      RETURNING id`;
    const id = row!.id as string;
    await bundle.sql`
      UPDATE uploads SET r2_key = ${`tmp/uploads/${id}.zip`},
        playlist_key = ${status === "ready" ? `media/uploads/${id}/index.m3u8` : null},
        updated_at = ${ago(at.updatedDays ?? at.createdDays)}::timestamptz
      WHERE id = ${id}`;
    if (objects.temp) await storage.put(`tmp/uploads/${id}.zip`, Buffer.from("zip"));
    if (objects.media) {
      await storage.put(`media/uploads/${id}/index.m3u8`, Buffer.from("#EXTM3U"));
      await storage.put(`media/uploads/${id}/uhd8k/segment-00001.ts`, Buffer.from("seg"));
    }
    return id;
  }

  const rowOf = async (id: string) =>
    (await bundle.sql`SELECT status, error, playlist_key, temp_deleted_at FROM uploads WHERE id = ${id}`)[0] as {
      status: string;
      error: string | null;
      playlist_key: string | null;
      temp_deleted_at: string | null;
    };

  /** Attaches an upload to a freshly created episode so it counts as in use. */
  async function attach(uploadId: string) {
    const sql = bundle.sql;
    const [g] = await sql`INSERT INTO genres (id, name) VALUES (gen_random_uuid(), ${"itest-jan:G" + String(RUN)}) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
    const [p] = await sql`INSERT INTO programs (id, owner_account_id, title, thumbnail_url) VALUES (gen_random_uuid(), ${opId}, ${"itest-jan:P " + uploadId}, 'https://example.com/t.jpg') RETURNING id`;
    await sql`INSERT INTO program_genres (program_id, genre_id) VALUES (${p!.id as string}, ${g!.id as string})`;
    const [s] = await sql`INSERT INTO seasons (id, program_id, number, title) VALUES (gen_random_uuid(), ${p!.id as string}, 1, 'S1') RETURNING id`;
    const [e] = await sql`INSERT INTO episodes (id, season_id, number, title, duration_sec, published_at) VALUES (gen_random_uuid(), ${s!.id as string}, 1, 'E1', 12, now()) RETURNING id`;
    await sql`INSERT INTO episode_streams (id, episode_id, name, upload_id) VALUES (gen_random_uuid(), ${e!.id as string}, 'Main', ${uploadId})`;
  }

  it("applies every retention rule exactly once", async () => {
    // Uploads
    const abandonedOld = await seed("uploading", { createdDays: 8 }, { temp: true });
    const abandonedFresh = await seed("uploading", { createdDays: 1 }, { temp: true });
    const failedOld = await seed("failed", { createdDays: 9, updatedDays: 8 }, { temp: true });
    const failedFresh = await seed("failed", { createdDays: 2, updatedDays: 1 }, { temp: true });
    const unattachedOld = await seed("ready", { createdDays: 16, updatedDays: 15 }, { media: true, temp: true });
    const unattachedFresh = await seed("ready", { createdDays: 2, updatedDays: 1 }, { media: true });
    const attachedOld = await seed("ready", { createdDays: 40, updatedDays: 40 }, { media: true });
    await attach(attachedOld);
    const detachedOld = await seed("ready", { createdDays: 60, updatedDays: 60, detachedDays: 31 }, { media: true });
    const detachedRecent = await seed("ready", { createdDays: 60, updatedDays: 60, detachedDays: 10 }, { media: true });

    // Images
    const image = async (days: number, name: string) => {
      const key = `media/images/itest-jan-${String(RUN)}-${name}.png`;
      await storage.put(key, Buffer.from([137, 80, 78, 71]));
      const [row] = await bundle.sql`
        INSERT INTO images (id, r2_key, url, byte_size, width, height, created_by, created_at)
        VALUES (gen_random_uuid(), ${key}, ${"https://media.test.example/images/itest-jan-" + String(RUN) + "-" + name + ".png"}, 4, 1, 1, ${opId}, ${ago(days)}::timestamptz)
        RETURNING id`;
      return { id: row!.id as string, key };
    };
    const orphanOld = await image(15, "orphan-old");
    const orphanFresh = await image(1, "orphan-fresh");
    const referenced = await image(15, "referenced");
    // Referenced under a different media origin than the stored URL: still referenced.
    await bundle.sql`INSERT INTO programs (id, owner_account_id, title, thumbnail_url)
      VALUES (gen_random_uuid(), ${opId}, ${"itest-jan:Thumb " + String(RUN)}, ${"https://cdn.other.example/images/itest-jan-" + String(RUN) + "-referenced.png"})`;

    // Scratch
    const stale = join(scratch, `${SCRATCH_PREFIX}stale`);
    await mkdir(stale);
    await writeFile(join(stale, "upload.zip"), "x");
    const old = (Date.now() - DAY) / 1000;
    await utimes(join(stale, "upload.zip"), old, old);
    await utimes(stale, old, old);
    const live = join(scratch, `${SCRATCH_PREFIX}live`);
    await mkdir(live);
    await writeFile(join(live, "upload.zip"), "x");

    // Default partition alarm: a row for a month without a partition.
    await bundle.sql`INSERT INTO playback_events (id, episode_id, event, position_sec, quality, session_uuid, created_at)
      VALUES (gen_random_uuid(), '01890a5d-ac96-774b-b111-000000000301', 'start', 0, 'itest-jan', gen_random_uuid(), '2031-01-15T00:00:00Z')`;

    const ahead = 4;
    for (let i = 0; i <= ahead; i++) {
      const p = monthPartition(new Date(), i);
      const [exists] = await bundle.db.execute<{ found: boolean }>(raw`SELECT to_regclass(${p.name}) IS NOT NULL AS found`);
      if (!exists?.found) created.push(p.name);
    }

    const report: JanitorReport = await runJanitor(
      { db: bundle.db, storage, scratchDir: scratch },
      { partitionMonthsAhead: ahead },
    );
    expect(report.errors).toEqual([]);

    // Abandoned handshakes
    expect(report.abandonedUploads).toEqual([abandonedOld]);
    expect(await rowOf(abandonedOld)).toMatchObject({ status: "failed", error: expect.stringContaining("abandoned") as string });
    expect(await storage.head(`tmp/uploads/${abandonedOld}.zip`)).toBeNull();
    expect((await rowOf(abandonedFresh)).status).toBe("uploading");
    expect(await storage.head(`tmp/uploads/${abandonedFresh}.zip`)).not.toBeNull();

    // Temp archives of failed uploads
    expect(report.tempArchivesDeleted).toEqual([failedOld]);
    expect(await storage.head(`tmp/uploads/${failedOld}.zip`)).toBeNull();
    expect((await rowOf(failedOld)).temp_deleted_at).not.toBeNull();
    expect(await storage.head(`tmp/uploads/${failedFresh}.zip`)).not.toBeNull();

    // Unused ready uploads
    expect(report.reclaimedUploads.sort()).toEqual([unattachedOld, detachedOld].sort());
    for (const id of [unattachedOld, detachedOld]) {
      const row = await rowOf(id);
      expect(row.status).toBe("failed");
      expect(row.error).toContain("reclaimed");
      expect(row.playlist_key).toBeNull();
      expect(await storage.listPrefix(`media/uploads/${id}`)).toHaveLength(0);
    }
    expect((await rowOf(unattachedOld)).error).toContain("not attached");
    expect((await rowOf(detachedOld)).error).toContain("detached");
    expect(await storage.head(`tmp/uploads/${unattachedOld}.zip`)).toBeNull();
    for (const id of [unattachedFresh, attachedOld, detachedRecent]) {
      expect((await rowOf(id)).status, id).toBe("ready");
      expect(await storage.listPrefix(`media/uploads/${id}`), id).toHaveLength(2);
    }

    // Orphan thumbnails
    expect(report.orphanImagesDeleted).toEqual([orphanOld.id]);
    expect(await storage.head(orphanOld.key)).toBeNull();
    expect(await storage.head(orphanFresh.key)).not.toBeNull();
    expect(await storage.head(referenced.key)).not.toBeNull();
    const remaining = await bundle.sql`SELECT id FROM images WHERE created_by = ${opId}`;
    expect(remaining.map((r) => r.id as string).sort()).toEqual([orphanFresh.id, referenced.id].sort());

    // Scratch
    expect(report.scratchRemoved).toEqual([stale]);
    expect(await readdir(scratch)).toEqual([`${SCRATCH_PREFIX}live`]);

    // Partitions: the months ahead now exist; the default partition is flagged.
    expect(report.partitionsCreated.sort()).toEqual([...created].sort());
    for (let i = 0; i <= ahead; i++) {
      const p = monthPartition(new Date(), i);
      const [exists] = await bundle.db.execute<{ found: boolean }>(raw`SELECT to_regclass(${p.name}) IS NOT NULL AS found`);
      expect(exists?.found, p.name).toBe(true);
    }
    expect(report.defaultPartitionRows).toBeGreaterThanOrEqual(1);

    // A second sweep finds nothing new to do.
    const again = await runJanitor({ db: bundle.db, storage, scratchDir: scratch }, { partitionMonthsAhead: ahead });
    expect(again.errors).toEqual([]);
    expect(again.abandonedUploads).toEqual([]);
    expect(again.tempArchivesDeleted).toEqual([]);
    expect(again.reclaimedUploads).toEqual([]);
    expect(again.orphanImagesDeleted).toEqual([]);
    expect(again.scratchRemoved).toEqual([]);
    expect(again.partitionsCreated).toEqual([]);
  }, 60_000);

  it("keeps the documented defaults", () => {
    expect(JANITOR_DEFAULTS.tempRetentionMs).toBe(7 * DAY);
    expect(JANITOR_DEFAULTS.unattachedRetentionMs).toBe(14 * DAY);
    expect(JANITOR_DEFAULTS.detachedRetentionMs).toBe(30 * DAY);
    expect(JANITOR_DEFAULTS.imageRetentionMs).toBe(14 * DAY);
  });
});
