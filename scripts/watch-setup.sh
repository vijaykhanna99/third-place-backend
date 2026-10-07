#!/usr/bin/env bash
# One-command local playback setup on a Mac (Apple silicon, macOS 15+):
#   1. starts Postgres/Redis/MinIO (docker compose) and migrates
#   2. builds tools/mvhevc and renders two MV-HEVC stereo test clips (two camera angles)
#   3. starts the API and the extraction worker in the background
#   4. uploads both clips through the real pipeline and creates a program
#   5. points the visionOS app (Config/Local.xcconfig) at this machine and generates the Xcode project
#
#   scripts/watch-setup.sh                # watch in the visionOS simulator on this Mac
#   scripts/watch-setup.sh --device       # watch on a Vision Pro on the same Wi-Fi (uses this Mac's LAN IP)
#   scripts/watch-setup.sh --ttl 120      # stream-token TTL in seconds (default 180: a refresh every ~2 minutes)
#   scripts/watch-setup.sh --seconds 300  # clip length (default 240 s, enough to see a token refresh)
#   scripts/watch-stop.sh                 # stops the API and worker started here
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=simulator; TTL=180; CLIP_SECONDS=240
while [ $# -gt 0 ]; do
  case "$1" in
    --device) MODE=device ;;
    --ttl) TTL="$2"; shift ;;
    --seconds) CLIP_SECONDS="$2"; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)"; exit 1; }; }
need pnpm "corepack enable, or brew install pnpm"
need docker "Docker Desktop, or colima start"
need swift "Xcode 16+ with command line tools"
need zip "ships with macOS"
if [ "$(uname -m)" != "arm64" ]; then echo "MV-HEVC encoding needs Apple silicon"; exit 1; fi

HOST_IP=127.0.0.1
if [ "$MODE" = device ]; then
  HOST_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
  [ -n "$HOST_IP" ] || { echo "could not determine this Mac's Wi-Fi/Ethernet address"; exit 1; }
fi
WATCH=.watch; mkdir -p "$WATCH"

echo "== services"
docker compose up -d
for i in $(seq 1 60); do docker compose exec -T postgres pg_isready -U tplace -d tplace >/dev/null 2>&1 && break; sleep 1; done
for i in $(seq 1 60); do curl -sf http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1 && break; sleep 1; done
docker compose run --rm minio-init >/dev/null

# Environment for every process started below (explicit values override .env).
export NODE_ENV=development LOG_LEVEL=info HOST=0.0.0.0 PORT=3000
export DATABASE_URL=postgres://tplace:tplace@localhost:5433/tplace REDIS_URL=redis://localhost:6379
export JWT_SIGNING_KEY=watch-dev-jwt-signing-key-not-for-production-0000000000000000
export APP_KEYS=dev-app-key STREAM_TOKEN_TTL_SEC="$TTL"
export R2_ENDPOINT=http://127.0.0.1:9000 R2_ACCESS_KEY_ID=tplace R2_SECRET_ACCESS_KEY=tplace-secret R2_BUCKET_MEDIA=tplace-media-dev
export MEDIA_BASE_URL="http://$HOST_IP:9000/tplace-media-dev/media"
unset STREAM_TOKEN_SECRET   # MinIO serves the bucket directly: no edge Worker, so URLs stay unsigned here

echo "== dependencies and migrations"
pnpm install --frozen-lockfile >/dev/null
pnpm db:migrate >/dev/null

echo "== rendering MV-HEVC test clips (${CLIP_SECONDS}s each, this takes a minute or two)"
(cd tools/mvhevc && swift build -c release 2>&1 | tail -1)
MAKE=tools/mvhevc/.build/release/make-bundle
"$MAKE" --out "$WATCH/main" --label MAIN --hue 0.60 --seconds "$CLIP_SECONDS"
"$MAKE" --out "$WATCH/side" --label SIDE --hue 0.08 --seconds "$CLIP_SECONDS"
rm -f "$WATCH/main.zip" "$WATCH/side.zip"
(cd "$WATCH/main" && zip -qr ../main.zip .)
(cd "$WATCH/side" && zip -qr ../side.zip .)

echo "== starting API and worker (logs in $WATCH/)"
scripts/watch-stop.sh >/dev/null 2>&1 || true
nohup pnpm dev > "$WATCH/api.log" 2>&1 & echo $! > "$WATCH/api.pid"
nohup pnpm worker > "$WATCH/worker.log" 2>&1 & echo $! > "$WATCH/worker.pid"
for i in $(seq 1 60); do curl -sf http://127.0.0.1:3000/readyz >/dev/null 2>&1 && break; sleep 1; done
curl -sf http://127.0.0.1:3000/readyz >/dev/null || { echo "API did not start; see $WATCH/api.log"; exit 1; }

echo "== uploading both angles through the pipeline"
pnpm exec tsx scripts/watch-seed.ts --api http://127.0.0.1:3000 \
  --bundle "Main=$WATCH/main.zip" --bundle "Side=$WATCH/side.zip" --title "Watch test $(date '+%Y-%m-%d %H:%M')"

echo "== app configuration"
cat > visionos-app/Config/Local.xcconfig <<XC
// Written by scripts/watch-setup.sh ($MODE mode). Not committed.
API_BASE_URL = http:/\$()/$HOST_IP:3000
APP_KEY = dev-app-key
MEDIA_ORIGIN = http:/\$()/$HOST_IP:9000/tplace-media-dev/media
XC
if command -v xcodegen >/dev/null 2>&1; then (cd visionos-app && xcodegen generate >/dev/null && echo "ThirdPlace.xcodeproj generated"); else echo "xcodegen not installed: brew install xcodegen, then run 'xcodegen generate' in visionos-app/"; fi

cat <<MSG

Ready.
  API      http://$HOST_IP:3000   (token TTL ${TTL}s → the player refreshes ~$((TTL - 60))s after start)
  Media    $MEDIA_BASE_URL
  Logs     $WATCH/api.log  $WATCH/worker.log      Stop: scripts/watch-stop.sh

Next: open visionos-app/ThirdPlace.xcodeproj, run the ThirdPlace scheme on
$( [ "$MODE" = device ] && echo "your Apple Vision Pro (same Wi-Fi as this Mac)" || echo "an Apple Vision Pro simulator" ),
Browse → Test footage → Watch test → Stereo test pattern → Play. What to check is in visionos-app/README.md.
MSG
