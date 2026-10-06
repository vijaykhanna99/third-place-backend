# Deployment (step 10 — preparation only)

Nothing in this directory has been deployed anywhere. It is the complete set of artefacts
and decisions needed to stand up **staging** and **production** once accounts exist
(spec §11). Read in this order:

| File | Purpose |
|---|---|
| `ENV-CHECKLIST.md` | every variable the API, worker and Worker need, how to generate each, what is required where |
| `docker-compose.prod.yml` + `Caddyfile` | one-host deployment: migrate → API → worker behind Caddy (automatic TLS) |
| `env.production.example` | template for the compose stack's `.env.production` (never commit the real one) |
| `WORKER.md` | Cloudflare side: R2 buckets, S3 credentials, Worker secrets, custom domain, smoke test |
| `RUNBOOK.md` | deploy / rollback / rotate / incident procedures, monitoring signals, backups |

## What the system needs

| Component | Choice (spec §1/§11) | Notes |
|---|---|---|
| API (`node dist/index.js`) | container from the root `Dockerfile` | stateless; scale horizontally; needs Postgres, Redis, R2 credentials |
| Worker process (`node dist/jobs/worker.js`) | same image, different command | **one or two instances**; needs a scratch volume ≥ 2 × the largest archive (5 GiB cap → 10–20 GiB) |
| PostgreSQL 16 | managed, daily snapshots + PITR | `pg_trgm` must be allowed (`CREATE EXTENSION` runs in migration 0001) |
| Redis 7 | managed or container | job queue + rate limiting + login limiter; small |
| Cloudflare R2 | two buckets: `tplace-media-staging`, `tplace-media-prod` | media source of truth; no second copy in v1 (accepted risk) |
| Cloudflare Worker | `edge-worker/`, one deployment per environment | public media origin (`MEDIA_BASE_URL`) |
| TLS / edge for the API | Caddy in the compose stack, or the platform's load balancer | set `TRUSTED_PROXIES` to the hop(s) in front of the API |

## Hosting options for the API + worker

The code is platform-neutral (plain container, env configuration, `/healthz` liveness and
`/readyz` readiness). Three reasonable shapes for a v1 launch:

1. **Single VM with Docker Compose** (`docker-compose.prod.yml`): one small VM per
   environment (e.g. 2 vCPU / 4 GB for the API+worker, more RAM if several multi-GB
   extractions must run at once), managed Postgres and Redis from the same cloud, Caddy for
   TLS. Cheapest and simplest to reason about; the worker's scratch disk is just a volume.
   Scaling means a bigger VM. Good fit for an archive-only launch with operator-driven uploads.
2. **Container platform** (Fly.io, Railway, Render, Google Cloud Run + a Compute VM for the
   worker): the API deploys as a web service from the Dockerfile with `/readyz` as the health
   check; the worker as a background service with a persistent volume. Managed Postgres/Redis
   add-ons. Less to operate, slightly more per month, and the worker's scratch volume and
   graceful-shutdown window (`stop_grace_period` ≥ 40 s) must be configurable — check this
   before choosing (Cloud Run is a poor fit for the worker: no persistent disk, request-driven).
3. **Kubernetes / ECS**: only if the company already runs one. Nothing here needs it.

Recommendation for v1: option 1 for staging immediately; option 1 or 2 for production
depending on who is on call. Either way R2 + the Worker are fixed by Decision D4.

## Rollout order (first time)

1. Cloudflare: buckets, S3 credentials, Worker secrets, custom domain (`WORKER.md`).
2. Managed Postgres + Redis; note the URLs.
3. Fill `.env.production` from `env.production.example` (`ENV-CHECKLIST.md`).
4. Build and push the image (see "Image" below), `docker compose -f deploy/docker-compose.prod.yml up -d`
   — `migrate` runs once and exits, then `api` and `worker` start.
5. Create the first operator: `docker compose … run --rm api node dist/cli/index.js operator:create --handle ops --email …`
6. Smoke test (`RUNBOOK.md` → "Smoke test") and point the apps' `API_BASE_URL` at it.

## Image

CI builds the image on every push but does not publish it (no registry account exists yet).
The workflow contains a `publish` job that pushes to GitHub Container Registry on `main`
**only when the repository variable `PUBLISH_IMAGE` is set to `true`** — flip it when ready
and set `IMAGE` in `.env.production` to `ghcr.io/<owner>/third-place-backend:<sha>`. Until
then build locally: `docker build -t third-place-backend:local .` and set `IMAGE` to that tag.
