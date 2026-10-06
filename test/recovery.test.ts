import { describe, expect, it } from "vitest";
import { DEFAULT_STUCK_AFTER_MS, MAX_RECOVERIES, isStuck } from "../src/jobs/recovery.js";

describe("isStuck", () => {
  const now = new Date("2026-10-06T12:00:00Z");

  it("treats a claim older than the threshold as stuck", () => {
    const old = new Date(now.getTime() - DEFAULT_STUCK_AFTER_MS - 1);
    expect(isStuck(old, DEFAULT_STUCK_AFTER_MS, now)).toBe(true);
  });

  it("leaves a claim within the threshold alone", () => {
    const recent = new Date(now.getTime() - DEFAULT_STUCK_AFTER_MS + 1000);
    expect(isStuck(recent, DEFAULT_STUCK_AFTER_MS, now)).toBe(false);
    expect(isStuck(now, DEFAULT_STUCK_AFTER_MS, now)).toBe(false);
  });

  it("treats a processing row without a claim timestamp as stuck", () => {
    // Rows claimed before the column existed carry no timestamp.
    expect(isStuck(null, DEFAULT_STUCK_AFTER_MS, now)).toBe(true);
  });

  it("honours a custom threshold", () => {
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
    expect(isStuck(fiveMinAgo, 60 * 1000, now)).toBe(true);
    expect(isStuck(fiveMinAgo, 10 * 60 * 1000, now)).toBe(false);
  });

  it("caps recoveries so a crash loop terminates", () => {
    expect(MAX_RECOVERIES).toBeGreaterThan(0);
  });
});
