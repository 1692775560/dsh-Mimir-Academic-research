# Mimir Roadmap

English | [中文](ROADMAP.zh.md)

The project charter: what Mimir is, how the project is run, how we keep it
healthy, and where it goes next. For day-to-day mechanics see
[CONTRIBUTING.md](CONTRIBUTING.md) and [RELEASING.md](RELEASING.md).

## 1. Positioning

**Mimir is an agent-native research workbench that lives inside the DeepSeek
Harness.** It manages the whole research cycle in one place:

> idea → literature → experiments → figures → writing → group meeting

- **Agent-native, not a bolt-on UI.** The agent searches arXiv, scores paper
  relevance, names and files figures, compiles LaTeX, drafts related work,
  and reviews its own writing through an independent subagent — the panel is
  the transparent window onto that work, not a separate app.
- **Full-cycle, project-scoped data.** Papers, figures, experiments, servers,
  and the ledger all live in one local wiki, strictly partitioned per
  project. Two papers never bleed into each other.
- **Local-first, open ecosystem.** Everything runs on the user's machine;
  the plugin ships through npm and the dsh-plugin community.

Scope — Mimir **absorbs** the research toolchain instead of deferring to it:

- **Reference manager**: search, import, tagging, notes, dedup, BibTeX —
  first-class, not an afterthought. Zotero sync exists as a bridge for
  existing libraries, not as a boundary.
- **LaTeX editor**: source editing with syntax highlighting, one-click
  compile, error click-through, conference templates — aimed at being the
  place papers actually get written, with the agent inside the loop.
- **Literature reader**: full-screen PDF reading, annotations, AI relevance
  scoring and summaries grounded in the user's own direction.

What Mimir is **not**: a hosted service — no accounts, no cloud, no
telemetry. And not an agent-less editor: every surface exists to close the
write → compile → review loop.

**Target users**: graduate students and researchers who already run coding
agents and want the same leverage for research.

## 2. Project management

### Branches & PRs

- `main` — stable, releases only. `dev` — integration, day-to-day work.
- Feature work happens on `feature/*` / `fix/*` / `docs/*` branches cut from
  `dev`, PR'd back to `dev`.
- **Merge commits, never squash** — contributor attribution must survive into
  the commit graph.
- Every PR: CI green (install → build → typecheck → test), tests for new
  behavior, screenshot QA for UI changes, `README.md` + `README.zh.md` kept
  section-aligned.

### Issues & triage

- Claim before work: comment on the issue so efforts don't collide.
- Maintainers label incoming issues within a few days: `bug`, `enhancement`,
  `docs`, `good first issue`.
- The `good first issue` pool is curated from real, scoped work (see §3 tech
  debt) — it is the on-ramp for new contributors.

### Releases

- Patch releases ship fixes promptly; minor releases batch features.
- `dsh-mimir` and `dsh-client-ui-mimir` are version-locked and released
  together via tag-triggered OIDC trusted publishing (see RELEASING.md).
- Every release syncs three surfaces: npm packages, README changelog, and the
  website — never just one.

### Community

- GitHub Discussions + WeChat group for user support; issues for bugs.
- Listed in the dsh-plugin ecosystem (awesome list, dsh.so artifact page) —
  keep the listing description accurate when the feature set changes.
- Contributors are credited in the README; first-time contributors get a
  welcome reply on their PR.

## 3. Maintenance

### Tracking dsh upstream

Mimir's biggest external risk is dsh drift (the 0.1.2-alpha.4 adaptation:
`dsh-client-runtime` removal, session/interaction breaking changes). Policy:

- Pin `devDependencies` to an exact dsh version; use `>=` in
  `peerDependencies` and state the floor in the README compatibility note.
- Check upstream on every dsh tag; grep the log for `!` breaking-change
  markers before bumping.
- After any bump: full `build + typecheck + test`, then boot the web
  workbench and screenshot every view — type errors and dead injects hide at
  runtime.
- Old-session cache schemas can crash the boot; rename (never delete) stale
  `~/.dsh/storages/*` files when this happens.

### Standing invariants (do not break)

- **Wiki domain stays at version 2** — additive-only changes (optional fields,
  `.default(...)`), no migrations exist.
- **All CSS colors** go through `var(--dsw-*, fallback)` or dark mode breaks.
- **Regenerate both remote faces** after adding a `@Remote` method.
- **Per-project isolation** — any new data type must be project-scoped from
  day one.

### Known tech debt (good first issues)

- `packages/ui-mimir` tests don't run under `tsc` — add a typecheck gate.
- `setup-web-search.sh` overwrites existing sxng config (e.g. ollamaApiKey)
  on re-run — merge instead of replace.
- Ledger moment candidates (#127): `getMomentIndex` lookback truncation skips
  silences; `resolveWindow` doesn't guard `since > until`.
- The in-tree dsh checkout carries 36 pre-existing ui-mimir `tsc` errors.

### Website

`mimir.smartlarkai.com` deploys by rsync from `website/`. Version numbers,
test counts, and screenshots go stale fast — refresh them on every release.

## 4. Feature roadmap

### Now (0.18.x)

- **Reference manager core**: collections/folders, reading notes per paper,
  dedup on import, one-click BibTeX export — the literature view graduates
  from "search results list" to a real library.
- **Literature reader**: fullscreen PDF reader, highlight/annotation layer,
  AI relevance scoring and one-paragraph summaries surfaced on cards,
  grounded in the project's stated direction.
- **LaTeX editor depth**: command/environment completion, section-aware
  folding, math preview on hover — plus the existing compile/error
  click-through loop.
- Figure intelligence: agent auto-naming/grouping on upload, user rename —
  kill the "mystery duplicate figures" confusion.
- Conference templates: built-in gallery (CVPR/NeurIPS/ICLR/ACL…) plus
  upload-your-own, agent re-formats to the target venue.
- **Venue & deadline tracker**: conference/journal info query (CCF rank,
  category, deadlines with countdown, reminders for upcoming DDLs),
  per-project watchlist, and an agent tool so "这个会什么时候截稿" is a
  first-class question.
- Group meeting PPT: mix original project figures with images from a
  user-configured image-gen API; no re-render churn between iterations.
- Literature view UX: collapsible subscriptions, collapsible projects,
  consistent card layout.

### Next (0.19–0.20)

- Zotero two-way sync (import libraries, push Mimir-curated collections
  back) — interop, even though the manager itself lives here.
- Reader → writer pipeline: annotations and AI summaries flow into citation
  cards, and from there into related-work drafts with real citations.
- LaTeX: live typeset preview synced to cursor, bibliography autocomplete
  from the project library.
- Experiment auto-ingest: watch remote training jobs on managed servers,
  parse metrics into experiment records and comparison charts.
- Reliability pass on the bundled skills (`/research-plan`, `/write`, …).
- Ledger hardening: commit a record and its event under one file lock
  (the append-only guarantee made hard), as self-noted in
  `packages/mimir/src/ledger.ts`.

### Later / vision

- Thesis mode: multi-chapter projects assembling several papers.
- Reproducibility snapshots: bundle paper + figures + experiment data +
  environment into one shareable archive.
- Community skills: a contributed-skills directory (reviewed, opt-in),
  following the group-meeting skills precedent.
- Deeper ledger: research-line analytics (drift, stall detection, weekly
  digests).

## 5. How to help

Pick a `good first issue`, or grab an item from §4 and open a discussion
first. UI work is always welcome — but it ships with screenshots, not vibes.
