# E2E: the suite boots its own instance

`pnpm test:e2e` starts a dsh Web server serving **this checkout** and drives the
Mimir workbench through Chromium. Nothing has to be configured first, so the
browser path is covered on every CI run instead of only when someone sets a
variable.

```sh
pnpm install
pnpm run build                                   # the client bundles are what the browser loads
./e2e/link-plugin.sh "$PWD"                      # make `dsh --profile web` able to import dsh-mimir
pnpm test:e2e
```

## What runs

| Piece | Why it exists |
| --- | --- |
| `e2e/instance.ts` | Boots `dsh --profile web --patch e2e/mimir.cordis.yml --port <free> --no-open`, waits for its URL, extracts the one-shot `?token=`, and stops it afterwards. Links the package into the profile first, because dsh resolves patch plugin names from the profile directory rather than the repo. |
| `e2e/mimir.cordis.yml` | The minimal overlay: the research suite with its background loops off, so a short-lived instance leaves no backups or timers behind. |
| `e2e/workbench.spec.ts` | Two tests: every view renders; a project created in the panel is still there after a full page reload (the business loop in #240). |

Each test attaches `instance` JSON (base URL, `git rev-parse HEAD` of the commit
under test, the overlay used) and the six per-view screenshots, so a failure
names exactly what was running.

## Knobs

| Variable | Effect |
| --- | --- |
| `DSH_E2E_URL` | Adopt a long-lived instance instead of booting one; pair it with `DSH_E2E_TOKEN` when that instance needs one. |
| `DSH_E2E_TOKEN` | Token for the adopted instance. |
| `DSH_E2E_BIN` | The `dsh` executable to boot (defaults to `dsh` on `PATH`). |
| `DSH_E2E_PATCH` | Overlay to boot with (defaults to `e2e/mimir.cordis.yml`). |
| `DSH_E2E_PORT` | Pin the port instead of taking a free one. |
| `DSH_HOME` | Where to look for `profiles/web` when linking the plugin. |
