#!/usr/bin/env bash
# One-command local SearXNG for Mimir's web search (no Docker required).
#
# What it does:
#   1. clones SearXNG (shallow) into ~/.local/share/mimir-web-search/searxng
#   2. installs it into a dedicated Python venv (no system Python touched)
#   3. writes a settings.yml with JSON output enabled and the limiter off
#      (so no Valkey/Redis sidecar is needed)
#   4. starts SearXNG on 127.0.0.1:8080 in the background
#   5. points the digdig CLI at it (~/digdig/digdig.config.json)
#
# The digdig CLI (`dg`) ships as an optional dependency of dsh-mimir since
# 0.13.x, so after this script the panel's Web tab and the web_search tool
# work without any further configuration. Re-running is safe (idempotent).
#
# Requirements: git, python3 (>= 3.10), and the digdig CLI on PATH
# (npm install -g digdig, or rely on the copy bundled with dsh-mimir).
#
# Usage: bash scripts/setup-web-search.sh [--port 8080] [--stop]

set -euo pipefail

PORT=8080
ROOT="${MIMIR_SEARCH_HOME:-$HOME/.local/share/mimir-web-search}"
BASE_URL="http://127.0.0.1:${PORT}"

if [ "${1:-}" = "--stop" ]; then
  if pids=$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null); then
    echo "$pids" | xargs kill
    echo "SearXNG on port ${PORT} stopped."
  else
    echo "Nothing is listening on port ${PORT}."
  fi
  exit 0
fi
if [ "${1:-}" = "--port" ]; then
  PORT="${2:?--port needs a value}"
  BASE_URL="http://127.0.0.1:${PORT}"
fi

for tool in git python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' is required but not on PATH" >&2; exit 1; }
done

mkdir -p "$ROOT/config"

# 1. source checkout
if [ ! -d "$ROOT/searxng/.git" ]; then
  echo ">> cloning SearXNG ..."
  git clone --depth 1 https://github.com/searxng/searxng "$ROOT/searxng"
else
  echo ">> SearXNG checkout already present, skipping clone"
fi

# 2. venv + dependencies
if [ ! -x "$ROOT/venv/bin/python" ]; then
  echo ">> creating venv ..."
  python3 -m venv "$ROOT/venv"
fi
if ! "$ROOT/venv/bin/python" -c 'import searx' >/dev/null 2>&1; then
  echo ">> installing SearXNG dependencies (first run takes a few minutes) ..."
  "$ROOT/venv/bin/pip" install -q --upgrade pip setuptools wheel
  "$ROOT/venv/bin/pip" install -q -r "$ROOT/searxng/requirements.txt"
  # setup.py imports the package itself, so build isolation must stay off.
  "$ROOT/venv/bin/pip" install -q --no-build-isolation -e "$ROOT/searxng"
else
  echo ">> SearXNG already installed in venv, skipping"
fi

# 3. settings with JSON output, no limiter (no Valkey needed)
if [ ! -f "$ROOT/config/settings.yml" ]; then
  echo ">> writing settings.yml ..."
  cat > "$ROOT/config/settings.yml" <<YAML
use_default_settings: true

server:
  secret_key: "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  limiter: false
  image_proxy: false
  bind_address: "127.0.0.1"
  port: ${PORT}

search:
  safe_search: 0
  formats:
    - html
    - json

outgoing:
  request_timeout: 15.0
  max_request_timeout: 15.0
  pool_connections: 100
  pool_maxsize: 20
  retries: 1
YAML
else
  echo ">> settings.yml already present, keeping it"
fi

# 4. start in the background
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo ">> SearXNG already listening on ${BASE_URL}"
else
  echo ">> starting SearXNG on ${BASE_URL} ..."
  (
    cd "$ROOT/searxng"
    SEARXNG_SETTINGS_PATH="$ROOT/config/settings.yml" \
      nohup "$ROOT/venv/bin/python" -m searx.webapp > "$ROOT/searxng.log" 2>&1 &
  )
  sleep 6
fi

# 5. point the digdig CLI at it (schema mirrors digdig's config file —
#    ./digdig.config.json or ~/digdig/digdig.config.json, first found wins;
#    OLLAMA_API_KEY / SEARXNG_* env vars override at runtime).
mkdir -p "$HOME/digdig"
cat > "$HOME/digdig/digdig.config.json" <<JSON
{
  "baseUrl": "${BASE_URL}",
  "defaultEngine": "",
  "allowedEngines": [],
  "defaultLimit": 10,
  "defaultFormat": "md",
  "useProxy": false,
  "proxyUrl": "",
  "timeout": 30000,
  "ollamaApiKey": "",
  "deepseekApiKey": "",
  "redundancyThreshold": 0.7,
  "redundancyBigramThreshold": 0.5
}
JSON

# health check
if curl -sf -m 10 "${BASE_URL}/search?q=mimir&format=json" >/dev/null 2>&1; then
  echo ""
  echo "Done. SearXNG answers JSON at ${BASE_URL} and digdig is configured."
  echo "Restart dsh; the Library view's Web tab and the web_search tool are ready."
  echo "Logs: $ROOT/searxng.log — stop with: bash scripts/setup-web-search.sh --stop"
else
  echo "warning: SearXNG did not answer yet — check $ROOT/searxng.log" >&2
  exit 1
fi
