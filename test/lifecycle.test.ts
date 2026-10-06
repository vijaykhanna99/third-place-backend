import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SCRATCH_HEADROOM_BYTES,
  SCRATCH_PREFIX,
  createShutdown,
  ensureScratchSpace,
  freeScratchBytes,
  scratchRoot,
  sweepScratch,
} from "../src/jobs/lifecycle.js";

describe("scratchRoot", () => {
  it("falls back to the OS temp dir when unset or empty", () => {
    expect(scratchRoot(undefined)).toBe(tmpdir());
    expect(scratchRoot("")).toBe(tmpdir());
    expect(scratchRoot("/var/scratch")).toBe("/var/scratch");
  });
});

describe("sweepScratch", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "lifecycle-test-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes only our own scratch directories, leaving everything else", async () => {
    await mkdir(join(root, `${SCRATCH_PREFIX}abc-x1`));
    await writeFile(join(root, `${SCRATCH_PREFIX}abc-x1`, "upload.zip"), "bytes");
    await mkdir(join(root, `${SCRATCH_PREFIX}def-x2`));
    await mkdir(join(root, "someone-elses-dir"));
    await writeFile(join(root, "unrelated.txt"), "keep");

    const removed = await sweepScratch(root);
    expect(removed).toHaveLength(2);
    expect((await readdir(root)).sort()).toEqual(["someone-elses-dir", "unrelated.txt"]);
  });

  it("is a no-op on a missing root rather than crashing startup", async () => {
    const warned: unknown[] = [];
    const removed = await sweepScratch(join(root, "does-not-exist"), {
      info: () => undefined,
      warn: (o) => void warned.push(o),
    });
    expect(removed).toEqual([]);
    expect(warned).toHaveLength(1);
  });
});

describe("ensureScratchSpace", () => {
  it("passes when the archive plus headroom fits", async () => {
    await expect(ensureScratchSpace(tmpdir(), 1)).resolves.toBeUndefined();
  });

  it("fails with a clear message when it does not", async () => {
    const free = await freeScratchBytes(tmpdir());
    await expect(ensureScratchSpace(tmpdir(), free)).rejects.toThrow(
      /insufficient scratch space .* need \d+ bytes, \d+ available/,
    );
    // Headroom is counted: exactly the free amount is not enough.
    await expect(ensureScratchSpace(tmpdir(), free - SCRATCH_HEADROOM_BYTES + 1)).rejects.toThrow(
      /insufficient scratch space/,
    );
  });

  it("surfaces an unusable root as an error, not a silent pass", async () => {
    await expect(ensureScratchSpace(join(tmpdir(), "nope-" + String(Date.now())), 1)).rejects.toThrow();
  });
});

describe("createShutdown", () => {
  const log = { info: () => undefined, warn: () => undefined };

  it("closes gracefully when the worker finishes in time", async () => {
    const calls: boolean[] = [];
    let after = 0;
    const shutdown = createShutdown(
      {
        close: (force = false) => {
          calls.push(force);
          return Promise.resolve();
        },
      },
      { timeoutMs: 1000, log, after: () => void after++ as unknown as Promise<void> },
    );
    await expect(shutdown("SIGTERM")).resolves.toBe("graceful");
    expect(calls).toEqual([false]);
    expect(after).toBe(1);
  });

  it("forces the close once the graceful timeout elapses", async () => {
    const calls: boolean[] = [];
    const shutdown = createShutdown(
      {
        close: (force = false) => {
          calls.push(force);
          // Graceful close never resolves (a wedged job); forced close does.
          return force ? Promise.resolve() : new Promise<void>(() => undefined);
        },
      },
      { timeoutMs: 50, log },
    );
    await expect(shutdown("SIGTERM")).resolves.toBe("forced");
    expect(calls).toEqual([false, true]);
  });

  it("is re-entrant: a second signal joins the shutdown already in progress", async () => {
    let closes = 0;
    const shutdown = createShutdown(
      {
        close: () => {
          closes++;
          return new Promise((resolve) => setTimeout(resolve, 20));
        },
      },
      { timeoutMs: 1000, log },
    );
    const first = shutdown("SIGINT");
    const second = shutdown("SIGTERM");
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(closes).toBe(1);
  });

  it("still completes when the cleanup step throws", async () => {
    const warned: unknown[] = [];
    const shutdown = createShutdown(
      { close: () => Promise.resolve() },
      {
        timeoutMs: 1000,
        log: { info: () => undefined, warn: (o) => void warned.push(o) },
        after: () => Promise.reject(new Error("pool already closed")),
      },
    );
    await expect(shutdown("SIGTERM")).resolves.toBe("graceful");
    expect(warned).toHaveLength(1);
  });
});
