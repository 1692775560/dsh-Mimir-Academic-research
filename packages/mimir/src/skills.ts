/**
 * Bundled research skills: the ARIS-style workflow playbooks shipped inside
 * the plugin itself. Each skill is a `ctx.skills.register()` runtime
 * contribution (rank 250 — project-level skills still outrank them, user-level
 * ones yield), so the suite works out of the box in any composition that
 * mounts the skill registry, and stays silent in one that does not. Bodies
 * reference only surfaces this package actually provides: the `arxiv_search`,
 * `paper_fetch`, `wiki_note`, `figure_save`, and `latex_compile` tools, the
 * `research-idea` / `research-plan` / `research-review` / `paper-write` /
 * `paper-compile` commands, the workspace artifacts (IDEA_REPORT.md,
 * EXPERIMENT_PLAN.md, EXPERIMENT_LOG.md, NARRATIVE_REPORT.md), and the web
 * workbench tabs. Web search (the 文献 tab's Web source) is treated as
 * arXiv's peer: every skill that searches the literature runs arXiv for
 * papers and loads the `sxng` skill for non-arXiv sources (official docs,
 * blog posts, code repositories, venue pages, 组会 material) — and only
 * persists findings through the wiki, never the raw search.
 *
 * The content lives as template literals for the same reason templates.ts
 * cites: published packages ship `lib/` only, so runtime assets must ride the
 * bundle.
 *
 * The prose-editing skill `research-paper-deai` synthesizes two MIT-licensed
 * upstreams — aigc-humanizer-zh (16 Chinese academic modes + 7 hard
 * constraints) and blader/humanizer (35 English patterns from Wikipedia's
 * "Signs of AI writing") — into a single bilingual LaTeX-safe pass; both
 * upstreams are credited in the skill body itself.
 * @module dsh-mimir/src/skills
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.skills Context merge; the service itself is
// consumed optionally through ctx.inject below.
import type {} from '@deepseek-ai/dsh-skill'

/** One bundled skill body plus its routing metadata. */
interface BundledSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly content: string
}

const SHARED_RULES = String.raw`
## Standing rules

- Persist every durable finding with \`wiki_note\` the moment you have it —
  papers into \`papers\`, hypotheses into \`ideas\`, claims into \`claims\`,
  run outcomes into \`experiments\`. The web workbench renders these tables;
  a finding that is only in the chat is lost work.
- Failed directions are assets: close them out with
  \`wiki_note { action: 'fail_idea', ... }\` (the wiki never deletes ideas) so
  the next pass does not re-walk a dead end.
- Keep the project record honest: \`wiki_note { action: 'set_project' }\`
  with stage \`idea\` / \`plan\` / \`experiment\` / \`writing\` / \`done\` as
  the work crosses each gate.
- Prefer one verified fact over three plausible ones. Cite arXiv ids, file
  paths, and experiment ids as evidence pointers, never from memory alone.
- Search with both hands: \`arxiv_search\` for papers, and for non-arXiv
  sources (official docs, blog posts, code repositories, venue pages) load
  the \`sxng\` skill — the agent's web search is driven by that skill, not by
  a tool. Run both when a stage says "search" — arXiv-only misses the
  engineering landscape; web-only misses the paper record. Never persist raw
  search output to the wiki; only curated \`wiki_note\` findings land there.
- When you load the \`sxng\` skill, let it decide the depth: a simple
  \`sxng\` query for a one-shot factual lookup, its L2/L3 \`--session\`
  deep-search flow (extract → quality → approve → iterate) when the question
  is multi-dimensional or the first round comes back incomplete. Run its
  commands through the bash tool with the \`sxng\` CLI; the shared
  \`~/sxng-cli/sxng.config.json\` (editable in the Library view's Web tab)
  configures both sxng and the panel.
`

export const RESEARCH_PIPELINE = String.raw`
# Research Pipeline — end-to-end orchestration

Drive one research project through the full Mimir loop. Run the stages in
order; do not skip a gate to save time — each gate exists because skipping it
once cost a paper.

## Stages

1. **Ideation** — run the \`research-idea\` command on the direction. It
   produces IDEA_REPORT.md and registers ideas in the wiki. If the user
   already has a written idea, record it with
   \`wiki_note { action: 'add_idea' }\` and move on.
2. **Novelty gate** — invoke the \`research-novelty-check\` skill on the
   leading idea. A "known" verdict is not failure: pivot the angle and
   re-check once. Two independent "known" verdicts kill the idea — record
   \`fail_idea\` and pick the next one.
3. **Literature base** — invoke the \`research-lit-review\` skill until the
   wiki holds the 8–15 papers that define the problem, the baselines, and
   the evaluation protocol you will be judged against.
4. **Plan** — run \`research-plan\`. It turns IDEA_REPORT.md into
   EXPERIMENT_PLAN.md and registers every claim as \`pending\`. If claims
   look wrong, fix the plan before any compute is spent.
5. **Experiments** — invoke \`research-experiment-plan\` to sequence the
   runs, then execute. Log every run with
   \`wiki_note { action: 'add_experiment' }\` and keep EXPERIMENT_LOG.md
   append-only current.
6. **Claim gate** — invoke \`research-result-to-claim\` before writing a
   single section. Unsupported claims get cut or get more experiments;
   they never get written as if supported.
7. **Writing** — run \`paper-write\` (or invoke \`research-paper-drafting\`
   for a slower, section-by-section pass with human checkpoints). Compile
   early and often with \`latex_compile\`.
8. **Review** — run \`research-review\`. WARN/FAIL verdicts come back as
   issues; revise and re-run until PASS or the round budget is spent, then
   surface the remaining issues to the user honestly.
9. **Done** — \`set_project\` stage \`done\`. If reviews arrive from a venue,
   invoke \`research-rebuttal\`.

## Escalation

Stop and ask the user when: the novelty gate kills every idea on the table;
the compute budget implied by EXPERIMENT_PLAN.md exceeds what the registered
servers can run; or two consecutive review rounds fail on the same issue.
` + SHARED_RULES

