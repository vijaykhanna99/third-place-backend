#!/usr/bin/env bash
# Runs a command for CI and, when it fails, republishes the tail of its output as
# GitHub check-run annotations (`::error`). Annotations are readable through the
# REST API, unlike the raw job log, so a failure can be diagnosed without the
# browser. Usage: scripts/ci-run.sh "<title>" <command...>
set -uo pipefail
title="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  # Last ~24 KB in chunks of 3 KB (annotation messages are capped).
  tail -c 24000 "$log" | tr -d '\r' > "$log.tail"
  total=$(wc -c < "$log.tail")
  chunk=3000
  n=$(( (total + chunk - 1) / chunk ))
  for ((i = 0; i < n; i++)); do
    part=$(dd if="$log.tail" bs=1 skip=$((i * chunk)) count=$chunk 2>/dev/null | sed 's/%/%25/g; s/\r/%0D/g' | sed ':a;N;$!ba;s/\n/%0A/g')
    echo "::error title=${title} [$((i + 1))/${n}]::${part}"
  done
  echo "::error title=${title}::exit code ${status}"
fi
exit "$status"
