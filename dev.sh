#!/usr/bin/env bash
# Start BundoPay locally: API (port 8000), background worker, and website (port 3000).
# Press Ctrl+C once to stop all three.
set -euo pipefail
cd "$(dirname "$0")"

[ -f backend/.env ] || { echo "Missing backend/.env (copy backend/.env.example and fill it in)"; exit 1; }
[ -f frontend/.env.local ] || { echo "Missing frontend/.env.local (copy frontend/.env.example and fill it in)"; exit 1; }
[ -d frontend/node_modules ] || (cd frontend && npm install)

trap 'echo; echo "Stopping BundoPay..."; kill 0' INT TERM EXIT

(cd backend && uv run uvicorn app.main:app --port 8000 2>&1 | sed 's/^/[api]    /') &
(cd backend && uv run python -m app.jobs.worker 2>&1 | sed 's/^/[worker] /') &
(cd frontend && npm run dev 2>&1 | sed 's/^/[web]    /') &

echo "BundoPay is starting. Open http://localhost:3000 in a few seconds."
wait
