# Media edge Worker (step 7)

Cloudflare Worker in front of the R2 media bucket (spec §5.2, Decision D4). It is the
public media origin the API advertises as `MEDIA_BASE_URL`.

```
GET /uploads/{uploadID}/…?token=…   one camera angle's HLS bundle — token required
GET /images/{file}                  thumbnails — public, immutable cache
GET /healthz                        liveness
```

Public path → R2 key by adding the storage prefix `media/` (spec §5.1 layout):
`/uploads/{id}/uhd8k/segment-00001.ts` → `media/uploads/{id}/uhd8k/segment-00001.ts`.

## What it does on every media request

1. **Validates the stream token** (`?token=`): HMAC-SHA256 signature, expiry, and that the
   request path lies under the token's prefix `uploads/{uploadID}/`. Failures answer
   `403` with the API's error shape (`token_required`, `invalid_token`, `token_expired`,
   `forbidden`). Tokens are minted by the API (`src/lib/stream-token.ts`); the format is
   documented there and pinned by an identical test vector in both suites.
2. **Playlists (`.m3u8`)**: fetches the object, appends the same token to every relative
   URI (segment lines and `URI="…"` attributes of `EXT-X-MEDIA`, `EXT-X-MAP`,
   `EXT-X-I-FRAME-STREAM-INF`, `EXT-X-SESSION-DATA`, …), and serves it `private, no-store`.
   AVPlayer's follow-up fetches therefore carry the token without client code.
3. **Segments and other files**: served from the edge cache when present, keyed on the
   URL *without* the token, so every viewer shares one cached copy and a token refresh
   does not refill the cache. `Cache-Control: public, max-age=31536000, immutable` —
   objects never change once published (a replacement is a new upload id).
   Byte-range requests (`Range:`) are answered `206` straight from R2.
4. **Thumbnails** need no token.

Only `GET`/`HEAD` are served; CORS stays closed (native clients only, spec §2.5).

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `MEDIA` | R2 binding | the media bucket (`tplace-media-prod` / `tplace-media-staging`) |
| `STREAM_TOKEN_SECRET` | secret | must equal the API's `STREAM_TOKEN_SECRET` |
| `STREAM_TOKEN_SECRET_PREVIOUS` | secret, optional | set during rotation so already-issued tokens stay valid until they expire (≤ 15 min), then remove |
| `REQUIRE_APP_KEY_FOR_PLAYLISTS` | var | `"true"` to also demand `X-App-Key` on playlist requests (spec §2.2). Off by default — AVPlayer loads the master playlist itself and cannot be relied on to send custom headers (Decision D5) |
| `APP_KEYS` | secret, optional | comma-separated accepted app keys, read only with the flag above |

```bash
wrangler secret put STREAM_TOKEN_SECRET --env staging
wrangler secret put STREAM_TOKEN_SECRET            # production
```

Secret rotation: set the new value as `STREAM_TOKEN_SECRET` on the API and the Worker and
the old one as `STREAM_TOKEN_SECRET_PREVIOUS`; after 15 minutes delete the previous one.

## Develop and test

```bash
cd edge-worker
pnpm install
pnpm typecheck
pnpm test          # vitest: token verification, playlist rewrite, request handling (fake R2 + cache)
pnpm dev           # wrangler dev — local R2 simulation; put objects with `wrangler r2 object put --local`
pnpm deploy:staging
pnpm deploy
```

The handler is written against injectable platform pieces (`handleRequest(request, env,
platform)`), so the unit tests run under plain Node without Miniflare. Behaviour that only
exists on Cloudflare (the real `caches.default`, R2 range semantics, custom domains) is
verified by `deploy/README.md`'s smoke test after the first deployment.

## Local development without the Worker

`MEDIA_BASE_URL` points at MinIO's `media/` folder and the API issues unsigned URLs when
`STREAM_TOKEN_SECRET` is empty, so the same public paths resolve directly against the bucket.
