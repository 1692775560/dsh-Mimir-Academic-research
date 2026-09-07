# Mimir Roadmap

Goal-mode work queue. Each item ships in one iteration: implement in the dev
repo (`~/deepseek-harness`), tests + screenshot QA, sync here, push.
Priority: literature+experiments > writing > servers, with a pure UI/UX
polish round every few iterations.

## In progress

- [x] Agent artifact ingestion (Issue #30): `figure_save` copies generated images into the selected project's `figures/` directory, records caption/source/experiment metadata in the wiki, and returns a LaTeX snippet; the figures view shows that metadata.
- [x] Standard Playwright E2E suite (Issue #13): core six-view and literature-search scenarios, reusable against a mounted dsh Web URL, with CI artifact upload when `DSH_E2E_URL` is configured.
- [x] npm release preparation (Issue #2): Node engines, pack verification, tag-triggered provenance workflow, and release documentation. First publication remains blocked on npm publisher authentication.

## Done

- [x] Bundled research skills (v0.8.0): nine ARIS-style workflow playbooks
      (pipeline / lit-review / novelty-check / experiment-plan /
      result-to-claim / paper-drafting / citation-audit / rebuttal /
      figure-plan) ship inside dsh-mimir and register via
      `ctx.skills.register()` at runtime rank 250 — project-level same-name
      skills override; the `skills` service is consumed through
      `ctx.inject` so registry-less compositions load unchanged;
      `skills.enabled` config knob; bodies ride the bundle as template
      literals (lib-only publishing)

- [x] Server tags + experiment server links: ServerRecord grew `tags`
      (`.default([])`, no version bump) with saveServer cleaning
      (trim/empty-out/dedupe), ExperimentRecord grew `serverId` (optional, no
      bump) with a new `updateExperiment` Remote (link / null-clear / unknown
      server is `invalid-input`); the servers view has tag chips in the form
      and on cards plus a tag filter bar, the experiments table shows a
      linked-server badge per row with an inline relink dropdown, and the
      overview gained a servers stat chip
- [x] Experiment comparison: covered by the metric-comparison bar charts
      (one inline SVG chart per numeric metric shared by ≥2 runs) instead of
      a selection-based table
- [x] Experiment create/edit inline form: new `saveExperiment` Remote
      (32 research methods) — full-field upsert (fresh `exp-` id on create,
      `updatedAt` refresh on both paths) with project-exists
      (`project-not-found`), non-empty name, legal status, metrics shape,
      and linked-server-exists (`invalid-input`) validation. The experiments
      view's toolbar opens the form card (name / status select / dynamic
      metrics key-value rows — numeric-looking values store as numbers,
      empty keys drop — / optional server select), a row's Edit backfills
      it, and a save patches the loaded slice plus toasts
- [x] Outline drag-to-reorder sections: each top-level outline row grows a
      drag grip (HTML5 DnD, insertion indicator under the pointer); a drop
      rewrites `main.tex`'s top-level `\section` order (blocks move whole with
      their subsections, everything else byte-identical — pure
      `reorderSections` line permutation + new `reorderPaperSections` Remote
      with an optimistic `baseOutline` check, conflicts reload); a dirty
      editor disables dragging
- [x] Outline drag-to-reorder subsections (Issue #10): subsection rows gain
      the same drag grip; a drop reorders within the owning section or moves
      the block across sections (a dashed drop zone appears under
      subsection-less sections mid-gesture) — pure `reorderSubsections` line
      permutation (`\subsubsection`s ride along, unmoved blocks
      byte-identical) + new `reorderPaperSubsections` Remote whose
      `baseOutline` conflict check covers the whole section/subsection tree
- [x] Paper view layout: drag handles between outline/editor/preview resize
      the panes (pure `railWidthFromDrag`/`editorShareFromDrag` clamp math,
      rail snaps to collapsed below 60px, editor ≥320px / preview ≥280px),
      widths persist to localStorage (`mimir.paperLayout`); editor and preview
      each go fullscreen from a head button, and Esc exits fullscreen before
      closing the panel (`shortcutFor` takes the fullscreen flag)
- [x] BibTeX management: the paper view's bibliography panel reads the
      project's `references.bib` (tolerant dependency-free parser with a
      parse∘serialize round-trip invariant), lists entries with delete, and
      appends library papers as `@misc` entries — from the panel's import
      picker or each library card's one-click button (new `getBibliography` /
      `saveBibliography` / `importPapersToBib` Remotes; deletes and imports
      write the file under optimistic concurrency, conflicts reload)
