#!/bin/sh
# Make `dsh --profile web --patch e2e/mimir.cordis.yml` able to import the
# suite from THIS checkout (#240): dsh resolves patch plugin names from the
# profile directory, not from the repo, so the package has to be reachable
# under <DSH_HOME>/profiles/web/node_modules. Idempotent.
set -e
root=${1:?usage: link-plugin.sh <repo-root> [profile-dir]}
profile=${2:-${DSH_HOME:-$HOME/.dsh}/profiles/web}
mkdir -p "$profile/node_modules"
if [ ! -e "$profile/node_modules/dsh-mimir" ]; then
  ln -s "$root/packages/mimir" "$profile/node_modules/dsh-mimir"
fi
printf 'linked %s -> %s\n' "$profile/node_modules/dsh-mimir" "$root/packages/mimir"
