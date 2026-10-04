# Third Place App Backend Server Specification — v1 FINAL

**Status:** Finalized for implementation. Supersedes the proposal document ("Backend Server Specification Proposal").
**Finalized by:** Vijay Kumar (CTO)
**Audience:** Backend (Vijay), Client app (Kei-chan, Kayane)

As a premise, this service is exclusively for immersive video. All references to "video" mean stereoscopic video encoded in MV-HEVC with corresponding audio (Apple Positional Audio Codec), delivered as HLS. Flat video is not handled; there are no branches based on video format.

---

## 0. Changelog vs. the proposal (read this first)

| # | Change | Rationale |
|---|---|---|
| 1 | **AT Protocol: not adopted for v1.** All `/xrpc` variants removed. AT-Proto-compatible conventions retained (`did`/`handle` field names, POST-shaped writes, cursor pagination) so adoption remains possible at Phase 2. | AT Proto's value (accounts, social records) is entirely dormant in a release with no end-user accounts. Decision D1. |
| 2 | **Stack fixed:** TypeScript / Node.js, Fastify, PostgreSQL 16, Drizzle ORM, Redis + BullMQ. | Decision D2. |
| 3 | **Storage/delivery fixed:** Cloudflare R2 + Cloudflare CDN with an edge Worker. Access control via short-lived prefix-scoped tokens validated at the edge; the Worker propagates the token into playlist fragment URIs. The proposal's per-request HMAC playlist generation on the API server is dropped (kept as documented fallback). | Removes a hot-path playlist service from the API; zero egress fees. Decision D4. |
| 4 | **Video upload is presigned direct-to-storage**, not multipart through the API. New `complete` + status endpoints. Validation pipeline unchanged. | Resumable, survives dropped connections on multi-GB files. Decision D6. |
| 5 | **`X-App-Key` gates API and playlist requests only.** Fragment requests are protected by signed tokens alone — AVPlayer does not reliably attach custom headers to segment fetches. | Technical correction to the proposal. Decision D5. |
| 6 | **Episode Download (ZIP/offline) deferred to Phase 2+.** Endpoint spec preserved in the deferred section (JSON-manifest form, not ZIP). | Drags DRM questions forward for the least-essential path. Decision D7. |
| 7 | **Settings endpoints deferred to Phase 2.** With no end-user accounts there is no server-side settings owner; the client stores preferences locally in v1. | Dead code otherwise. |
| 8 | **Email verification / password reset: implemented dormant.** Handlers exist; no email provider is wired in v1. | No public registration in v1. Decision D8. |
| 9 | **Added:** `GET /healthz`, `POST /api/v1/metrics/playback`, `GET /api/v1/episodes/{episodeID}/stream` (token refresh), operator seed CLI, orphan-cleanup job, rate limiting, CORS policy, `quality` enum. | Operational gaps in the proposal. Decision D9. |
| 10 | **Error format locked** (§2.3). OpenAPI 3.1 file is the single source of truth for the contract; a mock server is generated from it. | Client team builds against the mock from week 1. |
| 11 | **v1.1 client-review revisions (Aug 2026, from Keisuke Chinone's review):** (a) episodes carry 1..n named camera-angle `streams` (`[{name, streamURL}]`) instead of a single `streamURL` — new `episode_streams` table, media storage keyed per upload (`media/uploads/{uploadID}/…`); (b) episode `thumbnailURL` added to §6.1 program detail; (c) program-level `viewCount` (approximate, from anonymous playback telemetry) added to §6.1. CMS payloads take `streams: [{name, uploadID}]` per episode. | Multi-angle is the core product feature; the single-stream episode model was an unstated spec assumption the client review caught. |

**Open business item (flagged, not blocking implementation start):** v1 launches **free-to-watch with no end-user accounts**; monetization (subscription/purchase) arrives with accounts in Phase 2. This contradicts the earlier phased feature list where subscription was a Phase-1 Must. Awaiting explicit confirmation from Yuta. The architecture is unaffected either way; only launch messaging and partner commitments are.

---

## 1. Technology Stack (fixed)

| Layer | Choice |
|---|---|
| Language / runtime | TypeScript on Node.js (LTS) |
| HTTP framework | Fastify |
| Database | PostgreSQL 16 (managed, daily backups + PITR) |
| ORM / migrations | Drizzle |
| Queue / jobs | Redis + BullMQ (upload extraction, janitor) |
| Object storage | Cloudflare R2 |
| CDN / edge auth | Cloudflare CDN + Worker (token validation, playlist token propagation) |
| API contract | OpenAPI 3.1 (`openapi.yaml` in repo root; mock server generated from it) |
| Auth | JWT access (15 min) + rotating refresh (30 days), Argon2id |

Primary keys are UUIDv7. Timestamps are ISO 8601 UTC. All communication is HTTPS.

---

## 2. Global API Conventions

### 2.1 Base path, methods, pagination

- Base path: `/api/v1`. Reads are GET; writes are POST (no PATCH/DELETE — AT-Proto-compatible shape).
- List endpoints use cursor pagination: `limit` (default 20 unless stated) + opaque `cursor`; first request omits cursor; response returns `nextCursor: string | null`.
- Programs, episodes, and genres are addressed by UUID `id`. Seasons are addressed by `seasonNumber`, unique within a program.

### 2.2 Authentication & app gating

- **Operator endpoints** (all writes: program/episode CRUD, uploads): `Authorization: Bearer {accessToken}` required. Role check is declared per endpoint (roles enum: `operator`, reserved: `creator`, `user`).
- **Public read endpoints** (details, lists, search, stream token): require header `X-App-Key: {key}` (key embedded in the app). Requests without it → `403 app_key_required`.
- **Media requests to the CDN** (playlists, fragments): signed token only (§5). The playlist request additionally carries `X-App-Key` when fetched by app code; fragment fetches by AVPlayer carry the token only.

### 2.3 Error format (all endpoints)

```json
{
    "error": {
        "code": "string",
        "message": "string"
    }
}
```

`code` is machine-readable snake_case (e.g. `not_found`, `invalid_token`, `app_key_required`, `rate_limited`, `validation_failed`); `message` is human-readable English. HTTP status codes: 400 validation, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict, 429 rate-limited, 500 internal.

### 2.4 Rate limiting

- Public reads: 60 req/min per IP (burstable), 429 on excess.
- Login: 5 failures per account per 15 min and 20 per IP per 15 min → temporary lockout; identical error regardless of failure cause.

### 2.5 CORS

v1 clients are native (visionOS/iOS): CORS closed by default. An allowlist env var exists for the future web client; no wildcard origins ever.

### 2.6 Health

`GET /healthz` (no auth, no app key) → `200 {"status":"ok"}` checking DB + Redis connectivity. Used by the platform's liveness checks.

### 2.7 Validation limits

Defined in the OpenAPI file, not prose. Defaults: `title` ≤ 200 chars, `description` ≤ 5,000, `displayName` ≤ 64, `handle` 3–32 `[a-z0-9-]`, password ≥ 10 chars.

---

## 3. Authorization Policy

**v1:** No end-user accounts. Operator accounts only, issued via server-side seed CLI (`pnpm cli operator:create --handle ... --email ...`); the registration endpoint is deployed but returns `403 registration_closed` to external calls. All reads are public (app-key-gated). All writes require the `operator` role.

**Phase 2:** Public registration opens with SNS features; write operations move to account-based control; `viewer.*` fields become meaningful (in v1 they always return `false`).

**Future:** three-level roles (`operator` / `creator` / `user`). Endpoints declare required role from day one so adding roles is configuration, not refactoring.

---

## 4. Authentication (operator-only wiring in v1)

Token design: access token = JWT, 15-min TTL, `kid` in header for key rotation, signing key server-side. Refresh token = opaque random string, 30-day TTL, stored hashed; rotated on every refresh; reuse of a consumed token invalidates the whole session chain. Multiple sessions per account; session records store issued-at, last-used, device info. Passwords: Argon2id. Logout invalidates the presented session only; password change / account deletion invalidates all sessions.

### 4.1 Register — `POST /api/v1/auth/register` *(deployed; externally closed in v1)*

Request:
```json
{ "handle": "string", "email": "string", "password": "string", "displayName": "string" }
```
`handle` globally unique → `409 handle_taken`. Response:
```json
{
    "did": "string", "handle": "string", "email": "string", "displayName": "string",
    "avatarURL": "string(URL) | null", "createdAt": "string(ISO8601)",
    "accessToken": "string(JWT)", "refreshToken": "string", "expiresIn": "number"
}
```

### 4.2 Login — `POST /api/v1/auth/login`

Request (`identifier` = handle or email):
```json
{ "identifier": "string", "password": "string" }
```
Response:
```json
{ "did": "string", "handle": "string", "accessToken": "string(JWT)", "refreshToken": "string", "expiresIn": "number" }
```

### 4.3 Refresh — `POST /api/v1/auth/refresh`

Request `{ "refreshToken": "string" }` → response same shape as login (new tokens; old refresh invalidated).

### 4.4 Logout — `POST /api/v1/auth/logout`

Request `{ "refreshToken": "string" }` → `{ "revoked": true }`.

### 4.5 Sessions — `GET /api/v1/auth/sessions`, `POST /api/v1/auth/sessions/{sessionID}/revoke`

List and revoke own sessions.

### 4.6 Account — `GET /api/v1/account`, `POST /api/v1/account`, `POST /api/v1/account/delete`

As per proposal: GET returns profile; POST updates only sent fields (password change requires `{"password":{"current","next"}}`); delete requires password re-entry, responds `{ "did", "deleted", "deletedAt" }`.

### 4.7 Email verification / password reset *(dormant in v1)*

`POST /api/v1/auth/email/verify-request`, `/auth/email/verify`, `/auth/password/reset-request`, `/auth/password/reset`. Handlers implemented; sending is a no-op until an email provider is configured (Phase 2). Tokens: single-use, short-lived.

---

## 5. Video Delivery (final design)

### 5.1 Storage layout (R2)

```
media/uploads/{uploadID}/          (one upload = one camera angle of one episode)
    index.m3u8              Master playlist
    {quality}/
        playlist.m3u8       Media playlist per quality
        segment-00001.ts    Fragments (.ts or .m4s; init.mp4 if fMP4)
    subtitles/{lang}/
        subtitle.m3u8
        segment-00001.vtt
```

Keyed per **upload**, not per episode (v1.1): an episode maps to 1..n uploads via
`episode_streams` (multi-angle), and replacement swaps the mapping instead of
overwriting files.

### 5.2 Access control — prefix-scoped signed token, validated at the edge

- The API issues a **stream token**: HMAC-SHA256-signed compact token binding `{pathPrefix: "episodes/{episodeID}/", exp}`. TTL **15 minutes** (single TTL; no separate fragment expiry).
- Clients request media from the CDN with `?token={token}`. A **Cloudflare Worker** validates signature + expiry + path prefix on every media request; on playlist responses it **rewrites relative URIs to append the token** so fragment requests made by AVPlayer carry it automatically. Invalid/expired → `403`.
- Long sessions: client refreshes the token (§5.3) and re-fetches the playlist. Objects in R2 remain static; the API server never serves or rewrites media.
- **Fallback (documented, not built):** if the Worker approach fails in practice, revert to the proposal's API-served, per-request-signed playlists (`GET /api/v1/episodes/{episodeID}/hls/{path}?expires&signature`).
- Purpose is deterrence of hotlinking/URL reuse, not DRM. Paid content in Phase 2 triggers re-evaluation (App Attest, per-user tokens, FairPlay).

### 5.3 Get stream URLs — `GET /api/v1/episodes/{episodeID}/stream` *(new; v1.1 multi-angle)*

Public read (app-key-gated). Response:
```json
{
  "episodeID": "string(UUID)",
  "streams": [ { "name": "string", "streamURL": "string(URL)" } ],
  "expiresAt": "string(ISO8601)"
}
```
One entry per camera angle, presentation order, at least one present; each
`streamURL` points at that angle's CDN master playlist with a fresh token.
Program detail embeds the same array in `episodes[].streams`; this endpoint
exists for cheap refresh without re-fetching the program.

### 5.4 Quality

`quality` enum (fixed): `uhd8k` | `uhd4k` | `hd`. Device-facing labels are the client's concern. ABR variant selection happens inside HLS as normal; the enum is used for upload declarations and future per-quality operations. A 16K-per-eye tier will be added as a new enum value when Apple Immersive Video support lands (deferred).

---

## 6. Catalog

Common: all public reads require `X-App-Key`. `viewer.*` fields always `false` in v1.

### 6.1 Get Program Details — `GET /api/v1/programs/{programID}?seasonNumber={n}`

If `seasonNumber` given, return only that season; else all seasons. Response:
```json
{
    "id": "string(UUID)", "title": "string", "description": "string",
    "thumbnailURL": "string(URL)",
    "genre": [{ "id": "string(UUID)", "name": "string" }],
    "createdAt": "string(ISO8601)", "updatedAt": "string(ISO8601)",
    "owner": { "did": "string", "handle": "string", "displayName": "string", "avatarURL": "string(URL)" },
    "viewer": { "isFollowing": false, "isFavorited": false },
    "season": [
        {
            "id": "string(UUID)", "number": "number", "title": "string", "description": "string",
            "episodes": [
                {
                    "id": "string(UUID)", "number": "number", "title": "string", "description": "string",
                    "durationSec": "number", "thumbnailURL": "string(URL) | null",
                    "streams": [ { "name": "string", "streamURL": "string(URL)" } ],
                    "publishedAt": "string(ISO8601)"
                }
            ]
        }
    ]
}
```

### 6.2 Programs by Genre — `GET /api/v1/genres/{genreID}/programs?limit&cursor`

Response: `{ "genreID", "total", "nextCursor", "programs": [ { "id", "title", "description", "thumbnailURL", "genre":[{"id","name"}], "updatedAt" } ] }`

### 6.3 Genre List — `GET /api/v1/genres`

Response: `{ "genres": [ { "id", "name", "description", "thumbnailURL", "programCount" } ] }`

### 6.4 Episode Search — `GET /api/v1/programs/{programID}/episodes/search?query&limit&cursor`

Postgres FTS + `pg_trgm`. Response: `{ "query", "programID", "total", "nextCursor", "episodes": [ { "id", "seasonNumber", "number", "title", "description", "durationSec", "thumbnailURL", "publishedAt" } ] }`

### 6.5 General Search — `GET /api/v1/search?query&limit&cursor`

Program match → program with all episodes, `matchedBy: "program"`. Episode-only match → program with only matching episodes, `matchedBy: "episode"`. Shape as per proposal.

---

## 7. Operator CMS (Bearer + `operator` role)

### 7.1 Create Programs and Episodes — `POST /api/v1/programs`

Request: title, description, genreIDs, thumbnailURL, nested season[] → episodes[] each carrying `streams: [{name, uploadID}]` (v1.1 multi-angle — 1..8 named angles, one upload each; index 0 is the default angle and defines `durationSec`). Every `uploadID` (from §8) must be `status=ready` and unattached → else `409 upload_not_ready` / `409 upload_already_attached`. Optional per-episode `thumbnailURL`. Response: full program (§6.1 shape).

### 7.2 Update — `POST /api/v1/programs/{programID}/update`

Partial update; omitted/null fields untouched; `episodes[]` entries partially update by `episodeID`; `streams` present → REPLACES the episode's full angle set (v1.1); each replacement upload must be validated `ready`. Response: full program.

### 7.3 Delete — `POST /api/v1/programs/{programID}/delete`, `POST /api/v1/episodes/{episodeID}/delete`

Request/response as per proposal (`targetType`, ids, `deleted`, `deletedAt`). Logical delete: excluded from all reads/search immediately; stream tokens stop being issued immediately (already-issued tokens die within ≤15 min); R2 objects retained 30 days, then physically deleted by the janitor. Program delete cascades to its episodes.

### 7.4 Upload Thumbnails — `POST /api/v1/uploads/images`

`multipart/form-data`, JPEG/PNG, ≤10 MB. (Thumbnails stay multipart-through-API — sizes don't justify presigning.) Response: `{ "imageID", "url", "byteSize", "width", "height" }`. Use `url` as `thumbnailURL`.

---

## 8. Video Upload Pipeline (final design)

### 8.1 Initiate — `POST /api/v1/uploads`

Request:
```json
{ "fileName": "string", "byteSize": "number", "checksum": "string(SHA-256)" }
```
Response:
```json
{
    "uploadID": "string(UUID)",
    "uploadURL": "string(URL)",
    "expiresAt": "string(ISO8601)",
    "status": "uploading"
}
```
`uploadURL` is a presigned R2 URL (multipart-capable, resumable). The API never proxies video bytes.

### 8.2 Complete — `POST /api/v1/uploads/{uploadID}/complete`

No body. Verifies the object exists and checksum matches → enqueues extraction; `status: queued`. Checksum mismatch → `failed: checksum_mismatch`.

### 8.3 Status — `GET /api/v1/uploads/{uploadID}`

```json
{
    "uploadID": "string(UUID)",
    "status": "string(uploading | queued | processing | ready | failed)",
    "playlistURL": "string(URL) | null",
    "durationSec": "number | null",
    "error": "string | null"
}
```
Client polls until `ready`/`failed`. No re-extraction per `uploadID`; on `failed`, start a new upload.

### 8.4 Extraction & validation (BullMQ worker; unchanged from proposal)

Pre-extraction, from the ZIP central directory:

| Item | Condition |
|---|---|
| Extensions | only `.m3u8` / `.ts` / `.m4s` / `.mp4` (init) / `.vtt` |
| Entry names | reject absolute paths, `..`, symlinks (Zip Slip) |
| File count | ≤ 5,000 |
| Extracted size | ≤ 10 GB, enforced cumulatively during extraction (ZIP bomb) |
| Required | exactly one master playlist `index.m3u8` |

Post-extraction: place under `media/episodes/{episodeID}/` (§5.1); verify master playlist exists and **every fragment referenced by every playlist is present**; subtitles verified via `EXT-X-MEDIA TYPE=SUBTITLES` entries ↔ actual files (one track per language, BCP 47 dir names, no WebVTT position attributes — display position is client-controlled). Any missing reference → `failed`, extracted files deleted. Success → `ready`, `playlistURL` + computed `durationSec` set. Temp ZIP deleted on success, and after 7 days on failure.

### 8.5 Janitor (scheduled job)

Deletes: unattached `ready` uploads after 14 days; orphan thumbnails after 14 days; soft-deleted media after 30 days; expired temp objects.

---

## 9. Metrics — `POST /api/v1/metrics/playback` *(new)*

Public (app-key-gated), fire-and-forget, `202 Accepted` always (invalid payloads dropped server-side). Request:
```json
{
    "episodeID": "string(UUID)",
    "event": "string(start | progress | complete | error)",
    "positionSec": "number",
    "quality": "string | null",
    "sessionUUID": "string(UUID)"
}
```
`sessionUUID` is a client-generated anonymous per-playback id (no user identity in v1). Stored append-only; consumed by Phase-2 analytics. Without this, Phase-2 dashboards start from an empty dataset.

---

## 10. Data Model (Postgres, outline)

```
accounts(id uuidv7 PK, did unique, handle unique, email unique, display_name, description,
         avatar_url, password_hash, role enum(operator|creator|user), email_verified_at,
         created_at, updated_at, deleted_at)
sessions(id PK, account_id FK, refresh_hash unique, chain_id, device_info, issued_at,
         last_used_at, revoked_at)
genres(id PK, name, description, thumbnail_url, created_at, updated_at, deleted_at)
programs(id PK, owner_account_id FK, title, description, thumbnail_url,
         created_at, updated_at, deleted_at)
program_genres(program_id FK, genre_id FK, PK(program_id, genre_id))
seasons(id PK, program_id FK, number, title, description, unique(program_id, number))
episodes(id PK, season_id FK, number, title, description, duration_sec, thumbnail_url,
         published_at, created_at, updated_at, deleted_at,
         unique(season_id, number))
episode_streams(id PK, episode_id FK cascade, name, upload_id FK unique, sort_order,
         unique(episode_id, name))   -- v1.1 multi-angle: 1..n named angles per episode
uploads(id PK, r2_key, byte_size, checksum, status enum, error, playlist_key,
        duration_sec, created_by FK, created_at, updated_at)
images(id PK, r2_key, url, byte_size, width, height, created_by FK, created_at)
playback_events(id PK, episode_id, event, position_sec, quality, session_uuid, created_at)
    -- append-only, partitioned by month
```

Search: generated `tsvector` columns on programs/episodes (title + description) + `pg_trgm` GIN indexes.

---

## 11. Operations & Non-Functional

- **Environments:** `staging` and `production`, separate R2 buckets/DBs/app keys. CI deploys `main` → staging automatically; production by tagged release.
- **Backups:** managed Postgres daily snapshot + PITR; R2 is the media source of truth (originals ZIP retained per §8; no second copy in v1 — accepted risk, revisit with revenue).
- **Logging/observability:** structured JSON logs (Fastify pino) with request IDs; error tracking (Sentry); worker job outcomes logged with `uploadID`. Basic dashboards: request rate/latency, 4xx/5xx, queue depth, extraction failures.
- **Secrets:** platform secret store; JWT signing keys rotatable via `kid`; app key rotatable (two active keys accepted during client rollout windows).
- **Token storage (client):** Keychain on Apple platforms. HTTPS only, HSTS at the edge.

---

## 12. Deferred (Phase 2+) — endpoint shapes preserved from the proposal, not implemented in v1

- **Comments / live comments** (with `playbackSec`), delete, report + moderation review flow
- **Likes** (program/episode), like lists
- **Follows**, `viewer.isFollowing`
- **Tips/donations** — blocked on payment-method, Funds Settlement Act review, distribution design
- **Monetization** (subscription / single-title purchase) — arrives with accounts; store-policy (IAP) analysis required
- **Settings** (`GET/POST /api/v1/settings`) — needs end-user accounts
- **Episode download / offline** — JSON file-manifest form (not ZIP); requires DRM posture decision
- **Public registration + email provider wiring**
- **Apple Immersive Video 16K/eye tier**; tile/viewport-adaptive delivery evaluation
- **Direct upload + server-side HLS conversion** (macOS conversion worker, chunked/resumable upload, `uploading`/`converting` statuses, subtitle conversion `.srt`/`.itt` → WebVTT)
- **App Attest / Play Integrity**, per-user media tokens, FairPlay evaluation — triggered by paid content

---

## 13. Immediate next steps

1. **Week 1:** repo + `openapi.yaml` for every v1 endpoint above; mock server generated with fixture data (1 program / 2 seasons / 6 episodes) → **hand to Kei-chan & Kayane**; contract freeze after their pass.
2. Confirm the open monetization question with Yuta (does not block implementation).
3. Implementation order: M1 skeleton+auth → M2 catalog+CMS → M3 upload pipeline → M4 delivery/Worker → M5 hardening. Real MV-HEVC footage through §8 as early as it exists.
