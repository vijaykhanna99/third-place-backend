import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify, decodeProtectedHeader } from "jose";
import type { Env } from "../../config/env.js";
import { errors } from "../../lib/errors.js";

export type Role = "operator" | "creator" | "user";

/** Claims carried by every access token (spec §4). `chain` ties it to a session chain. */
export interface AccessClaims {
  sub: string;
  did: string;
  handle: string;
  role: Role;
  chain: string;
}

function signingKey(env: Env): Uint8Array {
  if (!env.JWT_SIGNING_KEY) throw errors.internal("JWT signing key not configured");
  return new TextEncoder().encode(env.JWT_SIGNING_KEY);
}

export async function signAccessToken(env: Env, claims: AccessClaims): Promise<string> {
  return new SignJWT({
    did: claims.did,
    handle: claims.handle,
    role: claims.role,
    chain: claims.chain,
  })
    .setProtectedHeader({ alg: "HS256", kid: env.JWT_KID })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SEC}s`)
    .sign(signingKey(env));
}

/** Verifies signature, expiry, and kid. Throws 401 invalid_token on any failure. */
export async function verifyAccessToken(env: Env, token: string): Promise<AccessClaims> {
  try {
    // Single active key in v1; rotation later checks kid against a key ring.
    const header = decodeProtectedHeader(token);
    if (header.kid !== env.JWT_KID) throw new Error("unknown kid");

    const { payload } = await jwtVerify(token, signingKey(env), { algorithms: ["HS256"] });
    const { sub } = payload;
    const did = payload.did;
    const handle = payload.handle;
    const role = payload.role;
    const chain = payload.chain;
    if (
      typeof sub !== "string" ||
      typeof did !== "string" ||
      typeof handle !== "string" ||
      typeof chain !== "string" ||
      (role !== "operator" && role !== "creator" && role !== "user")
    ) {
      throw new Error("malformed claims");
    }
    return { sub, did, handle, role, chain };
  } catch {
    throw errors.invalidToken();
  }
}

/** Opaque refresh token — never stored raw; only its SHA-256 hash hits the DB (spec §4). */
export function generateRefreshToken(): string {
  return `rft_${randomBytes(32).toString("base64url")}`;
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Emailed single-use token (verification, reset) — only its hash is stored. */
export function generateAccountToken(): string {
  return `act_${randomBytes(32).toString("base64url")}`;
}

export function hashAccountToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Generated operator passwords (CLI, when --password is not given). */
export function generatePassword(): string {
  return randomBytes(15).toString("base64url");
}
