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
| `DSH_E2E_HOME` | Boot against this dsh home instead of the repo-local `test-results/dsh-home`. Pin it to keep a warm profile between runs; a pinned home is not cleaned. |

The suite always boots against its **own** dsh home (`test-results/dsh-home`,
wiped at the start of every run). Not `DSH_HOME`: the Desktop app exports that
into every shell it starts, so inheriting it would silently run the suite against
the developer's own acknowledged profile — where the first-run modals are already
gone — and the fresh-home path this suite exists to cover would never run.

That home's `profiles/web/cordis.patch.yml` is seeded with two entries, because a
fresh home greets the first page with blocking modals that `Configure later` only
defers:

| Entry | Why |
| --- | --- |
| `ui-settings-general.welcomeNoticeVersion` | Acknowledges the "Preview Notice". It mounts a few seconds *after* the shell paints and covers the app with a mask, so it lands on top of a click already under way. |
| `ui-settings-models.credentialOnboarding: false` | Disables the "Get started" API-key step for this home — the same switch the desktop app sets by detecting its own shell. Clicking past it would come back on the next reload, which the business-loop test performs on purpose. |
| `DSH_HOME` | Where to look for `profiles/web` when linking the plugin. |
