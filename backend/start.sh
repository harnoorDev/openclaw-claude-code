#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/backend.pid"
LOG_FILE="$DIR/backend.log"

# Load user env (pick up ANTHROPIC_API_KEY or any provider key)
[ -f ~/.bashrc ] && source ~/.bashrc 2>/dev/null || true

# Config — override via environment or .env file
export CLAUDE_BIN="${CLAUDE_BIN:-claude}"
export BACKEND_API_PORT="${BACKEND_API_PORT:-18795}"
export NO_COLOR=1

# Check if already running
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Already running (PID $(cat "$PID_FILE"))"
  exit 0
fi

if [[ "${1:-}" == "--daemon" ]]; then
  nohup node "$DIR/dist/server.js" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "Started claude-code-backend (PID $(cat "$PID_FILE"))"
  echo "Log: $LOG_FILE"
else
  exec node "$DIR/dist/server.js"
fi
