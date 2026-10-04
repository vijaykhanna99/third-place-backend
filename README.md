# Third Place Backend

Backend API server for the Third Place immersive video platform (MV-HEVC / Apple Vision Pro).
Spec: `~/Downloads/third-place-app-backend-server-specification-v1-FINAL.md`.

**Local development only for now — no git repo, nothing pushed anywhere.**

## Stack

TypeScript · Node.js (≥22) · Fastify · PostgreSQL 16 + Drizzle · Redis + BullMQ · Cloudflare R2 + edge Worker

## Getting started

```bash
pnpm install
cp .env.example .env
colima start      # this Mac runs Docker via colima
pnpm db:up        # starts Postgres (host port 5433) + Redis in Docker
pnpm db:migrate   # applies src/db/migrations
pnpm dev          # API on http://127.0.0.1:3000
curl http://127.0.0.1:3000/healthz
```

Postgres maps to host port **5433** (a native Postgres occupies 5432 on this machine).

## Database

- Schema: `src/db/schema/` (Drizzle). Migrations: `src/db/migrations/`.
- `pnpm db:generate` diffs schema → new migration; **review the SQL before applying.**
- Migration `0001` is hand-written (pg_trgm, generated tsvector `search` columns,
  `playback_events` monthly partitioning). Never ALTER `playback_events` via drizzle-kit.
- Integration tests run only when `TEST_DATABASE_URL` is set:
  `TEST_DATABASE_URL=postgres://tplace:tplace@localhost:5433/tplace TEST_REDIS_URL=redis://localhost:6379 pnpm test`

Checks: `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm api:lint`

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
  plugins/          Cross-cutting Fastify plugins (error handler; later: app-key gate, auth)
  routes/           Non-module routes (healthz)
  lib/              Shared helpers (AppError + error catalog; later: tokens, R2, pagination)
  modules/          One folder per API domain — auth, account, catalog, media, uploads, metrics
  db/               Drizzle schema + migrations (step 3)
  jobs/             BullMQ workers: ZIP extraction, janitor (step 6)
  cli/              Operator tooling, e.g. operator:create (step 4)
edge-worker/        Cloudflare Worker: stream-token validation + playlist rewrite (step 7)
openapi.yaml        The API contract, source of truth — repo root per spec §1 (step 2)
test/               Vitest suites (app.inject, no network)
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
| 7 | Delivery: stream tokens, edge Worker, quality enum | pending |
| 8 | Metrics endpoint, janitor job, rate limiting, hardening pass | pending |