export const RESEARCH_LIT_REVIEW = String.raw`
# Literature Review — build the wiki's paper base

Turn a research direction into a curated, noted, citable paper set in the
wiki's \`papers\` table (rendered in the workbench's 文献 / Literature tab).

## Loop

1. **Search** — arXiv and Web in parallel:
   - \`arxiv_search\`: start broad (the problem statement), then narrow (the
     specific method family, the benchmark, the strongest baseline). Rewrite
     the query at least twice — first-pass queries miss half the field.
   - Load the \`sxng\` skill: same angles, for non-arXiv sources — official
     documentation, engineering blogs, code repositories, workshop/venue
     pages. Academic claims still anchor on arXiv ids.
2. **Triage** each result by title + abstract: defining works, must-beat
   baselines, and the evaluation suite. Skip anything you cannot state a
   concrete reason to keep.
3. **Persist** each keeper immediately:
   \`wiki_note { action: 'add_paper', arxiv_id, title, authors, summary, url,
   notes }\` — \`notes\` carries YOUR one-paragraph read: what it does, what
   it leaves open, why it matters to this project. An entry without notes is
   a bookmark, not a review. A web-only source (no arXiv id) persists with
   its URL and the same notes discipline — the wiki accepts it either way.
4. **Fetch** the PDF with \`paper_fetch\` for any paper you will cite for a
   specific claim — the workbench's reader plus its note sidebar is the
   deep-reading surface.
5. **Zotero** — if the user has configured \`zotero.apiKey\` / \`userId\`,
   the 文献 tab can import whole collections and export the wiki back to
   .bib; suggest it when the user mentions an existing Zotero library.
6. **Subscriptions** — for a long-running project, suggest adding an arXiv
   subscription in the 文献 tab so new papers surface daily.

## Done when

The wiki holds enough papers that you can name, without searching again: the
problem's origin, the two strongest baselines, the standard benchmark, and
the one result nobody has explained. State those four to the user as the
review's summary.
` + SHARED_RULES

export const RESEARCH_NOVELTY_CHECK = String.raw`
# Novelty Check — is this idea already done?

Verdict-bearing gate: decide whether the literature already contains the
proposed contribution. Run it BEFORE writing code or spending compute.

## Method

1. **Distill** the idea to its load-bearing sentence: "we are the first to
   <do X> <for Y> <achieving Z>". If you cannot write that sentence, the
   idea is not ready for a novelty check — say so.
2. **Attack it** with \`arxiv_search\` from three directions: the mechanism
   (X), the application (Y), and the claimed result (Z). Use the search
   syntax the tool supports (field prefixes, \`AND\`/\`OR\`), and read
   abstracts of every plausible hit — title-level dismissal is how novelty
   checks fail. For each direction, also load the \`sxng\` skill — work that
   never reached arXiv (a thesis, a company blog, a workshop report) is
   exactly where an unpublished competitor hides.
3. **Widen once**: if arXiv is thin, check the adjacent venues by name in
   the query (the field knows its conferences), and use \`sxng\` on the
   venue's program pages and the lab sites of the active groups in X/Y/Z.
4. **Judge** honestly:
   - **Known** — a prior work does X for Y. Name it with its arXiv id (or its
     URL when it never reached arXiv).
   - **Adjacent** — X exists but not for Y, or Y is addressed but not by X.
     The delta must be stated in one sentence; if that sentence is weak, the
     verdict is effectively known.
   - **Novel** — nothing within the search's reach does X for Y, and the
     closest three works each miss a named piece.
5. **Record** the verdict in the wiki: attach it to the idea's notes, or on
   "known", \`wiki_note { action: 'fail_idea', reason }\` citing the killing
   paper.

## Hard rules

- Never issue "novel" from memory of the field — only from searches run in
  this session.
- "I found nothing" with weak queries means nothing. Show the queries.
- One strong killing paper outweighs any amount of enthusiasm.
` + SHARED_RULES

export const RESEARCH_EXPERIMENT_PLAN = String.raw`
# Experiment Plan — claim-driven validation design

Turn EXPERIMENT_PLAN.md's claims into a concrete run order. Every run exists
to move one claim out of \`pending\`; a run that maps to no claim is cut.

## Design

1. **List the claims** from the wiki (\`wiki_note { action: 'list',
   table: 'claims' }\`). For each, name the single result that would support
   it and the single result that would kill it.
2. **Benchmark reality-check** — one pass before sequencing: \`arxiv_search\`
   the strongest baselines the paper will be judged against (name them with
   their result), and use \`sxng\` (loaded as a skill) on the current state
   of the field (leaderboards, official repos, released checkpoints) so the
   plan does not promise a run that already exists. Findings persist as wiki
   notes, not raw search.
3. **Sequence**: main result first (the table the paper lives or dies by),
   then ablations ordered by claim coverage per GPU-hour, then robustness
   (seeds, datasets). Baselines run before or alongside, never after.
3. **Budget**: state the compute each run needs and where it runs — check
   \`server_list\` for registered machines and \`server_check\` for their GPU
   probe results before promising a schedule (the 服务器 / Servers tab is the
   same state). Jobs can be dispatched with \`server_submit_job\` and tracked
   with \`server_list_jobs\`; their ids belong in the experiment records.
4. **Register** every planned run:
   \`wiki_note { action: 'add_experiment', project_id, name, metrics }\`
   with the hypothesis in the name and the target metrics explicit.
5. **Write it down**: keep EXPERIMENT_PLAN.md as the human-readable mirror
   (setup, baselines, ablation matrix, decision rules for pivoting).

## During execution

- EXPERIMENT_LOG.md is append-only: one block per run with config, seed,
  result, and verdict against the hypothesis.
- On run completion, \`wiki_note { action: 'set_experiment', status:
  'success' | 'failed', metrics, log_path }\` — never leave runs \`running\`
  once they finish; stale running rows corrupt the panel's status view.
- A failed run still updates claims: negative evidence is evidence.
` + SHARED_RULES

