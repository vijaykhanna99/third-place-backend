/**
 * Stream-token verification at the edge (spec §5.2), WebCrypto edition of
 * `src/lib/stream-token.ts` in the API. Same wire format:
 *
 *   v1.<exp>.<base64url(prefix)>.<base64url(HMAC-SHA256(secret, "v1.<exp>.<base64url(prefix)>"))>
 *
 * Both test suites assert one pinned vector, so the two cannot drift.
 */
export const STREAM_TOKEN_VERSION = "v1";

export interface StreamTokenClaims {
  pathPrefix: string;
  exp: number;
}

export type StreamTokenRejection =
  | "malformed"
  | "unsupported_version"
  | "bad_signature"
  | "expired"
  | "prefix_mismatch";

export type VerifyResult = { ok: true; claims: StreamTokenClaims } | { ok: false; reason: StreamTokenRejection };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** Minting lives in the API; this exists for tests and local tooling. */
export async function signStreamToken(secret: string, claims: StreamTokenClaims): Promise<string> {
  const input = `${STREAM_TOKEN_VERSION}.${String(claims.exp)}.${toBase64Url(encoder.encode(claims.pathPrefix))}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(input));
  return `${input}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * Verifies signature (against any of `secrets`, so a rotation keeps the
 * previous secret valid), expiry, and that `path` lies under the prefix.
 * `crypto.subtle.verify` is constant-time; nothing here compares signatures
 * by hand.
 */
export async function verifyStreamToken(
  secrets: string[],
  token: string,
  path: string,
  nowMs: number = Date.now(),
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [version, expRaw, prefixRaw, sigRaw] = parts as [string, string, string, string];
  if (version !== STREAM_TOKEN_VERSION) return { ok: false, reason: "unsupported_version" };
  if (!/^\d{1,12}$/.test(expRaw)) return { ok: false, reason: "malformed" };
  if (!/^[A-Za-z0-9_-]+$/.test(prefixRaw) || !/^[A-Za-z0-9_-]{43}$/.test(sigRaw)) {
    return { ok: false, reason: "malformed" };
  }

  const input = encoder.encode(`${version}.${expRaw}.${prefixRaw}`);
  const signature = fromBase64Url(sigRaw);
  let signed = false;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    if (await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, input)) {
      signed = true;
      break;
    }
  }
  if (!signed) return { ok: false, reason: "bad_signature" };

  const exp = Number(expRaw);
  if (exp <= Math.floor(nowMs / 1000)) return { ok: false, reason: "expired" };

  const pathPrefix = decoder.decode(fromBase64Url(prefixRaw));
  if (!path.replace(/^\/+/, "").startsWith(pathPrefix)) return { ok: false, reason: "prefix_mismatch" };
  return { ok: true, claims: { pathPrefix, exp } };
}
