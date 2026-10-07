#!/bin/sh
# Writes the runtime configuration the bundle reads from window.__TP_CONFIG__.
# Runs from /docker-entrypoint.d before nginx starts.
set -eu

: "${API_BASE_URL:?API_BASE_URL is required (e.g. https://api.example.com)}"
: "${APP_KEY:?APP_KEY is required (one of the backend's APP_KEYS)}"

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

cat > /usr/share/nginx/html/config.js <<CONFIG
window.__TP_CONFIG__ = {
  apiBaseURL: "$(json_escape "$API_BASE_URL")",
  appKey: "$(json_escape "$APP_KEY")",
};
CONFIG

echo "console: config.js written for ${API_BASE_URL}"