export const RESEARCH_RESULT_TO_CLAIM = String.raw`
# Result-to-Claim Gate — what do the experiments actually prove?

Verdict-bearing gate between experiments and writing. The question is never
"are the results good" but "which claims do these results support".

## Procedure

1. Pull the claims (\`wiki_note { action: 'list', table: 'claims' }\`) and
   the experiments (\`action: 'list', table: 'experiments'\`).
2. For each claim, lay the evidence beside it: which runs, which metrics,
   which baselines beaten (or not). Read EXPERIMENT_LOG.md, not summaries of
   summaries. If a claim hinges on the state of an external baseline or a
   released artifact, use \`sxng\` (loaded as a skill) on it (leaderboard
   row, official numbers, repository) before judging — the comparison must be
   against what is actually out there, not a remembered number.
3. Judge each claim:
   - **Supported** — the named evidence directly shows it, including the
     comparison against the strongest baseline, not an easy one.
     \`wiki_note { action: 'set_claim', status: 'supported', evidence }\`
     with evidence pointing at experiment ids / log paths.
   - **Invalidated** — the evidence contradicts it. Mark
     \`status: 'invalidated'\` and say what the results suggest instead; an
     invalidated main claim usually pivots the paper's story.
   - **Pending** — evidence is missing, mixed, or under-powered (one seed,
     no significance, wrong baseline). Name the ONE run that would settle it.
4. **Report** the routing to the user: claims supported → write; claims
   pending → the exact supplementary runs; claims invalidated → pivot
   options with their costs.

## Hard rules

- No claim advances on vibes, trends, or "the number looks right".
- The paper may only assert claims marked \`supported\`; \`pending\` claims
  are written as limitations or not at all.
` + SHARED_RULES

export const RESEARCH_PAPER_DRAFTING = String.raw`
# Paper Drafting — section by section, compile as you go

Draft the LaTeX paper inside the project's paper directory. For the
one-shot scaffolding path use the \`paper-write\` command instead; this
skill is the deliberate, checkpointed path.

## Setup

1. Read the wiki first: supported claims, the experiment table, the paper
   list. The paper's skeleton is the claim list, not a generic ML template.
2. Confirm the paper directory (the workbench's 论文 / Paper tab shows it)
   and that \`main.tex\` + \`references.bib\` exist; scaffold from the
   suite's templates if not.

## Per-section loop

For each section, in paper order (abstract LAST, but keep a stub):

1. Draft against the evidence: every number in the text traces to an
   experiment record; every \\cite{} key exists in the .bib (add missing
   entries from the wiki's papers — the 文献 tab can also export the wiki to
   .bib). When a paragraph cites a non-arXiv fact (a released checkpoint, a
   benchmark's official numbers, an engineering claim), the source was found
   with \`sxng\` (the skill, loaded during the lit-review stage) and lives in
   the wiki — do not re-google mid-draft and cite from a fresh tab.
2. Compile with \`latex_compile\` immediately. Fix errors before writing the
   next section — LaTeX errors compound and the log parser pinpoints them
   one at a time.
3. Checkpoint with the user after the introduction and after the
   experiments section: these two carry the story and the evidence, and a
   wrong direction there wastes the rest.

## De-AI pass

When the draft sections read complete, run the \`research-paper-deai\`
skill over the finished prose before checkpointing, then compile again:
it removes AI-writing tells from the Chinese and English text alike while
leaving every number, formula, and \\cite{} byte-identical — the paper that
compiles and the paper that reads well are both your responsibility.

## Standards

- Claims discipline: assert only \`supported\` claims; \`pending\` evidence
  goes to limitations.
- Figures: plan them with the \`research-figure-plan\` skill; reference only
  files that exist in the paper directory's \`figures/\`.
- The workbench compiles and snapshots on success, so the user can diff and
  revert — do not hand-edit around history; compile through the tool.
` + SHARED_RULES

