#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-3847}"
export PATH="${HOME}/.deno/bin:${HOME}/.local/bin:${PATH:-}"

echo "deploy: applying database migrations…"
npm run db:migrate

PID="$(ss -tlnp 2>/dev/null | awk -v needle="127.0.0.1:${PORT}" '$4 ~ needle {print $NF}' | head -1 | sed -n 's/.*pid=\([0-9]*\).*/\1/p')"
if [[ -n "${PID}" ]]; then
  echo "deploy: stopping pid ${PID} on 127.0.0.1:${PORT}"
  kill -TERM "${PID}" 2>/dev/null || true
  sleep 1
fi

if [[ ! -f "${ROOT}/build/server/index.js" ]]; then
  echo "deploy: build/server/index.js missing — run npm run build:server first" >&2
  exit 1
fi

echo "deploy: starting production server…"
nohup npm run start >> "${ROOT}/server.log" 2>&1 &
sleep 2
ss -tlnp 2>/dev/null | grep "127.0.0.1:${PORT}" || {
  echo "deploy: nothing listening on 127.0.0.1:${PORT} — tail server.log" >&2
  tail -30 "${ROOT}/server.log" >&2 || true
  exit 1
}
echo "deploy: ok — http://127.0.0.1:${PORT}"
