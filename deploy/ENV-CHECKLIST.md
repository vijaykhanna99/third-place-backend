# Environment checklist

`src/config/env.ts` validates everything at boot. Under `NODE_ENV=production` the **API**
refuses to start unless every row marked **required** is set; the migrator, CLI and worker
check only what they use. Generate secrets with `openssl rand -hex 32`.

## API and worker (`.env.production`)

| Variable | Required (API) | Used by | Value / how to get it |
|---|---|---|---|
| `NODE_ENV` | yes (`production`) | all | enables the strict checks and JSON logs |
| `HOST`, `PORT` | no | API | `0.0.0.0` / `3000` inside the container (compose sets them) |
| `LOG_LEVEL` | no | all | `info` in production |
| `DATABASE_URL` | **yes** | API, worker, migrate, CLI | managed Postgres 16, `?sslmode=require`; the role must be allowed to `CREATE EXTENSION pg_trgm` for the first migration |
| `REDIS_URL` | **yes** | API, worker | managed Redis 7 (`rediss://` when TLS); used for the job queue, rate limiting and the login limiter |
| `JWT_SIGNING_KEY` | **yes** | API | ≥ 32 chars; `openssl rand -hex 32`. Changing it logs every operator out (refresh tokens survive, access tokens do not) |
| `JWT_KID` | no | API | key id in token headers; bump when rotating the signing key |
| `ACCESS_TOKEN_TTL_SEC` / `REFRESH_TOKEN_TTL_DAYS` | no | API | defaults 900 / 30 (spec §4) |
| `TRUSTED_PROXIES` | no, but **set it behind any proxy** | API | hop count (`1` behind Caddy) or CIDR list of the proxy/LB. Wrong value → every client shares one rate-limit bucket (too low) or can spoof addresses (too high). Never `true` |
| `APP_KEYS` | **yes** | API | comma-separated; `openssl rand -hex 24` each; the apps embed one; keep two during a client rollout |
| `QUEUE_PREFIX` | no | API, worker | namespace for queue keys when several deployments share a Redis (`staging` / `prod`) |
| `JANITOR_INTERVAL_MS` | no | worker | hourly by default; `0` disables the schedule (then run `cli janitor:run` from cron) |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | no | worker | default 25000; the orchestrator's stop grace period must be longer (compose: 40 s) |
| `UPLOAD_MAX_ENTRY_BYTES` | no | worker | per-file cap inside an archive, default 2 GiB |
| `UPLOAD_STUCK_AFTER_MS` | no | worker | default 30 min before a `processing` upload is reclaimed |
| `SCRATCH_DIR` | no | worker | compose sets `/scratch` (a volume); must hold two archives at the 5 GiB cap |
| `R2_ACCOUNT_ID` or `R2_ENDPOINT` | **one of them** | API, worker | account id from the Cloudflare dashboard (R2 → Overview); the endpoint is derived. `R2_ENDPOINT` is for MinIO/S3-compatible stand-ins |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | **yes** | API, worker | an R2 API token with Object Read & Write on the media bucket only (`WORKER.md`) |
| `R2_BUCKET_MEDIA` | **yes** | API, worker | `tplace-media-staging` / `tplace-media-prod` |
| `STREAM_TOKEN_SECRET` | **yes** | API | ≥ 32 chars; **identical** to the Worker's secret |
| `STREAM_TOKEN_TTL_SEC` | no | API | 900 (spec §5.2). Longer = fewer mid-playback refreshes in the app, weaker hotlink deterrence |
| `MEDIA_BASE_URL` | **yes** | API | the Worker's public origin, e.g. `https://media.3rd-place.co.jp` (no trailing slash) |

Also in `.env.production` for compose only: `IMAGE` (container image tag) and `API_DOMAIN`
(Caddy's certificate domain).

## Edge Worker (`wrangler secret put …`, per environment)

| Name | Required | Value |
|---|---|---|
| `STREAM_TOKEN_SECRET` | **yes** | same as the API |
| `STREAM_TOKEN_SECRET_PREVIOUS` | during rotation only | the previous value, removed after 15 minutes |
| `APP_KEYS` | only with `REQUIRE_APP_KEY_FOR_PLAYLISTS=true` | same list as the API |
| `MEDIA` (R2 binding) | yes | bucket name per environment in `wrangler.toml` |

## visionOS app (`visionos-app/Config/Release.xcconfig`)

| Setting | Value |
|---|---|
| `API_BASE_URL` | `https://<API_DOMAIN>` |
| `APP_KEY` | one of the API's `APP_KEYS` |
| `MEDIA_ORIGIN` | `MEDIA_BASE_URL` (informational; stream URLs come from the API) |

## Staging vs production

Separate everything (spec §11): database, Redis (or at least `QUEUE_PREFIX`), R2 bucket,
Worker deployment, `APP_KEYS`, `JWT_SIGNING_KEY`, `STREAM_TOKEN_SECRET`. The only shared
artefact is the container image, promoted by tag.