export const RESEARCH_PAPER_DEAI = String.raw`
# Paper De-AI — 去 AI 味润色（中英双语）

Final prose pass over the paper draft: remove AI-writing tells so the text
reads like a careful human researcher wrote it — without changing a fact,
number, equation, formula, or citation. This is an editing pass on the
paper's prose, not a content pass. Use when the user says 去AI味 / 去 AI /
de-AI / humanize / 润色, or after \`research-paper-drafting\` and before
submission.

## Procedure (per section)

For each section of \`main.tex\` (title → abstract → intro → method →
experiments → discussion → related work):

1. **Mask LaTeX first** — protect whatever must never change before touching
   a paragraph. Replace each formula/ref/citation with a placeholder:
   \`$...$\`, \`$$...$$\`, and math environments (\`\\begin{align}...\\end{align}\`
   and kin) become \`[MATH_1]\`; \`\\cite{...}\`, \`\\ref{...}\`, \`\\label{...}\`,
   \`\\eqref{...}\`, and any \\command{...} that carries a number or key become
   \`[CITE_7]\`-style markers. Treat whole non-prose environments as single
   blocks: \`\\begin{table}...\\end{table}\`, \`\\begin{figure}...\\end{figure}\`,
   \`\\begin{algorithm}...\\end{algorithm}\` each become one \`[TABLE_1]\` /
   \`[FIGURE_1]\` / \`[ALGO_1]\` placeholder — inner tabular, tikzpicture, and
   pseudocode are never rewritten, only the \`\\caption{...}\` inside may be
   polished. Keep every placeholder byte-identical during rewriting.
2. **Detect the language** per paragraph (zh vs en by dominant script). Apply
   the matching pattern set below — the zh set mainly hits Chinese prose, the
   en set covers English sentences whatever the paper's primary language.
3. **Audit** — scan the paragraph for patterns in the active set. Quote each
   hit before rewriting. Statistical patterns (P13–P16, en §14/§15/§16) need
   counting over the paragraph or whole-document scope.
4. **Rewrite** — apply the fix order below, preserving facts, numbers,
   citations, equations, and term definitions exactly. Merge and split
   sentences freely; never soften a supported claim nor strengthen an
   unsupported one.
5. **Verify** — re-read the whole section and ask:
   - What still sounds like AI?
   - Did this pass add or remove any fact, number, citation, equation, or claim?
   Then restore the placeholders byte-for-byte (\`[MATH_1]\` → the exact
   original formula) and compile with \`latex_compile\` — an unbalanced \$\$
   or a broken \\cite is caught by the compile, not by eye. Check the
   compiled PDF preview for how it *reads*, not just that it builds.

## Fix order (SOP)

Priority, most impact first:

1. **Keyword/pattern replacement** — P8/P10/P11 (zh), en §1–§3/§5/§7.
2. **Sentence restructure** — move theory out of the opening sentence; merge
   repeated openings; break parallel triads (P3/P6/P13/P14, en §9–§11).
3. **Cut the tail** — delete sentence-end recap and generic positive endings
   (P2/P7, en §6/§25/§27/§28/§29).
4. **Sharpen attribution** — name a real source or convert to the paper's own
   analysis; never fabricate a citation (P8, en §5).
5. **Rebalance rhythm** — vary sentence length; drop in one 5–10-char
   (6–12-word) sentence per paragraph; rebuild a caption only if meaning
   requires.
6. **Add a human note** — researcher judgment / surprise / limits (see below).

## 中文学术模式（主体取自 aigc-humanizer-zh 16 模式）

- **P1 理论起笔** — 依据 / 基于……理论 / 根据……框架 / 按照……观点 在段首。把理论
  移到段落中部，让观察先行：现象描述在前，理论在需要解释时才引入。
- **P2 段末套路结尾** — 此案例印证了 / 此案例揭示了 / 这提示我们 / 从中可以看出
  收尾。删除「总结+引申+点题」句式；如需收束，用一句具体判断或转折提问。
- **P3 整齐编号逻辑** — 首先/其次/再次、第一/第二、其一/其二，各项等长对称。
  改成非等长结构（「最根本的是…此外…至于…」），重要的理由多写。
- **P4 被动分析套话** — 该处理体现了 / 该设计基于 / 这一做法展现了。改为研究者的
  真实决策过程：「初期定量分析解释不了几个异常值，才引入深度访谈」。
- **P5 模板化问题陈述** — 面临的核心问题是 / 核心挑战在于。换为具体的矛盾情境
  或反诘疑问句，把张力演示出来。
- **P6 三元并列对称** — 理论上/实践上/方法上、制度/组织/个体三层面。打破等长
  三元，最重要的维度多说，次要的合并或一句带过。
- **P7 段末冗余总结** — 综上所述 / 由此可见 / 难不难发现。删除；确实需要收尾时
  用一句具体判断替代泛化总结。
- **P8 模糊归因** — 专家认为 / 学者认为 / 研究表明（无出处）。有来源则引用；无
  来源改写为本文自身分析。注意：本研究表明、Boulianne(2015)研究表明 不是此模式。
- **P9 填充短语与过度限定** — 值得注意的是 / 需要指出的是 / 总体而言 直接删；
  一句只保留一个不确定性限定词，去掉「可能在一定程度上潜在地」堆叠。
- **P10 泛化结论与意义声明** — 具有重要意义 / 前景广阔 / 未来可期 / 提供了新思路。
  替换为可检验的推论或具体后续方向，而非空洞乐观。
- **P11 AI 高频词** — 深刻揭示→说明/表明；具有重要意义→直说意义；不可或缺→离不开；
  综合运用→结合；深入探讨→分析/考察；系统梳理→梳理；提供了理论支撑→解释了。
- **P12 回避系动词「是」** — 作为……的重要载体 / 扮演着……的角色 / 发挥着……的
  作用 → 直接用「是」。
- **P13 过度对仗排比** ⚡ — 四字短语连续出现 4 次以上。打破工整排比，集中写最有
  价值的贡献点。
- **P14 结构性三步走** ⚡ — 从经济维度看 / 从社会维度看 / 从文化维度看 的等重
  三段式。去掉等重框架，最强的维度先说、多说，意外发现单独提出。
- **P15 破折号密度** ⚡ — 一段内 ——/— 超过 4 次，或连续冒号 3 次以上。部分改
  为句子切分或逗号。
- **P16 正文加粗滥用** ⚡ — 全文 **…** 超过 5 处。解除加粗，用句式变化替代强调。

## English patterns（主体取自 blader/humanizer 35 模式，学术向）

- **§1 Inflated importance/legacy** — pivotal/significant/crucial/key role,
  marking/shaping/highlights its significance, symbolic of a broader trend →
  plain statement ("…was established in 1989, part of a wider decentralization").
- **§2 Name-dropping** — a list of outlets or follower counts meant to prove
  importance → keep only citations the text actually uses.
- **§3 Shallow -ing framing** — highlighting/underscoring/ensuring at the end
  of an assertion → flat assertion.
- **§4 Sales language** — boasts/vibrant/groundbreaking/rich in → neutral register.
- **§5 Vague sources** — industry reports / experts argue / several sources →
  name the real source or cut.
- **§6 Formulaic challenges/outlook** — stock "Despite…faces several
  challenges…continues to thrive" → concrete facts; dates only when sourced.
- **§7 Overused AI words** — delve/underscore/tapestry/interplay/intricate/
  leverage/fostering/highlight (verb)/pivotal — in *groups*; a single word in
  a precise technical sense is not a tell.
- **§8 Avoiding is/are** — serves as / stands as / represents [a] → is/has.
- **§9 "Not X but Y" and clipped negatives** — "It's not just X, it's Y" →
  the direct claim; "no guessing" → "without forcing the user to guess".
- **§10 Forced groups of three** → two or one, as the content justifies.
- **§11 Synonym cycling / repeated openings** — renaming the same subject
  twice+, or several sentences opening with the same subject → one name,
  merge or re-open on the action.
- **§12 False from-X-to-Y ranges** — "from the Big Bang to the cosmic web" →
  the actual coverage.
- **§13 Passive voice + missing subjects** — "No configuration file needed.
  Results are preserved automatically." → active with named actors.
- **§14 Em/en dashes** — final pass should contain none (spaced " — " and
  "--" included) unless the paper's own voice uses them; replace with comma,
  period, or colon. In an academic draft the paper's existing prose is the
  sample — match its dash habit, don't ban one lone dash in a quotation.
  A single §4-like tell alone is not proof; flag dashes only when stacked
  with other patterns.
- **§15/§16 Bold abuse and bold mini-heading lists** — un-bold; inline the list.
- **§23 Filler** — in order to / due to the fact that / at this point in
  time / has the ability to / it is important to note that → because / now /
  can / "the data shows".
- **§24 Qualifier stacking** — could potentially possibly → one qualifier.
- **§25 Generic positive endings** → end on the last concrete fact.
- **§27 Pretending to reveal a deep truth** — the real question is / at its
  core / fundamentally → plain claim.
- **§28 Announcing the next point** — let's dive into / here's what you need
  to know → state it.
- **§29 Heading repeated in first sentence** → cut the repeat.
- **§31 Forced punchlines/fragments** → merge into prose.
- **§32 Formulaic sayings** — "X is the language of Y" → the specific claim.
- **§34/§35 Unattributed objections / fake alternatives** — state the real
  constraint directly; drop a strawman the text never needed.

## 硬约束（HC-1 ~ HC-7，命中即修复）

Before returning the rewrite, check the whole \`main.tex\` scope:

| # | 约束 / constraint | 阈值 threshold |
| --- | --- | --- |
| HC-1 | 高频词密度 / overused AI words | ≤2/段（per paragraph） |
| HC-2 | 段末总结套句 / sentence-end recap | ≤1/全文（whole doc） |
| HC-3 | 整齐三元并列 / forced triads | ≤1/段（per paragraph） |
| HC-4 | 理论起笔段落占比 / theory-openers | ≤20% 段落 |
| HC-5 | 正文加粗 / bold | ≤5/全文 |
| HC-6 | 泛化结尾 / generic-positive endings | 0 |
| HC-7 | 模糊归因 / vague attribution | 0 |

## 注入学者视角

去痕之后的文字若「干净却无魂」仍会被识别为机器稿：

- **承认局限** — 把局限放在它真实的位置：「这里的数据不够理想，只能做个初步判断」
  / "These numbers are too noisy for a firm claim."
- **表达意外** — 「出乎意料的是，访谈中没有一位受访者提到……」/ "Unexpectedly,
  no participant mentioned…".
- **留下判断** — 「笔者认为，这一解释固然有其道理，但……」/ "This reading,
  though defensible, …".
- **短句造节奏** — 每段夹一个 5–10 字短句打破长句的连续。

## 噪声保留原则

不要把每段都改得风格一致——人类写作本身有波动，去味的目标是「像人写的」，
不是「零 AI 特征」：

- 只在确实自然处保留轻微 AI 特征（轻度双项并列、程度较轻的过渡词），并以此为
  度校准全文，而不是刻意制造统一腔调。
- 不保留：「此案例印证了」「具有重要意义」、任何模糊归因——这些是 HC-2/6/7
  命中的硬伤，必须清掉。
- 成语/口语在叙述里自然出现即可，不堆砌。

## 不要误报（false positives）

- 完美的语法和一致的风格不是 AI 证明——专业作者本就如此。
- 正式学术词汇不是痕迹，除非在黑名单里且成堆出现。一个 Moreover / 一个然而 没事。
- 单独的 em dash 在英文中不算（许多编辑惯用）；要和其它特征同时出现才算。
- 弯引号单独出现不算——macOS/Word/Google Docs 默认自动卷曲。
- 一句短句作强调可以，**连续**短片段才是 AI 信号。
- 引文、标题、专名、正在被讨论的短语保持逐字不动——不要改写二手文本。
- 干净但「没有灵魂」不是模式命中，不要为了热闹把真诚的平淡改花。

## 收尾核查

All sections done, run the whole-tex checklist:

- HC-1…HC-7 across the entire \`main.tex\`.
- Every number / \\cite / \\ref / formula matches the wiki experiment and
  evaluation records — nothing invented, nothing quietly dropped.
- No claim strengthened beyond a \`supported\` verdict, no unsupported claim
  added.
- Compile clean, PDF preview reads like a person who ran those experiments.

## 来源说明

zh 模式为 aigc-humanizer-zh（MIT, shuohui-air-technology）16 模式引擎的程序化
浓缩；en 模式为 blader/humanizer（MIT, Siqi Chen），其模式编码自维基百科
"Signs of AI writing"（WikiProject AI Cleanup）。
` + SHARED_RULES

