#!/bin/sh
# Fake `git` for the digdig skill provider tests. Replaces the real binary via
# MIMIR_DIGDIG_SKILL_GIT so tests drive clone/pull without a network or checkout.
set -u

case "$1" in
  clone)
    # `git clone --depth 1 <url> .` runs with cwd = cache dir; materialize the
    # checkout layout the provider reads (`.git` marker + skills/digdig/SKILL.md).
    mkdir -p ".git" "skills/digdig"
    cat > "skills/digdig/SKILL.md" <<'EOF'
---
name: digdig
description: Web search CLI skill with search, extract, and download commands.
---

# digdig

Run a web search.
EOF
    ;;
  pull)
    [ "${MIMIR_FAKE_GIT_FAIL_PULL:-0}" = 1 ] && exit 1
    ;;
esac
exit 0
