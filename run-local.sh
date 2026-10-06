#!/bin/sh
# CX Portal - local web server for Mac / Linux. Serves this folder at
# http://localhost:8080/ (or the port you pass: ./run-local.sh 8090).
# Needs python3 (built into macOS). Press Ctrl+C to stop.
cd "$(dirname "$0")" || exit 1
PORT="${1:-8080}"
echo "CX Portal is running at http://localhost:$PORT/  (Ctrl+C to stop)"
( sleep 1; command -v open >/dev/null && open "http://localhost:$PORT/" || xdg-open "http://localhost:$PORT/" ) >/dev/null 2>&1 &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
