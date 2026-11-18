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
#
#    MERGE, never rewrite. This file also holds the user's own keys
#    (ollamaApiKey, deepseekApiKey) and anything their digdig version added;
#    re-running this script must not clear them. Only `baseUrl` is ours to
#    set — every other key keeps the value already on disk, and the defaults
#    below merely fill in what the file does not have yet.
mkdir -p "$HOME/digdig"
python3 - "$HOME/digdig/digdig.config.json" "$BASE_URL" <<'PY'
import json, os, sys, tempfile

path, base_url = sys.argv[1], sys.argv[2]

# What a fresh install gets. Existing keys always win over these.
defaults = {
    'defaultEngine': '',
    'allowedEngines': [],
    'defaultLimit': 10,
    'defaultFormat': 'md',
    'useProxy': False,
    'proxyUrl': '',
    'timeout': 30000,
    'ollamaApiKey': '',
    'deepseekApiKey': '',
    'redundancyThreshold': 0.7,
    'redundancyBigramThreshold': 0.5,
}

existing = {}
if os.path.exists(path):
    try:
        with open(path, encoding='utf-8') as handle:
            existing = json.load(handle)
    except (OSError, ValueError) as error:
        # A file we cannot parse is the user's, not ours to flatten.
        sys.exit(f'error: cannot parse {path}: {error}; fix or move it, then re-run')
    if not isinstance(existing, dict):
        sys.exit(f'error: {path} is not a JSON object; fix or move it, then re-run')

merged = {**defaults, **existing, 'baseUrl': base_url}

# Atomic write: a crash mid-write must not leave a truncated config behind.
directory = os.path.dirname(path) or '.'
handle, temp_path = tempfile.mkstemp(dir=directory, prefix='.digdig.config.', suffix='.tmp')
try:
    with os.fdopen(handle, 'w', encoding='utf-8') as out:
        json.dump(merged, out, indent=2, ensure_ascii=False)
        out.write('\n')
    os.replace(temp_path, path)
except BaseException:
    if os.path.exists(temp_path):
        os.unlink(temp_path)
    raise

kept_defaults = len(existing)
unknown = sorted(set(existing) - {'baseUrl'} - set(defaults))
note = f'>> digdig config merged: baseUrl={base_url}'
if kept_defaults:
    note += f', kept {kept_defaults} existing key(s)'
if unknown:
    note += f', preserved unknown: {", ".join(unknown)}'
print(note)
PY

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
