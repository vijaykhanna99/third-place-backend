#!/usr/bin/env bash
# Runs a command, prints a short raw tail and then only the lines matching a
# pattern, and exits with the COMMAND's status, not grep's. The matching lines
# come last so they are what the annotations (which keep the end of the output)
# retain. Usage: scripts/ci-filter.sh "<grep -E pattern>" <command...>
set -uo pipefail
pattern="$1"; shift
log="$(mktemp)"
"$@" > "$log" 2>&1
status=$?
total=$(wc -l < "$log")
echo "[ci-filter] ${total} lines of output, exit code ${status}"
if [ "$status" -ne 0 ]; then
  echo "[ci-filter] last 12 lines (truncated):"
  tail -12 "$log" | cut -c1-240
fi
echo "[ci-filter] matching lines:"
grep -E "$pattern" "$log" | grep -vE '^\s*$' | cut -c1-600 | tail -120 || true
exit "$status"