export const RESEARCH_CITATION_AUDIT = String.raw`
# Citation Audit — every bib entry real, every citation earned

Verdict-bearing audit before submission. Two questions: does each cited work
exist as described, and does the citing sentence actually need it?

## Procedure

1. **Inventory**: parse the paper directory's .bib (the suite's bibtex
   parser keeps it structured) and list every \\cite{} in the .tex with its
   sentence.
2. **Existence**: for each entry, verify against a live source —
   \`arxiv_search\` by title (and author surname when the title is common),
   and \`sxng\` (via the skill) for anything that never reached arXiv (a
   report, a thesis, a company publication, a venue's proceedings page) so a
   title fabricated from memory cannot pass on a missing arXiv id.
   Flag: hallucinated titles, wrong authors, wrong years, wrong venues,
   arXiv id pointing at a different paper (version drift counts).
3. **Context**: for each citation sentence, read the cited abstract and
   judge whether the sentence's claim is one the cited work supports.
   Flag: citing a paper for something it explicitly does not do, citing a
   survey as if it were the original, citing a baseline's reimplementation
   instead of the source. When the cited fact is non-arXiv (a checkpoint's
   license, an official benchmark number), use \`sxng\` (via the skill) on
   the current source rather than trusting the .bib entry.
4. **Coverage**: uncited entries in the .bib are either dead weight (remove)
   or a sign a related-work paragraph went missing (flag).
5. **Fix or report**: mechanical fixes (wrong year, dead entries) apply
   directly and recompile with \`latex_compile\`; judgment calls (wrong-
   context citations) go to the user as a numbered list — never silently
   rewrite the scholarship.

## Hard rules

- Verify from searches run in this session; training-memory bibliographies
  are the exact failure mode this audit exists to catch.
- Every flag cites the evidence: the search query, the found record, the
  mismatch.
` + SHARED_RULES

