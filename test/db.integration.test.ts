import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as rawSql } from "drizzle-orm";
import { createDb, type DbBundle } from "../src/db/client.js";
import { accounts, genres, programs, seasons } from "../src/db/schema/index.js";
import { playbackEvents } from "../src/db/schema/metrics.js";
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";

/**
 * Integration tests — require real Postgres (+ Redis for the healthz case).
 * Run with:  TEST_DATABASE_URL=postgres://tplace:tplace@localhost:5432/tplace \
 *            TEST_REDIS_URL=redis://localhost:6379 pnpm test
 * Skipped automatically when TEST_DATABASE_URL is not set (unit runs stay hermetic).
 * Assumes migrations have been applied (`pnpm db:migrate`).
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const REDIS_URL = process.env.TEST_REDIS_URL;

describe.runIf(Boolean(DB_URL))("database integration", () => {
  let bundle: DbBundle;

  async function cleanup(sql: DbBundle["sql"]) {
    await sql`DELETE FROM playback_events WHERE quality = 'itest'`;
    await sql`DELETE FROM programs WHERE title LIKE 'itest:%'`;
    await sql`DELETE FROM genres WHERE name LIKE 'itest:%'`;
    await sql`DELETE FROM accounts WHERE handle LIKE 'itest-db-%'`;
  }

  beforeAll(async () => {
    bundle = createDb(DB_URL!);
    // Start from a known-clean state even if a previous run crashed before afterAll.
    await cleanup(bundle.sql);
  });

  afterAll(async () => {
    // Test rows are namespaced by handle/name prefix; clean them up.
    await cleanup(bundle.sql);
    await bundle.sql.end({ timeout: 5 });
  });

  it("inserts an account with app-generated UUIDv7", async () => {
    const [row] = await bundle.db
      .insert(accounts)
      .values({
        did: `did:tplace:itest-db-${Date.now()}`,
        handle: `itest-db-${Date.now()}`,
        email: `itest-db-${Date.now()}@example.com`,
        displayName: "Integration Test",
        passwordHash: "x",
        role: "operator",
      })
      .returning();
    expect(row).toBeDefined();
    // UUIDv7: version nibble is 7.
    expect(row!.id[14]).toBe("7");
    expect(row!.role).toBe("operator");
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it("enforces unique (program_id, number) on seasons", async () => {
    const [acct] = await bundle.db
      .insert(accounts)
      .values({
        did: `did:tplace:itest-db-${Date.now()}`,
        handle: `itest-db-uq-${Date.now()}`,
        email: `itest-db-uq-${Date.now()}@example.com`,
        displayName: "x",
        passwordHash: "x",
      })
      .returning();
    const [prog] = await bundle.db
      .insert(programs)
      .values({
        ownerAccountId: acct!.id,
        title: "itest: unique check",
        description: "d",
        thumbnailUrl: "https://example.com/t.jpg",
      })
      .returning();
    await bundle.db.insert(seasons).values({ programId: prog!.id, number: 1, title: "s1" });
    // Drizzle wraps DB errors; the Postgres unique_violation (23505) sits in .cause.
    const err: unknown = await bundle.db
      .insert(seasons)
      .values({ programId: prog!.id, number: 1, title: "dup" })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const cause = (err as Error & { cause?: { code?: string; constraint_name?: string } }).cause;
    expect(cause?.code).toBe("23505");
    expect(cause?.constraint_name).toBe("seasons_program_number_uq");
  });

  it("populates the generated search column and answers trigram queries", async () => {
    const [acct] = await bundle.db
      .insert(accounts)
      .values({
        did: `did:tplace:itest-db-s-${Date.now()}`,
        handle: `itest-db-search-${Date.now()}`,
        email: `itest-db-search-${Date.now()}@example.com`,
        displayName: "x",
        passwordHash: "x",
      })
      .returning();
    await bundle.db.insert(programs).values({
      ownerAccountId: acct!.id,
      title: "itest: Neon Nights Immersive",
      description: "8K stereoscopic concert series",
      thumbnailUrl: "https://example.com/t.jpg",
    });

    const fts = await bundle.sql`
      SELECT title FROM programs
      WHERE search @@ plainto_tsquery('simple', 'neon nights') AND title LIKE 'itest:%'`;
    expect(fts.length).toBe(1);

    const trgm = await bundle.sql`
      SELECT title FROM programs
      WHERE title ILIKE '%eon Nigh%' AND title LIKE 'itest:%'`;
    expect(trgm.length).toBe(1);
  });

  it("routes playback events into monthly partitions, overflow into default", async () => {
    // Fixed timestamps, not now(): migration 0001 only pre-creates partitions
    // through 2026-12, so a now()-based assertion would rot after that.
    await bundle.db.insert(playbackEvents).values({
      episodeId: "01890a5d-ac96-774b-b111-000000000301",
      event: "start",
      positionSec: 0,
      quality: "itest",
      sessionUuid: "7d444840-9dc0-11d1-b245-5ffdce74fad2",
      createdAt: new Date("2026-08-15T00:00:00Z"),
    });
    const [inMonth] = await bundle.sql`
      SELECT tableoid::regclass::text AS part FROM playback_events
      WHERE quality = 'itest' AND created_at = '2026-08-15T00:00:00Z'`;
    expect(inMonth!.part).toBe("playback_events_2026_08");

    // A month with no range partition must land in DEFAULT (never an insert error).
    await bundle.db.insert(playbackEvents).values({
      episodeId: "01890a5d-ac96-774b-b111-000000000301",
      event: "start",
      positionSec: 0,
      quality: "itest",
      sessionUuid: "7d444840-9dc0-11d1-b245-5ffdce74fad2",
      createdAt: new Date("2031-01-15T00:00:00Z"),
    });
    const [inDefault] = await bundle.sql`
      SELECT tableoid::regclass::text AS part FROM playback_events
      WHERE quality = 'itest' AND created_at = '2031-01-15T00:00:00Z'`;
    expect(inDefault!.part).toBe("playback_events_default");
  });

  it("healthz reports ok for db and redis with real clients", async () => {
    const app = buildApp(
      loadEnvFrom({
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        DATABASE_URL: DB_URL!,
        ...(REDIS_URL ? { REDIS_URL } : {}),
      }),
    );
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; checks: { db: string; redis: string } }>();
    expect(body.checks.db).toBe("ok");
    if (REDIS_URL) expect(body.checks.redis).toBe("ok");
    expect(body.status).toBe("ok");
    await app.close();
  });

  it("raw drizzle relational query works against the schema", async () => {
    const rows = await bundle.db
      .select({ n: rawSql<number>`count(*)` })
      .from(genres);
    expect(rows.length).toBe(1);
  });
});
