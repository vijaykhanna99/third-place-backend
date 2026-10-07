#!/usr/bin/env bash
# Runs a command, prints only the lines matching a pattern (plus a count of the
# rest), and exits with the COMMAND's status, not grep's. Keeps noisy build
# tools (xcodebuild, swiftc) readable inside check-run annotations.
# Usage: scripts/ci-filter.sh "<grep -E pattern>" <command...>
set -uo pipefail
pattern="$1"; shift
log="$(mktemp)"
"$@" > "$log" 2>&1
status=$?
total=$(wc -l < "$log")
grep -E "$pattern" "$log" | grep -vE '^\s*$' | head -200 || true
echo "[ci-filter] ${total} lines of output, exit code ${status}"
if [ "$status" -ne 0 ]; then
  echo "[ci-filter] last 40 lines:"
  tail -40 "$log"
fi
exit "$status"
