import { describe, expect, it } from "vitest";
import { loadEnvFrom } from "../src/config/env.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from "../src/modules/auth/tokens.js";
import type { AppError } from "../src/lib/errors.js";

const KEY = "a".repeat(64);
const env = loadEnvFrom({ JWT_SIGNING_KEY: KEY, JWT_KID: "k1" });

const CLAIMS = {
  sub: "01890a5d-ac96-774b-b111-00000000a001",
  did: "did:tplace:01890a5d-ac96-774b-b111-00000000a001",
  handle: "ops",
  role: "operator" as const,
  chain: "01890a5d-ac96-774b-b111-00000000c001",
};

describe("access tokens", () => {
  it("sign/verify roundtrip preserves claims", async () => {
    const jwt = await signAccessToken(env, CLAIMS);
    const back = await verifyAccessToken(env, jwt);
    expect(back).toEqual(CLAIMS);
  });

  it("rejects tokens signed with a different key", async () => {
    const jwt = await signAccessToken(loadEnvFrom({ JWT_SIGNING_KEY: "b".repeat(64) }), CLAIMS);
    await expect(verifyAccessToken(env, jwt)).rejects.toMatchObject({
      code: "invalid_token",
    } satisfies Partial<AppError>);
  });

  it("rejects tokens with an unknown kid", async () => {
    const jwt = await signAccessToken(loadEnvFrom({ JWT_SIGNING_KEY: KEY, JWT_KID: "k9" }), CLAIMS);
    await expect(verifyAccessToken(env, jwt)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("rejects garbage", async () => {
    await expect(verifyAccessToken(env, "not.a.jwt")).rejects.toMatchObject({
      code: "invalid_token",
    });
  });
});

describe("refresh tokens", () => {
  it("are unique, prefixed, and hash deterministically", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a.startsWith("rft_")).toBe(true);
    expect(hashRefreshToken(a)).toBe(hashRefreshToken(a));
    expect(hashRefreshToken(a)).toMatch(/^[a-f0-9]{64}$/);
  });
});
