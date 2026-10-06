import { describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { Storage, StorageDeleteError } from "../src/lib/storage.js";

const config = {
  endpoint: "http://127.0.0.1:9",
  region: "auto",
  accessKeyId: "k",
  secretAccessKey: "s",
  bucket: "b",
};

/** A Storage whose S3 client answers every command with `respond`. */
function stubbed(respond: (command: { constructor: { name: string }; input: unknown }) => unknown) {
  const client = { send: (cmd: { constructor: { name: string }; input: unknown }) => Promise.resolve(respond(cmd)) };
  return new Storage(config, client as unknown as S3Client);
}

describe("Storage.head", () => {
  it("returns null only for a missing object", async () => {
    const missing = stubbed(() => {
      throw Object.assign(new Error("no"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
    });
    expect(await missing.head("k")).toBeNull();
  });

  it("rethrows every other failure so callers can report storage as unavailable", async () => {
    const throttled = stubbed(() => {
      throw Object.assign(new Error("slow down"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
    });
    await expect(throttled.head("k")).rejects.toThrow(/slow down/);
    const network = stubbed(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(network.head("k")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("reports the object size", async () => {
    const found = stubbed(() => ({ ContentLength: 1234 }));
    expect(await found.head("k")).toEqual({ size: 1234 });
  });
});

describe("Storage.delete", () => {
  it("surfaces per-key failures hidden inside a 200 DeleteObjects response", async () => {
    const partial = stubbed(() => ({
      Deleted: [{ Key: "a" }],
      Errors: [{ Key: "b", Code: "AccessDenied", Message: "denied" }],
    }));
    const err: unknown = await partial.delete(["a", "b"]).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StorageDeleteError);
    expect((err as StorageDeleteError).failures).toEqual([
      { key: "b", code: "AccessDenied", message: "denied" },
    ]);
    expect((err as Error).message).toContain("b (AccessDenied: denied)");
  });

  it("succeeds when every key was deleted", async () => {
    const clean = stubbed(() => ({ Deleted: [{ Key: "a" }] }));
    await expect(clean.delete(["a"])).resolves.toBeUndefined();
  });

  it("chunks at the 1000-key DeleteObjects limit", async () => {
    const sizes: number[] = [];
    const s = stubbed((cmd) => {
      sizes.push((cmd.input as { Delete: { Objects: unknown[] } }).Delete.Objects.length);
      return {};
    });
    await s.delete(Array.from({ length: 2500 }, (_, i) => `k${String(i)}`));
    expect(sizes).toEqual([1000, 1000, 500]);
  });
});
