#!/usr/bin/env bash
# Runs the Worker in the real workerd runtime (`wrangler dev` with a local R2
# simulation), publishes a small HLS bundle into the local bucket, and drives
# the public media surface over HTTP: token gating, playlist rewriting, segment
# caching headers, byte ranges, thumbnails. CI runs this after the unit tests.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8787}
SECRET="smoke-stream-token-secret-0123456789"
UPLOAD="01890a5d-ac96-774b-b111-000000000801"
OTHER="01890a5d-ac96-774b-b111-000000000802"
BUCKET="tplace-media-prod"
TMP=$(mktemp -d)
fail=0
check() { if [ "$1" = "$2" ]; then echo "  ok   $3"; else echo "  FAIL $3 (expected '$2', got '$1')"; fail=1; fi; }

# Objects into the local R2 simulation.
printf '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="JA",LANGUAGE="ja",URI="subtitles/ja/subtitle.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=48000000,RESOLUTION=7680x4320,SUBTITLES="subs"\nuhd8k/playlist.m3u8\n' > "$TMP/index.m3u8"
printf '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment-00001.ts\n#EXT-X-ENDLIST\n' > "$TMP/playlist.m3u8"
head -c 1000 /dev/zero | tr '\0' 'z' > "$TMP/segment-00001.ts"
printf '\x89PNG\r\n' > "$TMP/thumb.png"
for pair in "index.m3u8:media/uploads/$UPLOAD/index.m3u8:application/vnd.apple.mpegurl" \
            "playlist.m3u8:media/uploads/$UPLOAD/uhd8k/playlist.m3u8:application/vnd.apple.mpegurl" \
            "segment-00001.ts:media/uploads/$UPLOAD/uhd8k/segment-00001.ts:video/mp2t" \
            "thumb.png:media/images/thumb.png:image/png"; do
  IFS=: read -r file key type <<< "$pair"
  npx wrangler r2 object put "$BUCKET/$key" --file "$TMP/$file" --content-type "$type" --local >/dev/null
done

# The Worker in workerd.
npx wrangler dev --port "$PORT" --var "STREAM_TOKEN_SECRET:$SECRET" --local --log-level warn > "$TMP/dev.log" 2>&1 &
DEV=$!
trap 'kill $DEV 2>/dev/null || true' EXIT
for i in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 90 ]; then echo "wrangler dev did not start"; cat "$TMP/dev.log"; exit 1; fi
  sleep 1
done

# Tokens, same format as the API mints (v1.<exp>.<b64url prefix>.<b64url hmac>).
token() { node -e '
const { createHmac } = require("node:crypto");
const [secret, prefix, exp] = process.argv.slice(1);
const input = `v1.${exp}.${Buffer.from(prefix).toString("base64url")}`;
console.log(`${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`);
' "$1" "$2" "$3"; }
NOW=$(date +%s)
GOOD=$(token "$SECRET" "uploads/$UPLOAD/" $((NOW + 900)))
EXPIRED=$(token "$SECRET" "uploads/$UPLOAD/" $((NOW - 1)))
FOREIGN=$(token "$SECRET" "uploads/$OTHER/" $((NOW + 900)))
FORGED=$(token "not-the-secret" "uploads/$UPLOAD/" $((NOW + 900)))
BASE="http://127.0.0.1:$PORT/uploads/$UPLOAD"

echo "# gating"
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/index.m3u8")" 403 "no token → 403"
check "$(curl -s "$BASE/index.m3u8" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).error.code')" token_required "no token → token_required"
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/index.m3u8?token=$EXPIRED")" 403 "expired token → 403"
check "$(curl -s "$BASE/index.m3u8?token=$EXPIRED" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).error.code')" token_expired "expired token → token_expired"
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/index.m3u8?token=$FOREIGN")" 403 "another angle's token → 403"
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/index.m3u8?token=$FORGED")" 403 "forged token → 403"

echo "# playlists"
MASTER=$(curl -s "$BASE/index.m3u8?token=$GOOD")
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/index.m3u8?token=$GOOD")" 200 "master playlist → 200"
check "$(echo "$MASTER" | grep -c "uhd8k/playlist.m3u8?token=$GOOD")" 1 "variant URI carries the token"
check "$(echo "$MASTER" | grep -c "URI=\"subtitles/ja/subtitle.m3u8?token=$GOOD\"")" 1 "EXT-X-MEDIA URI carries the token"
check "$(curl -s -D - -o /dev/null "$BASE/index.m3u8?token=$GOOD" | tr -d '\r' | grep -i '^content-type' | cut -d' ' -f2-)" "application/vnd.apple.mpegurl" "playlist content type"
check "$(curl -s "$BASE/uhd8k/playlist.m3u8?token=$GOOD" | grep -c "segment-00001.ts?token=$GOOD")" 1 "media playlist segment carries the token"

echo "# segments"
HDR=$(curl -s -D - -o /dev/null "$BASE/uhd8k/segment-00001.ts?token=$GOOD" | tr -d '\r')
check "$(echo "$HDR" | head -1 | cut -d' ' -f2)" 200 "segment → 200"
check "$(echo "$HDR" | grep -i '^cache-control' | cut -d' ' -f2-)" "public, max-age=31536000, immutable" "segment cache headers"
check "$(echo "$HDR" | grep -i '^content-length' | cut -d' ' -f2-)" 1000 "segment content length"
RANGE=$(curl -s -D - -o "$TMP/part" -H 'Range: bytes=100-199' "$BASE/uhd8k/segment-00001.ts?token=$GOOD" | tr -d '\r')
check "$(echo "$RANGE" | head -1 | cut -d' ' -f2)" 206 "byte range → 206"
check "$(echo "$RANGE" | grep -i '^content-range' | cut -d' ' -f2-)" "bytes 100-199/1000" "content-range header"
check "$(wc -c < "$TMP/part" | tr -d ' ')" 100 "range body length"
check "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/uhd8k/missing.ts?token=$GOOD")" 404 "missing object → 404"

echo "# thumbnails and misc"
check "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/images/thumb.png")" 200 "thumbnail without token → 200"
check "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/images/nope.png")" 404 "missing thumbnail → 404"
check "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/index.m3u8?token=$GOOD")" 405 "POST → 405"
check "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/media/uploads/$UPLOAD/index.m3u8")" 404 "storage layout is not exposed"

if [ "$fail" -ne 0 ]; then echo "smoke: FAILED"; sed -n 1,40p "$TMP/dev.log"; exit 1; fi
echo "smoke: all checks passed"