export const RESEARCH_REBUTTAL = String.raw`
# Rebuttal — answer the reviews you got, not the ones you wanted

Draft a grounded, venue-limited response to external reviews.

## Procedure

1. **Parse** the reviews into atomic concerns: one row per concrete
   question, criticism, or requested experiment. Merge duplicates across
   reviewers; note who raised what.
2. **Triage** each concern:
   - *Answerable from the paper/logs* — answer with section, table, or
     experiment-id pointers. Quote numbers exactly as logged.
   - *Needs new evidence* — scope the smallest experiment that answers it,
     check feasibility against the rebuttal window and the registered
     servers, and only promise what can actually be run. Use \`sxng\` (the
     skill) on the cited works and the current field state before claiming a
     gap — the reviewer may be pointing at something real that never hit
     arXiv.
   - *Misunderstanding* — correct it once, politely, with the exact quote
     from the paper that already addresses it.
3. **Draft** response-first: every answer opens with the concession or the
   correction, then the evidence. No new claims appear in a rebuttal that
   the paper's evidence cannot already carry — mark anything speculative as
   future work explicitly.
4. **Budget** to the venue's limit (characters/pages). Cut adjectives
   before cutting evidence.
5. **Track** any experiments run for the rebuttal like real ones:
   \`wiki_note { action: 'add_experiment' }\`, EXPERIMENT_LOG.md, and
   \`set_claim\` updates if they move a claim.

## Hard rules

- Never fabricate a result to satisfy a reviewer; an honest "we cannot run
  this in the window, here is the closest existing evidence" beats a
  invented number every time.
- Tone: grateful for real catches, firm on misreadings, never defensive.
` + SHARED_RULES

export const RESEARCH_FIGURE_PLAN = String.raw`
# Figure Plan — figures that carry claims, filed where they belong

Design and produce the paper's figures so each one earns its column width.

## Plan

1. For each supported claim, decide the figure or table that makes a
   reviewer believe it in five seconds: the main-result figure first, one
   mechanism/Architecture overview, then ablations.
2. Write a one-line spec per figure: what varies on each axis, which
   baselines appear, what the reader should conclude. A figure without that
   sentence is decoration — cut it. When the figure compares against an
   external result, use \`sxng\` (the skill) on the authoritative number
   (leaderboard row, official report) and spec it as the reference, not a
   remembered value.

## Produce

- Prefer reproducible sources: plot scripts reading EXPERIMENT_LOG.md data
  over hand-drawn numbers; TikZ/pgfplots or matplotlib output committed
  beside the paper.
- Save every figure through \`figure_save\` (or the 图表 / Figures tab's
  upload) so it lands in the paper directory's \`figures/\` AND in the
  wiki's figure registry with a caption and source note — figures saved any
  other way are invisible to the workbench.
- SVG sources convert through the workbench's converter (configure
  \`svg.converter\` — resvg/inkscape/rsvg/chromium — or install librsvg for
  vector PDF output).

## Verify

- \`latex_compile\` after adding figures; a missing file or a blown
  \\includegraphics width is caught by the compile, not by eye.
- Check the compiled PDF preview in the 论文 tab: every figure legible at
  column width, referenced in the text, and captioned with its takeaway.
` + SHARED_RULES

