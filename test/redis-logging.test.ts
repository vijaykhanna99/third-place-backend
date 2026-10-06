import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { attachRedisLogging } from "../src/db/redis.js";

/** Captures log calls by level so the outage transitions can be asserted. */
function fakeLog() {
  const calls: { level: string; msg: string | undefined }[] = [];
  const at = (level: string) => (_o: unknown, m?: string) => void calls.push({ level, msg: m });
  return { calls, warn: at("warn"), info: at("info"), debug: at("debug") };
}

describe("attachRedisLogging", () => {
  it("logs the first error at warn, repeats at debug, and recovery at info", () => {
    const redis = new EventEmitter();
    const log = fakeLog();
    attachRedisLogging(redis as unknown as Redis, log, "extraction-queue");

    redis.emit("error", new Error("ECONNREFUSED"));
    redis.emit("error", new Error("ECONNREFUSED"));
    redis.emit("error", new Error("ECONNREFUSED"));
    redis.emit("ready");

    expect(log.calls.map((c) => c.level)).toEqual(["warn", "debug", "debug", "info"]);
    expect(log.calls[0]!.msg).toBe("extraction-queue redis connection down");
    expect(log.calls[3]!.msg).toBe("extraction-queue redis connection recovered");
  });

  it("stays quiet on a ready event when nothing was down", () => {
    const redis = new EventEmitter();
    const log = fakeLog();
    attachRedisLogging(redis as unknown as Redis, log, "api");
    redis.emit("ready");
    expect(log.calls).toEqual([]);
  });

  it("warns again for a new outage after recovery", () => {
    const redis = new EventEmitter();
    const log = fakeLog();
    attachRedisLogging(redis as unknown as Redis, log, "api");
    redis.emit("error", new Error("down"));
    redis.emit("ready");
    redis.emit("error", new Error("down again"));
    expect(log.calls.map((c) => c.level)).toEqual(["warn", "info", "warn"]);
  });
});
