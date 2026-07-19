#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run check
node dist/apps/ras-worker/src/worker.js
PORT=18080 node dist/apps/ras-api/src/server.js > /tmp/ras-api-smoke.log 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:18080/health >/tmp/ras-health.json; then
    break
  fi
  sleep 0.2
done
curl -fsS http://127.0.0.1:18080/health
printf '\n'
curl -fsS http://127.0.0.1:18080/dry-run/customer
printf '\n'
