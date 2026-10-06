import { describe, expect, it } from "vitest";
import { fromBase64Url, signStreamToken, toBase64Url, verifyStreamToken } from "../src/token.ts";

/** Pinned vector shared with the API suite (test/stream-token.test.ts). */
const SECRET = "test-secret-0123456789abcdef";
const PREFIX = "uploads/01890a5d-ac96-774b-b111-000000000801/";
const EXP = 1_800_000_000;
const TOKEN =
  "v1.1800000000.dXBsb2Fkcy8wMTg5MGE1ZC1hYzk2LTc3NGItYjExMS0wMDAwMDAwMDA4MDEv.BHnR5TbuR1uIs_INOzTcTAT1j-ytcZU9JqW2J136WuU";
const BEFORE = (EXP - 1) * 1000;
const AFTER = EXP * 1000;

describe("base64url", () => {
  it("round-trips arbitrary bytes without padding", () => {
    for (const len of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) % 256);
      const text = toBase64Url(bytes);
      expect(text).not.toMatch(/[+/=]/);
      expect([...fromBase64Url(text)]).toEqual([...bytes]);
    }
  });
});

describe("stream token verification", () => {
  it("produces and accepts the pinned vector", async () => {
    expect(await signStreamToken(SECRET, { pathPrefix: PREFIX, exp: EXP })).toBe(TOKEN);
    const res = await verifyStreamToken([SECRET], TOKEN, `${PREFIX}uhd8k/segment-00001.ts`, BEFORE);
    expect(res).toEqual({ ok: true, claims: { pathPrefix: PREFIX, exp: EXP } });
    expect((await verifyStreamToken([SECRET], TOKEN, `/${PREFIX}index.m3u8`, BEFORE)).ok).toBe(true);
  });

  it("expires exactly at exp", async () => {
    expect((await verifyStreamToken([SECRET], TOKEN, PREFIX, BEFORE)).ok).toBe(true);
    expect(await verifyStreamToken([SECRET], TOKEN, PREFIX, AFTER)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects paths outside the prefix", async () => {
    expect(
      await verifyStreamToken([SECRET], TOKEN, "uploads/01890a5d-ac96-774b-b111-000000000802/index.m3u8", BEFORE),
    ).toEqual({ ok: false, reason: "prefix_mismatch" });
    expect(await verifyStreamToken([SECRET], TOKEN, "images/x.png", BEFORE)).toEqual({
      ok: false,
      reason: "prefix_mismatch",
    });
  });

  it("rejects tampering and wrong secrets", async () => {
    const [v, exp, prefix, sig] = TOKEN.split(".") as [string, string, string, string];
    expect(await verifyStreamToken([SECRET], `${v}.${String(EXP + 60)}.${prefix}.${sig}`, PREFIX, BEFORE)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const other = toBase64Url(new TextEncoder().encode("uploads/other/"));
    expect(await verifyStreamToken([SECRET], `${v}.${exp}.${other}.${sig}`, "uploads/other/x", BEFORE)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyStreamToken(["nope"], TOKEN, PREFIX, BEFORE)).toEqual({ ok: false, reason: "bad_signature" });
    // An empty secret slot (unset STREAM_TOKEN_SECRET_PREVIOUS) never verifies anything.
    expect(await verifyStreamToken([""], TOKEN, PREFIX, BEFORE)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("accepts the previous secret during rotation", async () => {
    expect((await verifyStreamToken(["rotated-secret", SECRET], TOKEN, PREFIX, BEFORE)).ok).toBe(true);
  });

  it("rejects malformed tokens and unknown versions without throwing", async () => {
    for (const bad of ["", "v1", "v1.x.y", "v1.1.2.3.4", "v1.abc.cHJlZml4Lw.c2ln", `v1.${String(EXP)}.$$.sig`]) {
      expect((await verifyStreamToken([SECRET], bad, PREFIX, BEFORE)).ok, bad).toBe(false);
    }
    expect(await verifyStreamToken([SECRET], TOKEN.replace(/^v1/, "v9"), PREFIX, BEFORE)).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });
});
