import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCRATCH_PREFIX } from "../src/jobs/lifecycle.js";
import { isReferenced, monthPartition, sweepStaleScratch } from "../src/jobs/janitor.js";

describe("monthPartition", () => {
  it("names and bounds the month containing the date", () => {
    expect(monthPartition(new Date("2026-10-06T17:00:00Z"))).toEqual({
      name: "playback_events_2026_10",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
    });
  });

  it("rolls over the year when looking ahead", () => {
    expect(monthPartition(new Date("2026-11-30T23:59:59Z"), 2)).toEqual({
      name: "playback_events_2027_01",
      from: "2027-01-01T00:00:00.000Z",
      to: "2027-02-01T00:00:00.000Z",
    });
    expect(monthPartition(new Date("2026-12-31T00:00:00Z"), 1).name).toBe("playback_events_2027_01");
  });
});

describe("isReferenced", () => {
  const key = "media/images/0189-abc.png";
  it("matches on the public path, whatever origin the URL was issued under", () => {
    expect(isReferenced(key, ["https://media.old.example/images/0189-abc.png"])).toBe(true);
    expect(isReferenced(key, ["http://127.0.0.1:9000/tplace-media-dev/media/images/0189-abc.png"])).toBe(true);
  });
  it("does not match other images or prefixes of the name", () => {
    expect(isReferenced(key, ["https://media.example/images/0189-abcd.png"])).toBe(false);
    expect(isReferenced(key, ["https://media.example/images/other.png", "https://x/thumbs/0189-abc.png"])).toBe(false);
    expect(isReferenced(key, [])).toBe(false);
  });
});

describe("sweepStaleScratch", () => {
  it("removes only our stale directories and leaves live ones alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "janitor-test-"));
    try {
      const old = join(root, `${SCRATCH_PREFIX}old-1`);
      await mkdir(old);
      await writeFile(join(old, "upload.zip"), "bytes");
      const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
      await utimes(join(old, "upload.zip"), twoDaysAgo, twoDaysAgo);
      await utimes(old, twoDaysAgo, twoDaysAgo);

      // Directory is old but its archive is still being written: in use.
      const live = join(root, `${SCRATCH_PREFIX}live-2`);
      await mkdir(live);
      await utimes(live, twoDaysAgo, twoDaysAgo);
      await writeFile(join(live, "upload.zip"), "fresh bytes");

      await mkdir(join(root, "not-ours"));
      await utimes(join(root, "not-ours"), twoDaysAgo, twoDaysAgo);

      const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const removed = await sweepStaleScratch(root, cutoff);
      expect(removed).toEqual([old]);
      expect((await readdir(root)).sort()).toEqual(["not-ours", `${SCRATCH_PREFIX}live-2`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is a no-op on a missing root", async () => {
    expect(await sweepStaleScratch(join(tmpdir(), `nope-${String(Date.now())}`), new Date())).toEqual([]);
  });
});
