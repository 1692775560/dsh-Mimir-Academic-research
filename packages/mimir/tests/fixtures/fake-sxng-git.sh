#!/bin/sh
# Fake `git` for the sxng skill provider tests. Replaces the real binary via
# MIMIR_SXNG_SKILL_GIT so tests drive clone/pull without a network or checkout.
set -u

case "$1" in
  clone)
    # `git clone --depth 1 <url> .` runs with cwd = cache dir; materialize the
    # checkout layout the provider reads (`.git` marker + skills/sxng/SKILL.md).
    mkdir -p ".git" "skills/sxng"
    cat > "skills/sxng/SKILL.md" <<'EOF'
---
name: sxng
description: Web search CLI skill with search, extract, and download commands.
---

# sxng

Run a web search.
EOF
    ;;
  pull)
    [ "${MIMIR_FAKE_GIT_FAIL_PULL:-0}" = 1 ] && exit 1
    ;;
esac
exit 0
