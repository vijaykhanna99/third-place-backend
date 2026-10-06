# Third Place backend — API server and extraction worker in one image.
#
#   docker build -t third-place-backend .
#   docker run --env-file .env third-place-backend                      # API (default)
#   docker run --env-file .env third-place-backend node dist/jobs/worker.js
#   docker run --env-file .env third-place-backend node dist/db/migrate.js
#
# glibc base (not alpine): argon2 is a native module and its prebuilt binary
# targets glibc; a musl base would compile it from source on every build.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- deps: everything needed to build (dev deps included) -------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml ./
# argon2 and esbuild are the only packages allowed to run install scripts
# (package.json pnpm.onlyBuiltDependencies); python/make are not needed because
# argon2 ships a prebuilt binary for linux-x64 glibc.
RUN pnpm install --frozen-lockfile

# ---- build: compile TypeScript to dist/ -------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---- prod-deps: production dependencies only ---------------------------------
FROM deps AS prod-deps
RUN pnpm prune --prod

# ---- runtime ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The migrator reads SQL from src/db/migrations at runtime (drizzle-orm migrator).
COPY src/db/migrations ./src/db/migrations

# Scratch space for the worker's archive downloads (SCRATCH_DIR); a mounted
# volume is expected in production since archives can reach several GiB.
RUN mkdir -p /scratch && chown node:node /scratch
ENV SCRATCH_DIR=/scratch

USER node
EXPOSE 3000

# Liveness only: /healthz answers 200 whenever the process is up.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/index.js"]