// Path A below drives the academic-Group-meeting-skills pipeline directly
// (https://github.com/mlxbc12138/academic-Group-meeting-skills) — cloned at
// first use, never vendored (the upstream repo ships no license file, so we
// reference rather than copy it). Its slide-voice rules (Microsoft YaHei,
// image-left/caption-right, Fig.X Chinese takeaway captions) also govern the
// Path-B renderer. Credit and thanks to the upstream authors.
export const RESEARCH_MEETING_DECK = String.raw`
# Meeting Deck — 组会 PPT：逐图精读 or 全项目汇报

Two decks, two engines. Pick by what the user asked for:

- **Path A — 单篇文献逐图精读**: one paper, one slide per figure, reference
  deck style. Drives the upstream academic-Group-meeting-skills script.
- **Path B — 全项目组会汇报**: progress + experiments + figures + selected
  papers, rendered deterministically by the \`meeting_deck\` tool.

Both land in \`<workspace>/meetings/<projectId>/\`, so the workbench's 组会 /
Meetings tab lists and downloads them.

## Path A — figure-by-figure deck of ONE paper

1. First use only, clone the upstream skill:
   \`git clone --depth 1 https://github.com/mlxbc12138/academic-Group-meeting-skills ~/.dsh/skills-external/academic-Group-meeting-skills\`
   The script is at
   \`~/.dsh/skills-external/academic-Group-meeting-skills/academic-Group-meeting-skills/scripts/paper_figures_to_ppt.py\`
   (call it SCRIPT below). Read
   \`~/.dsh/skills-external/academic-Group-meeting-skills/academic-Group-meeting-skills/references/style-profile.md\`
   before laying out slides.
2. Renderer check: \`command -v pdftoppm\` (poppler). If missing, write the
   shim at the bottom of this skill to \`<scratch>/bin/pdftoppm\`,
   \`chmod +x\` it, and pass \`--pdftoppm <scratch>/bin/pdftoppm\` to extract.
3. Extract (paper PDFs live under \`<workspace>/papers/<arxivId>.pdf\` after
   \`paper_fetch\`):
   \`uv run --with pdfplumber --with pillow --with python-pptx python SCRIPT extract --pdf <paper.pdf> --workdir <scratch>\`
4. Polish \`<scratch>/manifest.json\` — this is where the quality comes from:
   drop logos/decorations/tiny icons; fill \`paper.title_zh\`,
   \`paper.journal_if\`, \`paper.author_school\`; turn every \`raw_caption\`
   into a takeaway \`zh_caption\` ("Fig. 2 去掉检索模块召回掉 8 个点", not an
   axis description) plus \`zh_panel_captions\` A/B/C/D lines when the figure
   has panels; crop huge composite figures into \`subslides\`. Keep exact
   values, units, gene/method names verbatim.
5. Build:
   \`uv run --with pdfplumber --with pillow --with python-pptx python SCRIPT build --manifest <scratch>/manifest.json --out <out.pptx> --reference-pptx ~/.dsh/skills-external/academic-Group-meeting-skills/academic-Group-meeting-skills/assets/reference-style.pptx\`
6. Register: copy the pptx to
   \`<workspace>/meetings/<projectId>/<slug>-<yyyymmdd>.pptx\` — it shows in
   the 组会 tab immediately.

## Path B — whole-project report (deterministic)

1. Curate what the deck renders — it projects exactly what the wiki holds:
   one-paragraph \`notes\` per featured paper
   (\`wiki_note { action: 'update_paper' }\`), takeaway captions on figures,
   logged runs with real metrics, and an honest stage
   (\`wiki_note { action: 'set_project' }\`).
2. Optional 逐图 slides inside the report: after a Path-A extract, copy the
   chosen crops into \`<workspace>/meetings/.paper-figures/<arxivId>/\` and
   write \`manifest.json\` there as
   \`[{"file": "fig-01.png", "label": "Figure 1", "caption": "Fig.1 中文 takeaway"}]\`
   — at most 3 per paper make the deck.
3. Call \`meeting_deck\` with \`project_id\` (plus optional \`title\`,
   \`presenter\`, \`date\`, \`paper_ids\`, \`include_*\` switches). The tool
   returns the deck path; the user downloads from the 组会 tab.
4. **Framing research** — for a 组会 that discusses the surrounding field,
   load the \`sxng\` skill for the current news, released checkpoints, and
   competing results so the report's "state of the field" slide is current,
   then fold those citations back into the wiki (as notes) rather than
   pasting raw search output into the deck.

## Slide voice (both paths)

- Chinese, one message per slide, stated in the heading — never "实验结果",
  always "方法 X 在 Y 上超过 baseline 2.1 个点".
- Figures image-left / caption-right; the caption is the takeaway sentence.
- Microsoft YaHei everywhere; fixed readable caption sizes over auto-shrink.

## pdftoppm shim (Path A step 2)

#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pypdfium2", "pillow"]
# ///
"""pdftoppm-compatible shim: -r <dpi> -png <input.pdf> <prefix> via pypdfium2."""
import sys
import pypdfium2 as pdfium

args = sys.argv[1:]
dpi = 150
while args and args[0].startswith("-"):
    flag = args.pop(0)
    if flag == "-r":
        dpi = int(args.pop(0))
    elif flag == "-png":
        pass
    else:
        raise SystemExit("shim: unsupported flag " + flag)
doc = pdfium.PdfDocument(args[0])
n = len(doc)
width = max(2, len(str(n)))
for i in range(n):
    doc[i].render(scale=dpi / 72).to_pil().save(args[1] + "-" + str(i + 1).zfill(width) + ".png")
doc.close()
` + SHARED_RULES


