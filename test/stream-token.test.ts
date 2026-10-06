import { describe, expect, it } from "vitest";
import {
  signStreamToken,
  streamPrefixForUpload,
  verifyStreamToken,
} from "../src/lib/stream-token.js";

/**
 * Pinned test vector — the edge Worker's suite (edge-worker/test/token.test.ts)
 * asserts the identical token, so the two implementations cannot drift.
 */
const SECRET = "test-secret-0123456789abcdef";
const PREFIX = "uploads/01890a5d-ac96-774b-b111-000000000801/";
const EXP = 1_800_000_000;
const TOKEN =
  "v1.1800000000.dXBsb2Fkcy8wMTg5MGE1ZC1hYzk2LTc3NGItYjExMS0wMDAwMDAwMDA4MDEv.BHnR5TbuR1uIs_INOzTcTAT1j-ytcZU9JqW2J136WuU";
const BEFORE = new Date((EXP - 1) * 1000);
const AFTER = new Date(EXP * 1000);

describe("stream tokens", () => {
  it("signs the pinned vector", () => {
    expect(signStreamToken(SECRET, { pathPrefix: PREFIX, exp: EXP })).toBe(TOKEN);
    expect(streamPrefixForUpload("01890a5d-ac96-774b-b111-000000000801")).toBe(PREFIX);
  });

  it("verifies a valid token for a path under its prefix", () => {
    const res = verifyStreamToken(SECRET, TOKEN, { path: `${PREFIX}uhd8k/segment-00001.ts`, now: BEFORE });
    expect(res).toEqual({ ok: true, claims: { pathPrefix: PREFIX, exp: EXP } });
    // A leading slash on the request path is tolerated.
    expect(verifyStreamToken(SECRET, TOKEN, { path: `/${PREFIX}index.m3u8`, now: BEFORE }).ok).toBe(true);
  });

  it("expires exactly at exp", () => {
    expect(verifyStreamToken(SECRET, TOKEN, { now: BEFORE }).ok).toBe(true);
    expect(verifyStreamToken(SECRET, TOKEN, { now: AFTER })).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a path outside the prefix", () => {
    expect(
      verifyStreamToken(SECRET, TOKEN, { path: "uploads/01890a5d-ac96-774b-b111-000000000802/index.m3u8", now: BEFORE }),
    ).toEqual({ ok: false, reason: "prefix_mismatch" });
    // The prefix is a path segment boundary, not a string prefix game.
    expect(
      verifyStreamToken(SECRET, TOKEN, { path: "uploads/01890a5d-ac96-774b-b111-000000000801x/index.m3u8", now: BEFORE }),
    ).toEqual({ ok: false, reason: "prefix_mismatch" });
  });

  it("rejects tampering with any part", () => {
    const [v, exp, prefix, sig] = TOKEN.split(".") as [string, string, string, string];
    const later = `${v}.${String(EXP + 3600)}.${prefix}.${sig}`;
    expect(verifyStreamToken(SECRET, later, { now: BEFORE })).toEqual({ ok: false, reason: "bad_signature" });
    const otherPrefix = `${v}.${exp}.${Buffer.from("uploads/other/").toString("base64url")}.${sig}`;
    expect(verifyStreamToken(SECRET, otherPrefix, { now: BEFORE })).toEqual({ ok: false, reason: "bad_signature" });
    const flipped = `${v}.${exp}.${prefix}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    expect(verifyStreamToken(SECRET, flipped, { now: BEFORE })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyStreamToken("another-secret", TOKEN, { now: BEFORE })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects malformed and unknown-version tokens without throwing", () => {
    for (const bad of ["", "v1", "v1.x.y", "v1.1.2.3.4", "v1.abc.cHJlZml4Lw.c2ln", `v1.${String(EXP)}.$$.sig`]) {
      expect(verifyStreamToken(SECRET, bad, { now: BEFORE }).ok, bad).toBe(false);
    }
    expect(verifyStreamToken(SECRET, TOKEN.replace(/^v1/, "v2"), { now: BEFORE })).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });

  it("accepts any of several secrets, so rotation keeps old tokens valid", () => {
    expect(verifyStreamToken(["new-secret", SECRET], TOKEN, { now: BEFORE }).ok).toBe(true);
    expect(verifyStreamToken(["new-secret"], TOKEN, { now: BEFORE }).ok).toBe(false);
  });

  it("refuses to mint nonsense", () => {
    expect(() => signStreamToken(SECRET, { pathPrefix: "uploads/x", exp: EXP })).toThrow(/end with/);
    expect(() => signStreamToken(SECRET, { pathPrefix: PREFIX, exp: 1.5 })).toThrow(/positive integer/);
  });
});
