# Runbook

Operational procedures for the API, the worker and the media edge. Commands assume the
compose stack in this directory; adapt the service names for another platform.

## Deploy a new version

1. CI is green on `main` (typecheck, lint, contract lint, 228 API tests, Worker tests, image build).
2. Build/publish the image and set `IMAGE=<registry>/third-place-backend:<sha>` in `.env.production`.
3. `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production pull`
4. `docker compose … up -d` — `migrate` applies pending migrations and exits, `api` restarts
   once ready (`/readyz`), `worker` restarts after draining (≤ 25 s) or forcing in-flight jobs,
   which BullMQ redelivers; a redelivered upload is reclaimed by the stuck-row logic.
5. Verify: `curl -s https://$API_DOMAIN/healthz` → `{"status":"ok"…}`; `docker compose … logs -f worker`
   shows `extraction worker started`.
6. Worker (edge): `cd edge-worker && pnpm deploy` only when `edge-worker/` changed.

Migrations are forward-only. Review the SQL before any release that adds one. **Never** let
drizzle-kit touch `playback_events` (partitioned by hand in migration 0001).

## Roll back

Set `IMAGE` to the previous tag and `up -d` again. Migrations in this project add columns
and tables without dropping; the previous image runs fine against a newer schema. If a
release ever ships a destructive migration, its rollback must be written and tested with it.

## Smoke test (after any deploy)

```bash
API=https://$API_DOMAIN
curl -s $API/healthz | jq .                       # status ok, checks db/redis ok
curl -s -o /dev/null -w '%{http_code}\n' $API/readyz   # 200
curl -s -o /dev/null -w '%{http_code}\n' $API/api/v1/genres          # 403 (no app key)
curl -s -H "X-App-Key: $APP_KEY" $API/api/v1/genres | jq '.genres | length'
# operator flow
TOKEN=$(curl -s -X POST $API/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"identifier":"ops","password":"…"}' | jq -r .accessToken)
curl -s -H "Authorization: Bearer $TOKEN" -X POST $API/api/v1/uploads -H 'content-type: application/json' \
  -d '{"fileName":"smoke.zip","byteSize":1,"checksum":"'$(printf a | sha256sum | cut -d" " -f1)'"}' | jq .
```

Then the media smoke test in `WORKER.md` §4 and a playback in the app.

## First operator account

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production \
  run --rm api node dist/cli/index.js operator:create --handle ops --email ops@3rd-place.co.jp
```
The password is printed once (or set `OPERATOR_PASSWORD` in the environment of that command).
Registration through the API is closed in v1 (spec §3).

## Rotations

| Secret | Procedure | Effect |
|---|---|---|
| `APP_KEYS` | add the new key to the list, ship the client build with it, remove the old key after the rollout | none for clients carrying either key |
| `STREAM_TOKEN_SECRET` | `WORKER.md` §5 (Worker first, with PREVIOUS; then API; drop PREVIOUS after 15 min) | none when ordered correctly |
| `JWT_SIGNING_KEY` | set the new key and bump `JWT_KID`, restart the API | every operator's access token is rejected until refreshed (refresh tokens are unaffected: they are opaque DB rows) |
| R2 credentials | create the new token, set `R2_*`, restart API and worker, delete the old token | in-flight presigned PUTs signed with the old credentials fail — rotate between uploads |
| Database / Redis passwords | update URLs, restart | brief unavailability; the login limiter and rate limiter degrade to in-process buckets while Redis is unreachable |

## Monitoring signals

- `/healthz` `status: degraded` → a dependency is down; the process is fine. `/readyz` 503 pulls the
  instance from rotation (Caddy/LB health check).
- Logs are JSON (pino). Alert on:
  - `"redis connection down"` (API or queue clients)
  - `"storage head failed during complete"`, `"extraction enqueue failed"` → operators see 503s
  - `"upload extraction failed"` with `code` not in the operator-error set (`extraction_error`,
    `stuck_processing`) → infrastructure problem
  - `"rollback failed: published objects may be orphaned"` → run `cli janitor:run`, then inspect the prefix
  - `"stuck upload requeued"` / `"stuck upload failed"` → a worker died mid-extraction; check memory limits
  - `"playback_events_default holds rows"` → partition missing (below)
  - `"public rate limiter degraded"`
- Queue depth: `redis-cli -u $REDIS_URL LLEN "$QUEUE_PREFIX:upload-extraction:wait"`.
- Disk: the worker's scratch volume; `insufficient scratch space` in logs means archives cannot be downloaded.

## Incidents

**Redis down.** Public reads keep working (rate limiter in-process), logins keep working
(limiter in-process), `POST /uploads/{id}/complete` answers 503 until it returns (upload stays
`uploading`; the operator retries). Extraction pauses; BullMQ resumes on reconnect.

**R2 down.** `complete` answers 503; extraction attempts fail transiently and are retried
(3 attempts, exponential backoff); the edge Worker answers 404/5xx for media. Nothing to do but wait.

**Worker OOM / killed mid-extraction.** The row stays `processing` for `UPLOAD_STUCK_AFTER_MS`
(30 min), then the sweep requeues it (twice at most, then `failed: stuck_processing`). The
startup scratch sweep clears leftover archives. If it recurs, raise the worker's memory limit —
entries stream through 8 MiB multipart parts, so memory is dominated by Node itself plus the
text entries (≤ 16 MiB each).

**Uploads stuck in `queued`.** Either no worker is running (start it) or the job is in the
failed set: `redis-cli … ZRANGE "$QUEUE_PREFIX:upload-extraction:failed" 0 -1`. Re-queue by
calling `complete` is not possible (status is no longer `uploading`); ask the operator to start
a new upload, or requeue manually with a one-off script using `createExtractionQueue`.

**`playback_events_default` holds rows.** A month arrived without its partition (the janitor
creates two months ahead; this means it did not run). Create the partition by hand following
the recovery block in `src/db/migrations/0001_search-and-partitioning.sql`, then make sure the
worker (and its janitor schedule) is running.

**Stream tokens rejected everywhere (403 `invalid_token`).** The API and Worker secrets differ.
Compare `wrangler secret list` with the API's `STREAM_TOKEN_SECRET`; redeploy whichever is wrong.
During a rotation, `STREAM_TOKEN_SECRET_PREVIOUS` must hold the old value.

**Operators locked out (429 on login).** 5 failures per account per 15 minutes or 20 per IP.
Wait, or delete the Redis keys `login:fail:acct:<id>` / `login:fail:ip:<ip>`.

## Backups and retention

- Postgres: managed daily snapshots + PITR (spec §11). Test a restore into staging quarterly.
- R2: source of truth for media; no second copy in v1 (accepted risk). The original archives
  are kept 7 days after a failed extraction only.
- Janitor retention: temp archives 7 days, never-attached uploads 14 days, detached media 30
  days, orphan thumbnails 14 days (`src/jobs/README.md`).
