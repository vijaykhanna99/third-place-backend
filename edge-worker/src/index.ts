import { rewritePlaylist } from "./playlist.ts";
import { verifyStreamToken } from "./token.ts";

/**
 * Third Place media edge (spec §5.2, Decision D4).
 *
 * Public surface, all on one origin (MEDIA_BASE_URL in the API):
 *
 *   GET /uploads/{uploadID}/…?token=…   HLS bundle of one camera angle. Token
 *                                       required, scoped to uploads/{uploadID}/.
 *                                       Playlists are rewritten so their URIs
 *                                       carry the token; segments are cached.
 *   GET /images/{file}                  Thumbnails. Public, long-lived cache.
 *   GET /healthz                        Liveness for monitoring.
 *
 * Public path → R2 key: prefix `media/` (storage layout, spec §5.1). The API
 * server never serves or rewrites media; objects in R2 are static.
 */
export interface Env {
  MEDIA: R2Bucket;
  STREAM_TOKEN_SECRET: string;
  /** Optional, during rotation: tokens signed with the previous secret stay valid until they expire. */
  STREAM_TOKEN_SECRET_PREVIOUS?: string;
  /** "true" to require X-App-Key on playlist requests (see wrangler.toml). */
  REQUIRE_APP_KEY_FOR_PLAYLISTS?: string;
  /** Comma-separated accepted app keys; only read when the flag above is on. */
  APP_KEYS?: string;
}

/** Injectable platform pieces so the handler unit-tests under plain Node. */
export interface Platform {
  cache: Cache | undefined;
  now: () => number;
  waitUntil: (p: Promise<unknown>) => void;
}

const UPLOAD_PATH = /^\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(.+)$/i;
const IMAGE_PATH = /^\/images\/([A-Za-z0-9._-]+)$/;
const STORAGE_PREFIX = "media/";

const CONTENT_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/** Objects never change once published (a replacement is a new upload id). */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Rewritten playlists embed the caller's token: cacheable by that client only. */
const PRIVATE = "private, max-age=0, no-store";

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot).toLowerCase()]) ?? "application/octet-stream";
}

function error(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function baseHeaders(object: R2Object, path: string, cacheControl: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("content-type")) headers.set("content-type", contentTypeFor(path));
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", cacheControl);
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

/**
 * Fetches a whole object, through the edge cache when one is available. The
 * cache key is the URL without its query string, so every token shares one
 * cached copy of a segment and a token refresh does not refill the cache.
 */
async function fetchWhole(
  env: Env,
  platform: Platform,
  url: URL,
  key: string,
  path: string,
  cacheControl: string,
): Promise<Response | null> {
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: "GET" });
  const cached = await platform.cache?.match(cacheKey);
  if (cached) return cached;

  const object = await env.MEDIA.get(key);
  if (!object) return null;
  const headers = baseHeaders(object, path, cacheControl);
  headers.set("content-length", String(object.size));
  const response = new Response(object.body, { status: 200, headers });
  if (platform.cache && cacheControl === IMMUTABLE) {
    platform.waitUntil(platform.cache.put(cacheKey, response.clone()));
  }
  return response;
}

/** Byte-range requests go straight to R2: the edge cache stores whole objects only. */
async function fetchRange(env: Env, request: Request, key: string, path: string): Promise<Response | null> {
  const object = await env.MEDIA.get(key, { range: request.headers });
  if (!object) return null;
  const headers = baseHeaders(object, path, IMMUTABLE);
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (!range || object.body === undefined || !("body" in object)) {
    // R2 found the range unsatisfiable or returned no body: say so, do not guess.
    headers.set("content-range", `bytes */${String(object.size)}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
  const length = range.suffix ?? range.length ?? object.size - start;
  const end = start + length - 1;
  headers.set("content-range", `bytes ${String(start)}-${String(end)}/${String(object.size)}`);
  headers.set("content-length", String(length));
  return new Response((object as R2ObjectBody).body, { status: 206, headers });
}

function appKeyAccepted(request: Request, env: Env): boolean {
  if (env.REQUIRE_APP_KEY_FOR_PLAYLISTS !== "true") return true;
  const keys = (env.APP_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  const presented = request.headers.get("x-app-key");
  return presented !== null && keys.includes(presented);
}

function headOnly(request: Request, response: Response): Response {
  return request.method === "HEAD" ? new Response(null, response) : response;
}

export async function handleRequest(request: Request, env: Env, platform: Platform): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return error(405, "method_not_allowed", "Only GET and HEAD are served");
  }
  const url = new URL(request.url);

  if (url.pathname === "/healthz") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const image = IMAGE_PATH.exec(url.pathname);
  if (image) {
    const path = `images/${image[1]!}`;
    const response = await fetchWhole(env, platform, url, `${STORAGE_PREFIX}${path}`, path, IMMUTABLE);
    return response ? headOnly(request, response) : error(404, "not_found", "No such image");
  }

  const upload = UPLOAD_PATH.exec(url.pathname);
  if (!upload) return error(404, "not_found", "No such resource");
  const path = `uploads/${upload[1]!.toLowerCase()}/${upload[2]!}`;
  if (path.split("/").some((seg) => seg === "." || seg === "..")) {
    return error(404, "not_found", "No such resource");
  }

  const token = url.searchParams.get("token");
  if (!token) return error(403, "token_required", "A stream token is required");
  const secrets = [env.STREAM_TOKEN_SECRET, env.STREAM_TOKEN_SECRET_PREVIOUS ?? ""];
  const verdict = await verifyStreamToken(secrets, token, path, platform.now());
  if (!verdict.ok) {
    if (verdict.reason === "expired") return error(403, "token_expired", "The stream token has expired");
    if (verdict.reason === "prefix_mismatch") return error(403, "forbidden", "Token is not valid for this path");
    return error(403, "invalid_token", "Invalid stream token");
  }

  const key = `${STORAGE_PREFIX}${path}`;
  const isPlaylist = path.toLowerCase().endsWith(".m3u8");

  if (isPlaylist) {
    if (!appKeyAccepted(request, env)) return error(403, "app_key_required", "Missing or invalid app key");
    const raw = await fetchWhole(env, platform, url, key, path, IMMUTABLE);
    if (!raw) return error(404, "not_found", "No such playlist");
    const text = rewritePlaylist(await raw.text(), token);
    const headers = new Headers(raw.headers);
    headers.set("content-type", "application/vnd.apple.mpegurl");
    headers.set("cache-control", PRIVATE);
    headers.set("content-length", String(new TextEncoder().encode(text).byteLength));
    headers.delete("etag");
    return headOnly(request, new Response(text, { status: 200, headers }));
  }

  if (request.headers.has("range")) {
    const partial = await fetchRange(env, request, key, path);
    return partial ? headOnly(request, partial) : error(404, "not_found", "No such object");
  }
  const whole = await fetchWhole(env, platform, url, key, path, IMMUTABLE);
  return whole ? headOnly(request, whole) : error(404, "not_found", "No such object");
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const platform: Platform = {
      cache: (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches?.default,
      now: () => Date.now(),
      waitUntil: (p) => ctx.waitUntil(p),
    };
    return handleRequest(request, env, platform);
  },
} satisfies ExportedHandler<Env>;