/** Every skill bundled with the suite, in catalog order. */
export const BUNDLED_SKILLS: readonly BundledSkill[] = [
  {
    name: 'research-pipeline',
    description: 'Orchestrate one project through the full research loop: ideation, novelty gate, literature, plan, experiments, claim gate, writing, review. Use when the user says "做科研", "research pipeline", "从想法到论文", or wants the whole workflow driven end to end.',
    whenToUse: 'Starting or resuming a research project that should move through every Mimir stage in order.',
    content: RESEARCH_PIPELINE,
  },
  {
    name: 'research-lit-review',
    description: 'Build a curated, noted literature base in the research wiki via arxiv_search + paper_fetch, with Zotero import and arXiv subscriptions when configured. Use when the user says "文献综述", "lit review", "调研一下", or needs the paper base for a direction.',
    whenToUse: 'A direction needs its defining works, baselines, and evaluation suite collected into the wiki with notes.',
    content: RESEARCH_LIT_REVIEW,
  },
  {
    name: 'research-novelty-check',
    description: 'Verdict-bearing novelty gate: attack an idea with live arXiv searches from mechanism, application, and result angles before any compute is spent. Use when the user says "查新", "novelty check", "有没有人做过", or before committing to an idea.',
    whenToUse: 'Before implementing or spending compute on an idea whose novelty is unverified.',
    content: RESEARCH_NOVELTY_CHECK,
  },
  {
    name: 'research-experiment-plan',
    description: 'Turn registered claims into a sequenced, budgeted experiment roadmap mapped to wiki experiment records and the Servers tab. Use when the user says "实验方案", "experiment plan", "ablation matrix", or needs a run order.',
    whenToUse: 'A plan exists and needs concrete, claim-mapped runs with budgets and tracking.',
    content: RESEARCH_EXPERIMENT_PLAN,
  },
  {
    name: 'research-result-to-claim',
    description: 'Judge which claims the finished experiments actually support, invalidate, or leave pending — with the exact settling run named. Use when the user says "结果分析", "结果支撑什么", "result to claim", or after experiments finish and before writing.',
    whenToUse: 'Experiments have finished and the paper must only assert what the evidence carries.',
    content: RESEARCH_RESULT_TO_CLAIM,
  },
  {
    name: 'research-paper-drafting',
    description: 'Draft the LaTeX paper section by section with an immediate latex_compile loop and evidence discipline (supported claims only). Use when the user says "写论文", "draft paper", "逐节写", or wants a checkpointed alternative to the paper-write command.',
    whenToUse: 'Writing or revising the paper deliberately, section by section, with compiles between.',
    content: RESEARCH_PAPER_DRAFTING,
  },
  {
    name: 'research-citation-audit',
    description: 'Zero-trust bibliography audit: verify every .bib entry exists via live search and every citation sentence is earned. Use when the user says "审查引用", "citation audit", "核对参考文献", or before submission.',
    whenToUse: 'Before submission, or whenever bibliography integrity is in doubt.',
    content: RESEARCH_CITATION_AUDIT,
  },
  {
    name: 'research-rebuttal',
    description: 'Draft a grounded, venue-limited rebuttal: parse reviews into atomic concerns, triage by evidence, answer response-first without new unsupported claims. Use when the user says "rebuttal", "回复审稿", "OpenReview response", or reviews arrive.',
    whenToUse: 'External reviews have arrived and need a safe, evidence-bound response.',
    content: RESEARCH_REBUTTAL,
  },
  {
    name: 'research-figure-plan',
    description: 'Design claim-carrying figures, produce them reproducibly, and file them through figure_save so the Figures tab and the paper stay in sync. Use when the user says "画图", "figure plan", "论文配图", or a paper needs its figures designed.',
    whenToUse: 'A paper or report needs figures planned, produced, and registered in the workbench.',
    content: RESEARCH_FIGURE_PLAN,
  },
  {
    name: 'research-paper-deai',
    description: 'Bilingual (zh/en) de-AI polish pass over the paper draft: remove AI-writing tells from the prose while leaving every fact, number, formula, and citation byte-identical, then recompile. Use when the user says "去AI味", "去 AI", "de-AI", "humanize", "润色", or before submission.',
    whenToUse: 'The paper draft reads complete and needs a final human-voice pass, or the user wants a specific section de-AI-ed.',
    content: RESEARCH_PAPER_DEAI,
  },
  {
    name: 'research-meeting-deck',
    description: 'Generate a group-meeting (组会) deck that actually shows paper figures: either run the bundled academic-Group-meeting-skills pipeline (pdftoppm shim + paper_figures_to_ppt.py) for a figure-by-figure paper walkthrough, or call the meeting_deck tool for a whole-project report with per-figure slides. Use when the user says "组会", "组会汇报", "meeting deck", "group meeting slides", or a lab meeting is coming.',
    whenToUse: 'A group meeting is coming and the user wants a slide deck with real paper figures, generated end-to-end.',
    content: RESEARCH_MEETING_DECK,
  },
]

/**
 * Register the bundled skills into the composition's skill registry when one
 * is mounted. The `skills` service is deliberately NOT in the plugin's
 * `inject`: compositions without a skill registry (a bare CLI pipeline, a
 * minimal embed) still load the full suite, and registration simply never
 * happens there. `ctx.inject` fires the callback as soon as the registry
 * arrives and scopes the registrations to that child context, so teardown
 * order rides the normal effect stack. Same-name project skills outrank
 * these runtime entries (rank 250), so users can override any bundled
 * playbook from their project roots.
 * @param ctx - the plugin's context.
 */
export function registerResearchSkills(ctx: Context): void {
  ctx.inject(['skills'], (skillsCtx: Context) => {
    for (const skill of BUNDLED_SKILLS) {
      skillsCtx.skills.register({
        name: skill.name,
        description: skill.description,
        whenToUse: skill.whenToUse,
        content: skill.content,
        source: 'bundled',
      })
    }
  })
}
