import { describe, expect, it } from "vitest";
import { handleRequest, type Env, type Platform } from "../src/index.ts";
import { signStreamToken } from "../src/token.ts";

/**
 * Handler tests under plain Node: R2 and the edge cache are replaced by small
 * fakes with the same surface the Worker uses, so routing, token gating,
 * playlist rewriting, range handling and caching are all asserted here.
 */
const SECRET = "handler-test-secret-0123456789";
const UPLOAD = "01890a5d-ac96-774b-b111-000000000801";
const OTHER = "01890a5d-ac96-774b-b111-000000000802";
const ORIGIN = "https://media.test.example";
const NOW = 1_800_000_000_000;

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="JA",LANGUAGE="ja",URI="subtitles/ja/subtitle.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=48000000,RESOLUTION=7680x4320,SUBTITLES="subs"
uhd8k/playlist.m3u8
`;

class FakeObject {
  readonly httpEtag: string;
  constructor(
    readonly key: string,
    readonly bytes: Uint8Array,
    readonly contentType: string | undefined,
    readonly range?: { offset: number; length: number },
  ) {
    this.httpEtag = `"${key.length.toString(16)}"`;
  }
  get size() {
    return this.bytes.length;
  }
  get body() {
    const slice = this.range ? this.bytes.slice(this.range.offset, this.range.offset + this.range.length) : this.bytes;
    return new Response(slice as unknown as ArrayBuffer).body as ReadableStream;
  }
  writeHttpMetadata(headers: Headers) {
    if (this.contentType) headers.set("content-type", this.contentType);
  }
}

class FakeBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  readonly gets: string[] = [];
  put(key: string, body: string | Uint8Array, contentType?: string) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    this.objects.set(key, contentType ? { bytes, contentType } : { bytes });
  }
  get(key: string, opts?: { range?: Headers }): Promise<FakeObject | null> {
    this.gets.push(key);
    const o = this.objects.get(key);
    if (!o) return Promise.resolve(null);
    const header = opts?.range?.get("range");
    if (!header) return Promise.resolve(new FakeObject(key, o.bytes, o.contentType));
    const m = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!m) return Promise.resolve(new FakeObject(key, o.bytes, o.contentType));
    const start = m[1] === "" ? o.bytes.length - Number(m[2]) : Number(m[1]);
    const end = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), o.bytes.length - 1) : o.bytes.length - 1;
    return Promise.resolve(new FakeObject(key, o.bytes, o.contentType, { offset: start, length: end - start + 1 }));
  }
}

class FakeCache {
  readonly store = new Map<string, Response>();
  readonly hits: string[] = [];
  match(req: Request): Promise<Response | undefined> {
    const hit = this.store.get(req.url);
    if (hit) this.hits.push(req.url);
    return Promise.resolve(hit?.clone());
  }
  put(req: Request, res: Response): Promise<void> {
    this.store.set(req.url, res);
    return Promise.resolve();
  }
}

function setup(envOverrides: Partial<Env> = {}) {
  const bucket = new FakeBucket();
  bucket.put(`media/uploads/${UPLOAD}/index.m3u8`, MASTER, "application/vnd.apple.mpegurl");
  bucket.put(`media/uploads/${UPLOAD}/uhd8k/playlist.m3u8`, "#EXTM3U\n#EXTINF:6.0,\nsegment-00001.ts\n#EXT-X-ENDLIST\n");
  bucket.put(`media/uploads/${UPLOAD}/uhd8k/segment-00001.ts`, new Uint8Array(1000).map((_, i) => i % 251), "video/mp2t");
  bucket.put(`media/uploads/${OTHER}/index.m3u8`, MASTER);
  bucket.put("media/images/thumb.png", new Uint8Array([137, 80, 78, 71]), "image/png");
  const cache = new FakeCache();
  const pending: Promise<unknown>[] = [];
  const platform: Platform = { cache: cache as unknown as Cache, now: () => NOW, waitUntil: (p) => void pending.push(p) };
  const env: Env = { MEDIA: bucket as unknown as R2Bucket, STREAM_TOKEN_SECRET: SECRET, ...envOverrides };
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await handleRequest(new Request(`${ORIGIN}${path}`, init), env, platform);
    await Promise.all(pending);
    return res;
  };
  return { bucket, cache, env, platform, call };
}

const tokenFor = (uploadId: string, expSec = NOW / 1000 + 900, secret = SECRET) =>
  signStreamToken(secret, { pathPrefix: `uploads/${uploadId}/`, exp: expSec });

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe("edge handler", () => {
  it("serves a master playlist with the token propagated into every URI", async () => {
    const { call } = setup();
    const token = await tokenFor(UPLOAD);
    const res = await call(`/uploads/${UPLOAD}/index.m3u8?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(res.headers.get("cache-control")).toContain("private");
    const body = await res.text();
    expect(body).toContain(`uhd8k/playlist.m3u8?token=${token}`);
    expect(body).toContain(`URI="subtitles/ja/subtitle.m3u8?token=${token}"`);
    expect(res.headers.get("content-length")).toBe(String(new TextEncoder().encode(body).byteLength));
  });

  it("serves segments with immutable caching and shares the cache across tokens", async () => {
    const { call, bucket, cache } = setup();
    const t1 = await tokenFor(UPLOAD);
    const t2 = await tokenFor(UPLOAD, NOW / 1000 + 800);
    const a = await call(`/uploads/${UPLOAD}/uhd8k/segment-00001.ts?token=${t1}`);
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("video/mp2t");
    expect(a.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(a.headers.get("content-length")).toBe("1000");
    expect((await a.arrayBuffer()).byteLength).toBe(1000);

    const b = await call(`/uploads/${UPLOAD}/uhd8k/segment-00001.ts?token=${t2}`);
    expect(b.status).toBe(200);
    expect((await b.arrayBuffer()).byteLength).toBe(1000);
    // One origin read, one cache hit keyed without the token.
    expect(bucket.gets.filter((k) => k.endsWith("segment-00001.ts"))).toHaveLength(1);
    expect(cache.hits).toEqual([`${ORIGIN}/uploads/${UPLOAD}/uhd8k/segment-00001.ts`]);
  });

  it("answers byte-range requests with 206 straight from storage", async () => {
    const { call } = setup();
    const token = await tokenFor(UPLOAD);
    const res = await call(`/uploads/${UPLOAD}/uhd8k/segment-00001.ts?token=${token}`, {
      headers: { range: "bytes=100-199" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("content-length")).toBe("100");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(100);
    expect(bytes[0]).toBe(100 % 251);
    const suffix = await call(`/uploads/${UPLOAD}/uhd8k/segment-00001.ts?token=${token}`, {
      headers: { range: "bytes=-10" },
    });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 990-999/1000");
  });

  it("requires a token and rejects missing, invalid, expired and foreign ones", async () => {
    const { call } = setup();
    expect(await errorCode(await call(`/uploads/${UPLOAD}/index.m3u8`))).toBe("token_required");
    const garbage = await call(`/uploads/${UPLOAD}/index.m3u8?token=v1.1.2.3`);
    expect(garbage.status).toBe(403);
    expect(await errorCode(garbage)).toBe("invalid_token");
    const forged = await call(`/uploads/${UPLOAD}/index.m3u8?token=${await tokenFor(UPLOAD, NOW / 1000 + 900, "x")}`);
    expect(await errorCode(forged)).toBe("invalid_token");
    const expired = await call(`/uploads/${UPLOAD}/index.m3u8?token=${await tokenFor(UPLOAD, NOW / 1000 - 1)}`);
    expect(expired.status).toBe(403);
    expect(await errorCode(expired)).toBe("token_expired");
    // A token for another angle does not open this one.
    const foreign = await call(`/uploads/${UPLOAD}/index.m3u8?token=${await tokenFor(OTHER)}`);
    expect(foreign.status).toBe(403);
    expect(await errorCode(foreign)).toBe("forbidden");
  });

  it("keeps tokens signed with the previous secret valid during rotation", async () => {
    const { call } = setup({ STREAM_TOKEN_SECRET: "rotated", STREAM_TOKEN_SECRET_PREVIOUS: SECRET });
    const res = await call(`/uploads/${UPLOAD}/index.m3u8?token=${await tokenFor(UPLOAD)}`);
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown objects and paths, never leaking bucket layout", async () => {
    const { call } = setup();
    const token = await tokenFor(UPLOAD);
    expect((await call(`/uploads/${UPLOAD}/uhd4k/playlist.m3u8?token=${token}`)).status).toBe(404);
    // URL normalisation resolves `..` before routing: the token no longer matches the path.
    expect((await call(`/uploads/${UPLOAD}/../${OTHER}/index.m3u8?token=${token}`)).status).toBe(403);
    // Percent-encoded dot segments are normalised the same way (WHATWG URL).
    expect((await call(`/uploads/${UPLOAD}/%2e%2e/${OTHER}/index.m3u8?token=${token}`)).status).toBe(403);
    expect((await call(`/media/uploads/${UPLOAD}/index.m3u8?token=${token}`)).status).toBe(404);
    expect((await call(`/uploads/not-a-uuid/index.m3u8?token=${token}`)).status).toBe(404);
    expect((await call("/tmp/uploads/x.zip")).status).toBe(404);
  });

  it("serves thumbnails publicly and caches them", async () => {
    const { call, cache } = setup();
    const res = await call("/images/thumb.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(cache.store.has(`${ORIGIN}/images/thumb.png`)).toBe(true);
    expect((await call("/images/missing.png")).status).toBe(404);
    expect((await call("/images/../uploads/x")).status).toBe(404);
  });

  it("enforces X-App-Key on playlists only when configured", async () => {
    const { call } = setup({ REQUIRE_APP_KEY_FOR_PLAYLISTS: "true", APP_KEYS: "key-a, key-b" });
    const token = await tokenFor(UPLOAD);
    const denied = await call(`/uploads/${UPLOAD}/index.m3u8?token=${token}`);
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("app_key_required");
    const allowed = await call(`/uploads/${UPLOAD}/index.m3u8?token=${token}`, { headers: { "x-app-key": "key-b" } });
    expect(allowed.status).toBe(200);
    // Segments never need the header: AVPlayer cannot send it.
    const segment = await call(`/uploads/${UPLOAD}/uhd8k/segment-00001.ts?token=${token}`);
    expect(segment.status).toBe(200);
  });

  it("answers HEAD without a body and refuses other methods", async () => {
    const { call } = setup();
    const token = await tokenFor(UPLOAD);
    const head = await call(`/uploads/${UPLOAD}/uhd8k/segment-00001.ts?token=${token}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("1000");
    expect(await head.text()).toBe("");
    expect((await call(`/uploads/${UPLOAD}/index.m3u8?token=${token}`, { method: "POST" })).status).toBe(405);
    expect((await call("/healthz")).status).toBe(200);
  });

  it("works without an edge cache (local dev, tests)", async () => {
    const { env, call } = setup();
    const platform: Platform = { cache: undefined, now: () => NOW, waitUntil: () => undefined };
    const token = await tokenFor(UPLOAD);
    const res = await handleRequest(new Request(`${ORIGIN}/uploads/${UPLOAD}/uhd8k/segment-00001.ts?token=${token}`), env, platform);
    expect(res.status).toBe(200);
    expect((await call("/healthz")).status).toBe(200);
  });
});
