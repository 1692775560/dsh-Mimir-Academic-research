# Contributing to Mimir

English | [中文](CONTRIBUTING.zh.md)

Thanks for helping build Mimir! This guide covers the workflow, the checks every
change must pass, and the pitfalls that have bitten us before. Code-level
conventions live in [CODE_STYLE.md](CODE_STYLE.md) — read it before your first PR.

> **Hard gate:** a PR is merged only if `node scripts/check-style.mjs`
> (enforced in CI) passes and the change follows CODE_STYLE.md. PRs that fix
> nothing real, skip the tests, or restyle unrelated code are not merged —
> they get review feedback instead.

## Setup

```bash
git clone https://github.com/1692775560/dsh-Mimir-Academic-research.git
cd Mimir
pnpm install
pnpm run build   # ordered: mimir tsc+bundle, then ui-mimir tsc+bundle
pnpm test        # vitest, must stay green
```

Verified on Node v24 / pnpm v11. See the [README](README.md) Quickstart for
running the example agent and the web workbench.

## Branching

- `main` — stable release branch. PRs only.
- `dev` — integration branch. Day-to-day work lands here.
- `feature/<name>` / `fix/<name>` / `docs/<name>` — your branch, cut from `dev`,
  PR'd back to `dev`.

Claim a task by commenting on its issue before starting, so work does not
collide.

## Every PR must

1. Pass CI (`install → build → typecheck → test`). Add tests for behavior you
   add — pure logic lives in testable functions, not inline in components.
2. For **UI changes**: run the screenshot QA
   (`packages/ui-mimir/scripts/screenshot.ts` against a local
   `examples/mimir-agent` server), look at every screenshot, and attach the
   relevant ones to the PR. "Looks fine" must mean you looked.
3. Update docs touched by your change: `README.md` + `README.zh.md` stay
   section-aligned, and keep `ROADMAP.md` current.
4. Keep the style of the file you are in (JSDoc, `readonly`, `Object.freeze`,
   `var(--x, fallback)` for every CSS color).

## Pitfalls (learned the hard way)

- **Adding a `@Remote` method is not enough.** The web client calls through a
  generated face embedded in the dsh `api-remotes` bundle; in this repo the
  `pnpm run build` regenerates it, but when developing inside a dsh checkout
  you must rebuild both faces (`host` and `client`), or the browser throws
  `this.remote.<method> is not a function`.
- **The wiki domain stays at version 2.** There is no migration mechanism; a
  version bump rejects every existing user file. New fields must be optional
  or carry `.default(...)`; new tables open empty on old snapshots. Add a
  compatibility test that parses an old-shape record.
- **All CSS colors go through `var(--dsw-*, fallback)`** so dark mode follows
  the host theme. A bare `var(--x)` without fallback once rendered the whole
  panel white.
- **Do not break the overlay/textarea geometry.** The LaTeX highlight overlay
  and the textarea share font metrics exactly; if you touch one, screenshot
  the editor and check for ghosting.

## Commit messages

English, imperative mood, one-line summary plus a short body when the change
needs context. See `git log` for the tone.
