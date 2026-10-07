#!/usr/bin/env bash
# Stops the API and worker started by scripts/watch-setup.sh (containers keep running; `pnpm db:down` stops them).
cd "$(dirname "$0")/.."
for p in api worker; do
  if [ -f ".watch/$p.pid" ]; then
    pid=$(cat ".watch/$p.pid")
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    rm -f ".watch/$p.pid"
    echo "stopped $p"
  fi
done
