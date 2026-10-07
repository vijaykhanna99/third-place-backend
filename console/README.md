# Third Place Console

Operator web console for the Third Place immersive video platform. It talks to the
[backend API](../README.md) over its OpenAPI v1 contract and lets operators
browse the catalog, create programs with multi-angle episodes (one HLS ZIP per camera
angle, pushed straight to object storage through presigned URLs), edit and delete
programs and episodes, and manage their own account and sessions. It also serves the
two public pages linked from viewer emails: email verification and password reset.

Stack: pnpm · Vite 6 · React 18 · TypeScript (strict) · react-router v6 · hand-written
CSS (light/dark, down to 360 px) · vitest + Testing Library + msw · Playwright · nginx image.

## Where it lives

The console is a self-contained project (own `package.json`, lockfile, tests, Dockerfile and
a ready-to-use workflow in `.github/workflows/ci.yml`) kept in the backend repository under
`console/` for now; the backend's CI runs its checks as the `console` job. To move it into
its own repository later: `git subtree split --prefix console -b console-main` and push that
branch — nothing inside needs to change except the contract sync path, which already accepts
a sibling `third-place-backend` checkout.

## Configuration

The bundle is configured at **runtime**, not at build time: `index.html` loads
`/config.js` before the application, and that file assigns `window.__TP_CONFIG__`:

```js
window.__TP_CONFIG__ = {
  apiBaseURL: "http://127.0.0.1:3000", // backend origin, no trailing slash, no /api/v1
  appKey: "dev-app-key",               // one of the backend's APP_KEYS (sent as X-App-Key)
};
```

- Local development: edit `public/config.js` (the checked-in file points at
  `http://127.0.0.1:3000`). See `config.example.js` for the documented shape.
- Container: the entrypoint writes `/usr/share/nginx/html/config.js` from the
  `API_BASE_URL` and `APP_KEY` environment variables when the container starts.

`src/config.ts` validates the object on start-up and renders a configuration error page
instead of the app when something is missing.

## Running locally against the backend

1. Start the backend on `http://127.0.0.1:3000` (API and the upload worker) with
   `CORS_ORIGINS=http://127.0.0.1:5173` in its environment — the backend keeps CORS closed
   unless the console's exact origin is listed. Set `ACCOUNT_LINKS_BASE_URL` to the
   console's origin as well so the emailed verification and reset links open here.
2. Make sure `public/config.js` carries one of the backend's `APP_KEYS`.
3. Install and run:

```bash
pnpm install
pnpm dev          # http://127.0.0.1:5173
```

Sign in with an operator account created by the backend's `operator:create` CLI.

### Storage bucket CORS (presigned uploads)

Camera-angle archives never pass through the API: the browser `PUT`s them straight to the
presigned URL returned by `POST /api/v1/uploads`. The storage bucket therefore has to
allow a cross-origin `PUT` from the console's origin.

