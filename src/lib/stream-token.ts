import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stream tokens (spec §5.2): a compact HMAC-SHA256 token binding a public
 * media path prefix to an expiry. The API mints one per camera angle; the
 * edge Worker validates it on every media request and propagates it into
 * playlist URIs so AVPlayer's fragment fetches carry it automatically.
 *
 * Wire format (all parts base64url, no padding, dot-separated):
 *
 *   v1.<exp>.<prefix>.<signature>
 *
 *   exp        expiry as unix seconds, decimal
 *   prefix     base64url of the public path prefix, e.g. "uploads/{uploadID}/"
 *   signature  base64url of HMAC-SHA256(secret, "v1.<exp>.<prefix>")
 *
 * The edge Worker (edge-worker/src/token.ts) implements the same format with
 * WebCrypto; both test suites pin the identical test vector so the two cannot
 * drift apart. Deterrence of hotlinking, not DRM (spec §5.2).
 */
export const STREAM_TOKEN_VERSION = "v1";

export interface StreamTokenClaims {
  /** Public path prefix the token is valid for, with trailing slash. */
  pathPrefix: string;
  /** Expiry, unix seconds. */
  exp: number;
}

export type StreamTokenRejection =
  | "malformed"
  | "unsupported_version"
  | "bad_signature"
  | "expired"
  | "prefix_mismatch";

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");

/** Public prefix for one upload's media; the only prefix shape v1 issues. */
export function streamPrefixForUpload(uploadId: string): string {
  return `uploads/${uploadId}/`;
}

function signingInput(exp: number, prefix: string): string {
  return `${STREAM_TOKEN_VERSION}.${String(exp)}.${b64url(prefix)}`;
}

export function signStreamToken(secret: string, claims: StreamTokenClaims): string {
  if (!Number.isInteger(claims.exp) || claims.exp <= 0) throw new Error("exp must be a positive integer");
  if (!claims.pathPrefix.endsWith("/")) throw new Error("pathPrefix must end with /");
  const input = signingInput(claims.exp, claims.pathPrefix);
  const sig = createHmac("sha256", secret).update(input).digest();
  return `${input}.${b64url(sig)}`;
}

/**
 * Verifies signature, expiry and (when given) that `path` lies under the
 * token's prefix. Any secret in `secrets` may have signed it, so a rotation
 * can keep the previous secret valid while tokens signed with it expire.
 */
export function verifyStreamToken(
  secrets: string | string[],
  token: string,
  opts: { path?: string; now?: Date } = {},
): { ok: true; claims: StreamTokenClaims } | { ok: false; reason: StreamTokenRejection } {
  const parts = token.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [version, expRaw, prefixRaw, sigRaw] = parts as [string, string, string, string];
  if (version !== STREAM_TOKEN_VERSION) return { ok: false, reason: "unsupported_version" };
  if (!/^\d{1,12}$/.test(expRaw)) return { ok: false, reason: "malformed" };
  if (!/^[A-Za-z0-9_-]+$/.test(prefixRaw) || !/^[A-Za-z0-9_-]{43}$/.test(sigRaw)) {
    return { ok: false, reason: "malformed" };
  }

  const input = `${version}.${expRaw}.${prefixRaw}`;
  const presented = Buffer.from(sigRaw, "base64url");
  const list = Array.isArray(secrets) ? secrets : [secrets];
  const signed = list.some((secret) => {
    const expected = createHmac("sha256", secret).update(input).digest();
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  });
  if (!signed) return { ok: false, reason: "bad_signature" };

  const exp = Number(expRaw);
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (exp <= nowSec) return { ok: false, reason: "expired" };

  const pathPrefix = Buffer.from(prefixRaw, "base64url").toString("utf8");
  if (opts.path !== undefined && !opts.path.replace(/^\/+/, "").startsWith(pathPrefix)) {
    return { ok: false, reason: "prefix_mismatch" };
  }
  return { ok: true, claims: { pathPrefix, exp } };
}