- [x] Figures view: upload / delete / copy-LaTeX-snippet image management
- [x] Servers view: CRUD + TCP probe + SSH nvidia-smi GPU bars
- [x] SSH remote jobs (Issue #6): the servers view's jobs section submits a
      command to a remembered server (new `submitJob` / `listJobs` /
      `deleteJob` Remotes over a new `jobs` wiki table — added without a
      version bump, excluded from the six-table export snapshot). The host
      runs the command over batch-mode ssh in the background (30-minute
      session cap, 8 KB stdout/stderr tails kept on the record); the panel
      polls every 2 s while anything is queued/running and toasts terminal
      flips. A job linked to an experiment of the selected project flips
      that experiment to running (+ server link) on submit and
      success/failed on settle
- [x] UI refresh: nav icons, view headers, stat chips, status pills
- [x] In-panel arXiv search: search box in the literature view, one-click
      import into the wiki library (plus library card delete)
- [x] Compile issues click-through: clicking a LaTeX error/warning in the
      paper view jumps the editor to that line (line badges, gutter flash,
      no-wrap editor so line numbers never drift)
- [x] Experiment metrics charts: numeric metric keys shared by ≥2 runs render
      as inline SVG comparison bar charts; experiment rows can be deleted
      (new `deleteExperiment` Remote; the "add experiment" form was skipped —
      no saveExperiment Remote yet)
- [x] Literature tagging + per-project linking of papers (new `updatePaper`
      Remote; tag pills, project badges, inline editor, tag/current-project
      filter bar; PaperRecord grew `tags`/`projectIds` with zod defaults, no
      wiki version bump)
- [x] LaTeX syntax highlighting in the editor: zero-dependency overlay
      (transparent-text textarea over a token-rendered `pre`); single-pass
      tokenizer with plain/comment/command/math/brace/bracket/env tokens,
      escape-safe (`\%` stays plain), same-line `$…$` pairing; degrades to
      plain text past 200 KB
- [x] UI polish round: dark mode + language switch + keyboard shortcuts. Both
      toggles ride the host services (`ctx.theme` / `ctx.locale`, durable via
      Host settings — no panel-local localStorage): the header has sun/moon
      and 中/EN buttons; the panel only re-tints its private `--mimir-tok-*`
      syntax colors plus `error-secondary` (a stroke token in the dark base
      palette, used here as a fill) under `body[data-ds-dark-theme]`.
      Shortcuts (pure `shortcutFor` mapping, guarded while typing): `1–6`
      switch views, `Esc` closes, `⌘/Ctrl+Enter` compiles; a hint line sits at
      the rail bottom. (Opening the panel by shortcut was skipped — the host
      sidebar owns that surface.)
- [x] Narrow-width layout adaptation: below 900px the paper view degrades to
      a one-pane editor/preview tab bar (`paperSoloPane` picks the visible
      pane; the existing fullscreen CSS hides the other pane, the outline
      rail, and the drag handles); below 700px the sidebar becomes a top bar
      with a horizontally scrollable nav and a full-width project row. Card
      grids already degrade to a single column via `auto-fill minmax`. Also
      fixed a pre-existing flex bug: a long nowrap project title inflated the
      sidebar past its 216px basis (`.side` now has `min-width: 0`), and the
      experiments error state gained a retry button.
- [x] Experiment-log Markdown rendering: the artifact viewer renders
      `EXPERIMENT_LOG.md` with a dependency-free restricted parser
      (`markdown.ts` blocks + inline spans, `MarkdownView.tsx` renderer) —
      headings #–####, bold/italic/inline code, fenced code (an unclosed
      fence swallows the rest), unordered/ordered lists, quotes, rules, pipe
      tables, and links; `safeLinkUrl` neutralizes every non-http(s) scheme
      (`javascript:`, `data:`, …) to plain text. Unrecognized syntax stays
      literal. Styling rides the shared `--dsw-*` tokens, so dark mode
      follows.