- **MinIO** (the backend's local `docker-compose`) allows this by default — nothing to do.
- **Cloudflare R2** needs a bucket CORS policy. Apply `deploy/r2-cors-policy.json`
  (Cloudflare dashboard → R2 → bucket → Settings → CORS policy, or
  `wrangler r2 bucket cors put <bucket> --file deploy/r2-cors-policy.json`), replacing the
  origins with the console's real origin(s):

```json
[
  {
    "AllowedOrigins": ["https://console.example.com", "http://127.0.0.1:5173"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "Content-Length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

A `PUT` blocked by CORS surfaces in the upload card as "Storage upload failed — check the
bucket's CORS policy allows PUT from this origin".

### How an angle upload works

1. The browser hashes the ZIP with a streaming SHA-256 in a Web Worker (`hash-wasm`, 8 MiB
   slices), so archives up to the API's 5 GiB cap never sit in memory as one buffer.
2. `POST /api/v1/uploads` `{fileName, byteSize, checksum}` → `{uploadID, uploadURL}`.
3. `PUT uploadURL` with the file as the body (XMLHttpRequest, so progress is visible);
   the presigned URL pins `Content-Length` to the declared size.
4. `POST /api/v1/uploads/{uploadID}/complete` → `queued`, then `GET /api/v1/uploads/{uploadID}`
   is polled until `ready` or `failed`. A failure carries the worker's `code: detail`
   string and is shown on the card.
5. The program can be created once every angle of every episode is `ready`.

An angle can also reference an existing `uploadID` (a ready upload that is not attached
yet). Editing an episode's angle set replaces it as a whole, as the contract specifies.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Vite dev server on `http://127.0.0.1:5173` |
| `pnpm build` | Typecheck + production bundle in `dist/` |
| `pnpm preview` | Serve `dist/` on `http://127.0.0.1:4173` |
| `pnpm typecheck` | `tsc --noEmit` for the app and the Node-side files |
| `pnpm lint` | ESLint (typescript-eslint strict, react-hooks), zero warnings |
| `pnpm test` | vitest unit/component tests (API client, upload machine, draft validation, login, wizard) |
| `pnpm test:e2e` | Playwright against the built bundle and the in-memory mock API |
| `pnpm contract:sync` | Copy the backend's `openapi.yaml` (one directory up, or a sibling checkout) into `contract/` |
| `pnpm contract:types` | Regenerate `src/api/schema.d.ts` from `contract/openapi.yaml` (`openapi-typescript`) |

Every request/response type the app uses comes from the generated `src/api/schema.d.ts`
(`src/api/types.ts` only aliases it). After a contract change run `pnpm contract:sync &&
pnpm contract:types`; CI fails when the generated file is stale.

### End-to-end tests

`e2e/mock-api.mjs` is a small Node server that implements the operator flow in memory
(login with rotating refresh tokens, sessions, account, catalog reads behind `X-App-Key`,
program CMS writes, the presigned upload handshake including the storage `PUT` target,
and the public verify/reset endpoints) with CORS open. Playwright starts it on `:4100`
together with `vite preview` on `:4173`, and intercepts `/config.js` so the bundle points
at the mock. The browser hashes and uploads real (tiny) ZIP archives built in the test.

Browsers: `pnpm exec playwright install chromium` once, or point
`PLAYWRIGHT_BROWSERS_PATH` at an existing Playwright browser cache. To launch a specific
Chromium binary set `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome`.

## Deploying with Docker

```bash
docker build -t third-place-console .
docker run -p 8080:80 \
  -e API_BASE_URL=https://api.example.com \
  -e APP_KEY=... \
  third-place-console
```

The image is `nginx:alpine` serving `dist/` with SPA fallback (`deploy/nginx.conf`:
immutable caching for hashed assets, `no-store` for `config.js`, `/healthz`).
`deploy/docker-compose.yml` shows the service next to the backend stack. Remember to add
the console's public origin to the backend's `CORS_ORIGINS` and to the bucket CORS policy.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: install, generated-types
freshness, typecheck, lint, unit tests, build, Playwright e2e (Chromium installed in CI),
then builds the Docker image without pushing it.

## Layout

```
contract/openapi.yaml       Copy of the backend contract (source for the generated types)
public/config.js            Runtime configuration for local development
config.example.js           Documented configuration shape
src/
  main.tsx                  Entry: validates config, mounts the app
  App.tsx                   Routes (public pages, login, guarded console)
  config.ts                 window.__TP_CONFIG__ validation
  api/                      Generated schema types, aliases, fetch client (auto-refresh), endpoints
  auth/                     Token store (access in memory, refresh in localStorage), provider, route guard
  upload/                   SHA-256 worker, XHR PUT with progress, upload state machine and runner
  programs/draft.ts         Program/season/episode/angle draft structure and validation
  components/               Layout, forms, banners, angle editor, upload card, dialogs
  pages/                    Login, Dashboard, New program wizard, Program editor, Account, Verify email, Reset password
  test/                     vitest setup, msw server, render helper
e2e/                        Mock API server, Playwright specs and helpers (in-memory ZIP builder)
deploy/                     nginx config, container entrypoint, compose example, R2 CORS policy
scripts/contract-sync.mjs   Copies the backend's openapi.yaml into contract/
Dockerfile                  Multi-stage: node build → nginx static image
.github/workflows/ci.yml    CI pipeline
```

## Notes on the API

- Access tokens are 15-minute JWTs kept in memory only; the refresh token is persisted
  and rotated on every refresh. A `401` on an operator call triggers exactly one refresh
  (shared by concurrent requests) and one retry; a rejected refresh signs the console out.
- Public catalog reads are rate limited (60/min per IP). A `429` is shown with its
  `Retry-After` hint.
- Every API error is displayed with its contract code (`not_found`, `upload_not_ready`,
  `checksum_mismatch`, …) so it can be quoted when asking for help.
- Each stream in a program response carries its `uploadID`; for older backends the
  console derives it from the `/uploads/{uploadID}/index.m3u8` path of `streamURL`.
