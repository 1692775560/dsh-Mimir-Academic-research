<div align="center">

<img src="docs/media/mimir-cover.png" alt="Mimir — open-source AI research workspace" width="720">

<h1>Mimir</h1>

<p><strong>The research-lifecycle copilot inside <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>:</strong><br>
literature · experiments &amp; remote GPUs · figures · LaTeX writing → compile → preview · group-meeting decks — one workbench, driven by your agent.</p>

<p>
<a href="https://github.com/1692775560/dsh-Mimir-Academic-research/actions/workflows/ci.yml"><img src="https://github.com/1692775560/dsh-Mimir-Academic-research/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
<a href="https://www.npmjs.com/package/dsh-mimir"><img src="https://img.shields.io/npm/v/dsh-mimir?label=dsh-mimir" alt="npm: dsh-mimir"></a>
<a href="https://mimir.smartlarkai.com"><img src="https://img.shields.io/badge/website-mimir.smartlarkai.com-47608c" alt="Website"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

<p><strong>English</strong> · <a href="README.zh.md">中文</a> · <a href="https://mimir.smartlarkai.com">Website</a></p>

</div>

## What it is

Mimir is a single npm package (`dsh-mimir`) that plugs into dsh and gives you:

- **Nine-view web workbench** (sidebar toggle → overlay, dark/light, 中/EN):
  **Overview** pipeline & stats · **Paper** Overleaf-style LaTeX studio (edit → compile → PDF preview, one-click AI fix) · **Library** arXiv + web search, AI relevance scoring, fullscreen PDF reader · **Experiments** metric charts, one-click paper figures · **Figures** upload/organize/insert into the paper · **Meetings** one-click group-meeting PPT (real paper figures + optional AI illustrations) · **Servers** GPU fleet probes + remote jobs · **Ledger** humanized research journal — idea evolution auto-captured into a worktree, six-perspective digest capsules, one-click progress report · **Venues** CCF conference-deadline countdown (ccfddl catalog, per-project watchlist) + CCF-A journal directory — every view live-refreshes over SSE as the agent writes, no manual reload
- **Agent tools & slash commands**: `/research-idea` `/research-plan` `/research-review` `/paper-write` `/paper-compile`, plus `arxiv_search`, `web_search`, `wiki_note`, `figure_save`, `latex_compile`, `meeting_deck`, `venue_search`, and the remote-compute quartet `server_list` / `server_check` / `server_submit_job` / `server_list_jobs` (same remembered servers and jobs as the Servers tab)
- **Eleven bundled research skills** (literature review, novelty check, experiment planning, citation audit, bilingual de-AI polish, rebuttal…) that teach the agent the workflow — no setup needed

| Overview | Paper | Library | Experiments |
| --- | --- | --- | --- |
| ![Overview](docs/screenshots/tab-overview.png) | ![Paper](docs/screenshots/tab-paper.png) | ![Library](docs/screenshots/tab-papers.png) | ![Experiments](docs/screenshots/tab-experiments.png) |

| Figures | Meetings | Servers | Ledger |
| --- | --- | --- | --- |
| ![Figures](docs/screenshots/tab-figures.png) | ![Meetings](docs/screenshots/tab-meetings.png) | ![Servers](docs/screenshots/tab-servers.png) | ![Ledger](docs/screenshots/tab-ledger.png) |