- [x] Figures drag-and-drop upload: dropping image files anywhere on the
      figures view reuses the existing upload channel; a dashed overlay shows
      while a file drag hovers (enter/leave depth counter, `stopPropagation`
      keeps the host app's own file-drop overlay off), and
      `filterDropFiles` reports files outside the accept list instead of
      silently ignoring them.
- [x] Wiki export/import (backup & migration): new `exportWiki` /
      `importWiki` Remotes (27 research methods total) snapshot all six wiki
      tables into one dated JSON envelope (`format: "mimir-wiki"`,
      `version: 2`); import revalidates the envelope and every row against
      its table's zod schema BEFORE any write (a bad snapshot changes
      nothing), `merge` upserts only absent primary keys (existing records
      are skipped, never overwritten — conservative first), `replace` wipes
      all six tables first and therefore requires `confirmReplace: true`.
      The overview's new data section downloads the export and walks imports
      through a summary card (per-table row counts), a merge/replace choice
      (replace arms a red second confirm), and the settled imported/skipped
      counts, then re-fetches every loaded slice.
- [x] Scheduled wiki auto-backup: a host-side timer (new `backup` config
      section — `enabled`/`intervalMinutes`/`keep`/`dir`, schemastery +
      resolveConfig validated) snapshots the wiki through the same
      `buildWikiSnapshot` constructor `exportWiki` uses (extracted into
      wiki-snapshot.ts, no copied logic) into
      `<workspaceDir>/backups/mimir-wiki-YYYYMMDD-HHmmss.json` (UTC, so
      lexicographic = chronological), atomic write via dsh-atomic-write,
      oldest pruned past `keep`; first pass one minute after start (startup
      stays fast), both timers unref'd, failures warn and retry next cycle,
      dispose clears the timers through the plugin effect lifecycle. A new
      `listBackups` Remote (28 methods) feeds the overview data section's
      status line (cadence · keep · on-disk count, or "off"); auto-backup
      files import back through the existing import flow unchanged.
- [x] Panel toast notifications: a corner stack bottom-right of the workbench
      (`toasts.ts` pure queue rules — 4s TTL, 4-card cap dropping the oldest,
      same copy+detail pushes refresh in place instead of stacking — plus a
      `ToastHost` render+timer component with a single sweep timer armed at
      the next expiry). Toasts carry locale keys so the controller stays
      locale-free; kinds map to green/blue/red accents. Triggers: compile
      ok/failed (with the failure message), paper/bib/wiki imports (with
      counts), probe-all settling, figure uploads, and every delete.

## Queue

### Servers

- [ ] Submit a remote job over SSH (run a training command) + poll job status
      — needs a real server address from the user, otherwise demo-only

### Planned hardening

- [ ] File-locked ledger record+event commit (P2 hardening): commit a ledger
      record and its event under one file lock so the append-only guarantee
      is hard, as self-noted in `packages/mimir/src/ledger.ts`

### UI/UX polish rounds

## Blocked (needs user input)

- Real GPU server host/credentials for end-to-end job submission testing
- `DEEPSEEK_API_KEY` for model-driven e2e (reviewer loop, paper writing)
