# Third Place Backend

Backend API server for the Third Place immersive video platform (MV-HEVC / Apple Vision Pro).
Spec: [`third-place-app-backend-server-specification-v1-FINAL.md`](third-place-app-backend-server-specification-v1-FINAL.md).

**Local development only for now — not deployed anywhere yet.**

## Stack

TypeScript · Node.js (≥22) · Fastify · PostgreSQL 16 + Drizzle · Redis + BullMQ · Cloudflare R2 + edge Worker

## Getting started

```bash
pnpm install
cp .env.example .env
colima start      # this Mac runs Docker via colima
pnpm db:up        # starts Postgres (host port 5433), Redis and MinIO in Docker
pnpm db:migrate   # applies src/db/migrations
pnpm dev          # API on http://127.0.0.1:3000
pnpm worker       # upload extraction worker (separate process)
curl http://127.0.0.1:3000/healthz
```

Postgres maps to host port **5433** (a native Postgres occupies 5432 on this machine).

## Database

- Schema: `src/db/schema/` (Drizzle). Migrations: `src/db/migrations/`.
- `pnpm db:generate` diffs schema → new migration; **review the SQL before applying.**
- Migration `0001` is hand-written (pg_trgm, generated tsvector `search` columns,
  `playback_events` monthly partitioning). Never ALTER `playback_events` via drizzle-kit.
- Integration tests run only when `TEST_DATABASE_URL` is set (upload tests also need
  `TEST_REDIS_URL` and `TEST_S3_ENDPOINT`):
  `TEST_DATABASE_URL=postgres://tplace:tplace@localhost:5433/tplace TEST_REDIS_URL=redis://localhost:6379 TEST_S3_ENDPOINT=http://127.0.0.1:9000 pnpm test`
- Integration tests clean up after themselves in foreign-key order and enqueue their
  jobs under a private Redis key prefix (`QUEUE_PREFIX`), which they remove afterwards —
  a `pnpm worker` running against the same Redis never sees test jobs.
- Responses in the integration suites are validated against `openapi.yaml`
  (`test/helpers/contract.ts`), so server/contract drift fails the build.

Checks: `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm api:lint`
Edge Worker (separate package): `cd edge-worker && pnpm install && pnpm typecheck && pnpm test`

## Configuration

`src/config/env.ts` validates every variable at boot (see `.env.example`). In development
and tests any dependency may be omitted and the routes that need it are simply not
registered. Under `NODE_ENV=production` the API refuses to start unless `DATABASE_URL`,
`REDIS_URL`, `JWT_SIGNING_KEY`, `APP_KEYS`, `MEDIA_BASE_URL` and the `R2_*` set are present.
The migrator, the operator CLI and the worker check only what they themselves need.

`JANITOR_INTERVAL_MS` schedules the janitor in the worker process (default hourly, `0` to
disable); `pnpm cli janitor:run` runs one sweep on demand. `QUEUE_PREFIX` namespaces the
job queues' Redis keys.

Health: `GET /healthz` is liveness (always 200 while the process runs; `degraded` on a
dependency outage) and `GET /readyz` is readiness (503 until every configured dependency
answers). Public reads are rate limited to 60 requests/minute per client IP (Redis-backed,
`TRUSTED_PROXIES` decides which `X-Forwarded-For` hops to believe).

`MEDIA_BASE_URL` is the public media origin. Storage keys carry a `media/` prefix
(`media/uploads/{uploadID}/…`); public URLs do not (`/uploads/{uploadID}/…`). In production
the edge Worker maps one onto the other; locally the base URL points at the bucket's
`media/` folder so the same public paths resolve directly against MinIO.

## CI and container image

- `.github/workflows/ci.yml` runs typecheck, lint, the contract lint, the full test
  suite (Postgres and Redis as service containers, MinIO as a container step) and the
  production build on every push and pull request, then builds the container image.
- `Dockerfile` is a multi-stage build producing one image for the API and the worker:

```bash
docker build -t third-place-backend .
docker run --env-file .env -p 3000:3000 third-place-backend                          # API
docker run --env-file .env third-place-backend node dist/jobs/worker.js             # worker
docker run --env-file .env third-place-backend node dist/db/migrate.js              # migrations
```

## API contract

`openapi.yaml` (repo root) is the single source of truth for the v1 API surface.

```bash
pnpm api:lint   # validate the contract (Redocly, zero warnings policy)
pnpm mock       # mock server on http://127.0.0.1:4010 serving fixture data (Prism)
pnpm api:docs   # browsable HTML docs → docs/api.html
```

The mock serves a canonical fixture universe (1 program "Neon Nights — Immersive Live",
2 seasons, 6 episodes, genre "Music") from the contract's examples — this is what the
client team builds against until the real API lands.

## Layout

```
src/
  index.ts          Entrypoint: env load, listen, graceful shutdown
  app.ts            Fastify app builder (used by tests via inject)
  config/env.ts     Zod-validated environment config — fails fast at boot
  plugins/          Cross-cutting Fastify plugins (error handler, auth, app-key gate)
  routes/           Non-module routes (healthz)
  lib/              Shared helpers (AppError + error catalog, pagination, R2 storage, ZIP/HLS validation)
  modules/          One folder per API domain — auth, account, catalog, media, uploads, metrics
  db/               Drizzle schema + migrations (step 3)
  jobs/             BullMQ worker: ZIP extraction + janitor sweep (see jobs/README.md)
  cli/              Operator tooling, e.g. operator:create (step 4)
edge-worker/        Cloudflare Worker: stream-token validation, playlist token propagation, R2 origin (own package, see its README)
openapi.yaml        The API contract, source of truth — repo root per spec §1 (step 2)
test/               Vitest suites (unit + integration against the Docker services)
```

## Build steps (each reported before the next starts)

| Step | Scope | Status |
|---|---|---|
| 1 | Skeleton: structure, config, error shape, healthz, docker-compose, tests | ✅ done |
| 2 | OpenAPI 3.1 contract for the full v1 surface + fixture data | ✅ done |
| 3 | Drizzle schema + migrations; DB/Redis clients wired into healthz | ✅ done |
| 4 | Auth: JWT + refresh rotation, Argon2id, sessions, operator seed CLI | ✅ done |
| 5 | Catalog: programs/seasons/episodes/genres, search (Postgres FTS), app-key gate | ✅ done |
| 5.5 | Client-review revisions: multi-angle `streams[]` per episode, episode thumbnails in detail, program `viewCount` | ✅ done |
| 6 | Uploads: presigned R2 flow, extraction worker + ZIP validation, thumbnails | ✅ done |
| 6.5 | Upload pipeline review fixes: retryable extraction with atomic claims, stuck-upload recovery, streamed entries with per-entry caps, bounded shutdown and scratch hygiene, subtitle/I-frame/nested-master validation, contract fixes, test isolation, CI + container build | ✅ done |
| 7 | Delivery: stream tokens, edge Worker, quality enum | ✅ done |
| 8 | Metrics endpoint, janitor job, rate limiting, hardening pass (helmet, body limits, readiness probe) | ✅ done |