▶ [Full MP4 demo](https://raw.githubusercontent.com/1692775560/dsh-Mimir-Academic-research/main/docs/media/mimir-demo.mp4) (22 MB)

## Quickstart

Prerequisites: Node.js ≥ 22, the dsh CLI (`npm install -g @deepseek-ai/dsh`), and a `DEEPSEEK_API_KEY` for agent sessions.

```sh
dsh plugin --profile web add dsh-mimir@latest   # installs and self-activates
dsh web                                          # then open http://127.0.0.1:3080
```

Got an old version (e.g. 0.11.x/0.12.x)? dsh's plugin store uses pnpm, which holds back freshly published releases by default. Pin the exact version instead: `dsh plugin --profile web remove dsh-mimir && dsh plugin --profile web add dsh-mimir@0.14.1`

Version compatibility: **0.18.x requires dsh ≥ 0.1.2-alpha.4** (upstream breaking changes). On an older dsh, pin the previous release: `dsh plugin --profile web add dsh-mimir@0.16.0`.

Click **Mimir** in the sidebar footer. The wiki persists at `~/.dsh/storages/research_wiki.json`; artifacts land under `./.research`.

Optional capabilities:

- **Paper compilation** — install a LaTeX engine (`brew install tectonic` is easiest), or set `latex.engine` to a binary path
- **Web search** — the sxng CLI ships with the package; give it a SearXNG server with one command (Docker-free, local venv):
  ```sh
  bash scripts/setup-web-search.sh
  ```
- **Zotero** — set `zotero.apiKey` / `zotero.userId` in the plugin config (keys at zotero.org/settings/keys)

## Configuration

All keys are optional; set them in the profile's `cordis.patch.yml` (full commented example: [examples/mimir-agent/cordis.yml](examples/mimir-agent/cordis.yml)).

| Key | Default | Meaning |
| --- | --- | --- |
| `workspaceDir` | `.research` | Research workspace root (artifacts, backups) |
| `latex.engine` | `auto` | `latexmk` / `tectonic` probe, or absolute binary path |
| `search.command` | `auto` | Web search: `auto` uses `sxng` from PATH or the bundled copy |
| `reviewer.maxRounds` | `3` | Per-project review-round budget |
| `backup.enabled` / `intervalMinutes` / `keep` | `true` / `60` / `24` | Scheduled wiki snapshots |
| `skills.enabled` | `true` | Register the eleven bundled research skills |

## Troubleshooting

- **Plugin not found** — dsh resolves plugin names from the profile directory; install with `dsh plugin --profile web add dsh-mimir@latest`, not from your cwd.
- **LaTeX engine not found** — `brew install tectonic`, or point `latex.engine` at an absolute path. First tectonic compile downloads packages; raise `latex.timeoutMs` if it times out.
- **arXiv fails** — export `HTTPS_PROXY` before starting dsh when behind a proxy.
- **Web search unavailable** — run `bash scripts/setup-web-search.sh` (local SearXNG), or `sxng init` against your own instance, then restart dsh.

## Changelog

- **0.19.0** — issue-batch fixes: figure extraction honors cancellation end to end ([#233](https://github.com/1692775560/dsh-Mimir-Academic-research/issues/233)) · LaTeX `main.log` reads capped at a 1 MiB tail ([#234](https://github.com/1692775560/dsh-Mimir-Academic-research/issues/234)) · per-record venue-cache guard + a guarded localStorage codec ([#241](https://github.com/1692775560/dsh-Mimir-Academic-research/issues/241)) · reviewer rounds get a per-attempt timeout (new `reviewer.timeoutMs`, default 10 min), one fresh retry, and a structured failed outcome that no longer burns the round budget ([#246](https://github.com/1692775560/dsh-Mimir-Academic-research/issues/246)) · the reading-notes panel no longer drops paragraphs or legacy notes ([#248](https://github.com/1692775560/dsh-Mimir-Academic-research/issues/248)) · review-round merges by [@hkwuks](https://github.com/hkwuks): research PDF/figure route hardening ([#138](https://github.com/1692775560/dsh-Mimir-Academic-research/issues/138)), zotero 429 default wait ([#139](https://github.com/1692775560/dsh-Mimir-Academic-research/issues/139)), meeting-deck path validation ([#140](https://github.com/1692775560/dsh-Mimir-Academic-research/issues/140)), inverted moment-window guard ([#143](https://github.com/1692775560/dsh-Mimir-Academic-research/issues/143)), calendar-day venue countdown in the panel ([#142](https://github.com/1692775560/dsh-Mimir-Academic-research/issues/142)) · SSH jobs interrupted on host dispose, paper-source read/write lock coherence, figure insert/rename under the body lock ([#156](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/156)–[#159](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/159)) · CI style gate (`check-style.mjs`) with PR template and CONTRIBUTING hard gate
- **0.18.1** — stale subscription-lock recovery (a crashed writer no longer wedges every later check) and workspace-scoped coalescing of concurrent venue-cache refreshes by [@mikemikimike](https://github.com/mikemikimike) ([#144](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/144), fixes [#141](https://github.com/1692775560/dsh-Mimir-Academic-research/issues/141)) · sxng integration by [@hkwuks](https://github.com/hkwuks) ([#137](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/137)): optional `sxng-cli` tracks latest, missing-CLI guidance names your actual package manager, new `/skill-sync` command copies the upstream sxng skill into the dsh skills dir · devDependencies track dsh 0.1.2-rc.1 (verified against 0.1.3-alpha.1; peer floor unchanged)
- **0.18.0** — Features: **Venues** (ninth view): CCF conference-deadline countdown on the ccfddl catalog, per-project watchlist, CCF-A journal directory, `venue_search` agent tool · **SSE live refresh**: wiki writes push to the open panel over `/research/events`, every warm view follows agent/teammate edits without a reload · collapsible sidebar, narrower outline rail, compact buttons · verified architecture docs: [docs/architecture.md](docs/architecture.md) ([中文](docs/architecture.zh.md)). Fixes: two hardening rounds, 23 items — path-traversal / SSH-injection safety, load-time quarantine for unsafe library ids, SSE heartbeat write-guard + reconnect resync, autosave/save-lane races on project switch, subscription checks under the file lock, live-refresh starvation and stale-read guards; controller lifecycle isolation by [@hkwuks](https://github.com/hkwuks) ([#129](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/129))

- **0.17.1** — compact UI pass: all buttons one notch smaller (28px / 12px, one shared base style across every view); paper view panes keep usable min-widths (editor ≥ 360px) with a horizontal-scroll fallback instead of crushing the source column
- **0.17.0** — adapts to **dsh 0.1.2-alpha.4** (upstream removed `dsh-client-runtime`; injection now goes through `dsh-api-session-controller` + `dsh-client-ui-renderer`; breaking API alignment — fixes client type pollution and panel load failures on the new dsh). **Requires dsh ≥ 0.1.2-alpha.4; on older dsh stay on 0.16.0.** Also ships the moment timeline & eureka view by [@EriXPsy](https://github.com/EriXPsy) ([#127](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/127)): five-source moment candidates (burst / return-after-dormancy / cross-line convergence / long-sitting / milestone), canonical-candidate-declined timeline, read-only remotes
- **0.16.0** — Humanized ledger by [@EriXPsy](https://github.com/EriXPsy) ([#125](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/125)): CBE cognitive map, brief view, idea-evolution worktree with ambient auto-capture, six-perspective digest capsules; `research-paper-deai` bilingual de-AI polish skill by [@hkwuks](https://github.com/hkwuks) ([#126](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/126), synthesized from MIT-licensed aigc-humanizer-zh + blader/humanizer, LaTeX-safe with compile re-check)
- **0.15.1** — cancelling `web_search` now terminates the sxng child process (no more zombie processes) by [@hxhy](https://github.com/huixiaheyu) ([#124](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/124))
- **0.15.0** — SearXNG web search by [@hkwuks](https://github.com/hkwuks) ([#122](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/122)): sxng-cli config panel (SxngConfig) in the Library web tab, agent search routed through the sxng skill; local LaTeX project import by [@1692775560](https://github.com/1692775560); tolerant project args + PDF fullscreen portal by [@Nick](https://github.com/Nick) ([#120](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/120))
- **0.14.0** — SearXNG web search by [@hkwuks](https://github.com/hkwuks) ([#114](https://github.com/1692775560/dsh-Mimir-Academic-research/pull/114)): `web_search` tool + Library web-source tab; bundled sxng-cli + one-command SearXNG setup
- **0.13.0** — figure-by-figure meeting decks from real paper PDFs, `meeting_deck` agent tool, academic-Group-meeting-skills pipeline integration
- **0.12.0** — Meetings tab (group-meeting PPT), `research-meeting-deck` skill
- **0.11.0** — single-package install: the workbench ships inside `dsh-mimir` itself
- **0.10.0** — venue templates (CVPR/NeurIPS/ACL/IEEE/ACM…), custom kit upload, format-to-venue
- **0.9.0** — per-project literature, AI relevance scoring, figure rename/caption + `figure_organize`, fullscreen PDF reader
- **0.8.x** — bundled research skills; collapsible subscriptions & project list
- **0.7.0** — Zotero integration; Linear-style visual overhaul
- **Earlier** — arXiv subscriptions, paper snapshots (diff/revert), metric→figure generation, related-work drafts, job writeback

## Contributing

Branch off `main` (`feature/<name>` / `fix/<name>`), keep `pnpm run build && pnpm test && pnpm run typecheck` green, and open a PR — see [CONTRIBUTING.md](CONTRIBUTING.md). Please merge PRs with a **merge commit** (not squash) so contributor authorship shows up on the contributors graph. For the big picture, start with the verified architecture overview: [docs/architecture.md](docs/architecture.md) ([中文](docs/architecture.zh.md)).

Contributors so far: [@EriXPsy](https://github.com/EriXPsy) (Ledger view, humanized journal) · [@hkwuks](https://github.com/hkwuks) (SearXNG web search, [sxng CLI](https://github.com/hkwuks/sxng-cli), de-AI skill) · [@hxhy](https://github.com/huixiaheyu) (web_search cancellation fix)

## Community

Questions, ideas, or show-and-tell — join the WeChat group. The group QR refreshes every 7 days; if it has expired, add Nick and he'll pull you in:

<p>
  <img src="docs/wechat-group.jpg" alt="Mimir WeChat group" width="180">
  &nbsp;&nbsp;
  <img src="docs/wechat-contact.jpg" alt="Nick (maintainer) WeChat" width="180">
</p>
<p><sub>Left: group chat · Right: Nick (maintainer) — fallback when the group QR expires</sub></p>

## Support

If Mimir saved you time, buy the devs a coffee — every bit goes into keeping the project alive:

<img src="docs/sponsor-wechat.jpg" alt="Sponsor via WeChat Pay" width="180">

## Acknowledgments

- Workflow inspiration: [ARIS / Auto-claude-code-research-in-sleep](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep)
- Built on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin platform

## License

[MIT](LICENSE)
