/**
 * Research-suite record, verdict, and web-panel wire types. Types only — the
 * zod schemas that validate these records at the durable boundary live in
 * `./store.ts`.
 * @module dsh-mimir/types
 */

import type { LatexIssue } from './latex-log.ts'
import type { OutlineNode } from './outline.ts'
import type { CbeDigestReport, CbeDigestTier } from './report-tier.ts'
import type { CbeCapsulePerspective, CbeExperienceCapsule } from './report-capsules.ts'
import type { CbeMomentKind } from './moment-index.ts'
import type { CbeMomentSource, CbeMomentStats, CbeClosenessVotes } from './moment-candidates.ts'
import type { CbeEurekaContextView, CbeEurekaProfile } from './eureka.ts'
import type { CbeWindowFeatures } from './window-features.ts'
import type { EvidenceGraph } from './evidence-graph.ts'
export type { CbeCuratedMoment, CbeMomentKind } from './moment-index.ts'
export type { CbeMomentSource, CbeMomentStats, CbeClosenessVotes } from './moment-candidates.ts'
export type { CbeEurekaContextView } from './eureka.ts'
export type { CbeWindowFeatures } from './window-features.ts'
export type {
  EvidenceClaimHistory,
  EvidenceConflict,
  EvidenceEdgeRel,
  EvidenceGraphEdge,
  EvidenceGraphNode,
  EvidenceGraphRel,
  EvidenceGraphStats,
  EvidenceGraphWindow,
  EvidenceTimelineEntry,
  EvidenceTimelineGroup,
} from './evidence-graph.ts'
export type { OutlineNode, SectionMove, SectionOutlineTitles, SubsectionMove } from './outline.ts'
export type { BibEntry } from './bibtex.ts'
import type { BibEntry } from './bibtex.ts'

/**
 * One parsed arXiv entry, shared by both arXiv tools' output. Defined here
 * rather than in `./tools/arxiv.ts` so this types-only module never imports a
 * tool implementation: such edges drag host-side service declarations
 * (`@deepseek-ai/dsh-tools` → agent/session) into client type programs.
 */
export interface ArxivEntry {
  readonly id: string
  readonly title: string
  readonly authors: string[]
  readonly summary: string
  readonly published: string
  readonly url: string
}

/** A TeX engine the compile tool knows how to drive. */
export type LatexEngineKind = 'latexmk' | 'tectonic'

/** One independent-review verdict. */
export type Verdict = 'PASS' | 'WARN' | 'FAIL'

/** One project's AI relevance verdict on one remembered paper. */
export interface PaperRelevance {
  /** 0–10 relevance score (10 = central to the project's direction). */
  readonly score: number
  /** One-paragraph justification of the score. */
  readonly reason: string
  /** ISO-8601 timestamp of the scoring. */
  readonly at: string
}

/** One arXiv paper remembered by the research wiki. */
export interface PaperRecord {
  /** Bare arXiv id (version suffix allowed, e.g. `2103.00020v2`). */
  readonly arxivId: string
  readonly title: string
  readonly authors: string[]
  readonly summary: string
  readonly url: string
  /** Free-form working notes the agent attaches while reading. */
  readonly notes: string
  /** Organization tags, edited from the workbench. */
  tags: string[]
  /** Wiki projects this paper is linked to. */
  projectIds: string[]
  /**
   * Fetched PDF's path relative to the workspace root; absent until the
   * workbench fetches the PDF (records predating the field read as absent).
   */
  readonly pdfPath?: string | undefined
  /**
   * AI relevance verdicts keyed by project id; absent until a scoring pass
   * writes one (records predating the field read as absent).
   */
  readonly relevance?: Record<string, PaperRelevance> | undefined
  /** ISO-8601 timestamp of the record's first write. */
  readonly addedAt: string
}

/**
 * One research idea. Failed ideas stay listed forever: the failed-ideas
 * memory is what stops the ideation loop from re-proposing dead ends.
 */
export interface IdeaRecord {
  readonly id: string
  readonly title: string
  readonly hypothesis: string
  readonly status: 'active' | 'failed' | 'adopted'
  /** Why the idea failed; present on records whose status is `failed`. */
  readonly failureReason?: string | undefined
  /**
   * Project this idea is registered into. Absent for standalone exploratory
   * ideas. When present the idea is auto-adopted (status `adopted`) at
   * creation, so it surfaces in the worktree and brief as part of that
   * project's research process rather than waiting for a manual merge.
   */
  readonly projectId?: string | undefined
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string
}

/** One tracked claim and the evidence for or against it. */
export interface ClaimRecord {
  readonly id: string
  readonly text: string
  readonly status: 'supported' | 'invalidated' | 'pending'
  /** Free-form evidence pointer (file, experiment, citation). */
  readonly evidence: string
}

/** Lifecycle stage of one research project. */
export type ProjectStage = 'idea' | 'plan' | 'experiment' | 'writing' | 'done'

/** One research project tracked across the idea→paper pipeline. */
export interface ProjectRecord {
  readonly id: string
  readonly title: string
  readonly stage: ProjectStage
  /**
   * Paper directory relative to the workspace root (default `paper`). Lets
   * each project point at its own LaTeX tree under the same workspace.
   */
  readonly paperDir?: string | undefined
  /** Target venue of the paper; absent until one is applied. */
  readonly venue?: VenueView | undefined
  /** Artifact paths relative to the configured workspace directory. */
  readonly artifacts: string[]
  /** Number of completed independent-review rounds. */
  readonly reviewRounds: number
  /** ISO-8601 timestamp of the last write. */
  readonly updatedAt: string
}

/** Lifecycle of one experiment run. */
export type ExperimentStatus = 'running' | 'success' | 'failed'

/**
 * The settled outcome of the remote job most recently linked to one
 * experiment, written back when the job reaches `succeeded`/`failed`.
 */
export interface ExperimentJobOutcome {
  /** The settled job record's id. */
  readonly jobId: string
  readonly status: 'succeeded' | 'failed' | 'cancelled'
  /** Remote exit code; null when the ssh session itself failed. */
  readonly exitCode: number | null
  /** Wall-clock run time in ms; null when the job never reached `running`. */
  readonly durationMs: number | null
  /** ISO-8601 timestamp of the job's terminal settle. */
  readonly finishedAt: string
  /** Trailing log excerpt (the job's last output lines, whitespace-trimmed). */
  readonly summary: string
}

/** One experiment tracked against a project. */
export interface ExperimentRecord {
  readonly id: string
  /** Owning wiki project id. */
  readonly projectId: string
  readonly name: string
  readonly status: ExperimentStatus
  /** Scalar metrics keyed by name (accuracy, loss, wall-clock minutes…). */
  readonly metrics: Record<string, number | string>
  /** Log file path relative to the workspace root, when the run wrote one. */
  readonly logPath?: string | undefined
  /** Remembered server the run executed on, when linked. */
  readonly serverId?: string | undefined
  /**
   * Outcome of the most recently settled linked remote job; absent until a
   * linked job settles (records predating the field read as absent).
   */
  readonly lastJob?: ExperimentJobOutcome | undefined
  /** ISO-8601 timestamp of the last write. */
  readonly updatedAt: string
}

/** Lifecycle of one remote job submitted over ssh. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

/** One remote command submitted to a remembered server over ssh. */
export interface JobRecord {
  readonly id: string
  /** Remembered server the command runs on. */
  readonly serverId: string
  /** The remote command line, executed by the server's login shell. */
  readonly command: string
  readonly status: JobStatus
  /** Experiment record the job is linked to, when given at submit time. */
  readonly experimentId?: string | undefined
  /** Remote exit code; null until the job settles (and on a spawn/timeout failure). */
  readonly exitCode: number | null
  /** The last chunk of the job's stdout (empty until the job settles). */
  readonly stdoutTail: string
  /** The last chunk of the job's stderr (empty until the job settles). */
  readonly stderrTail: string
  /** ISO-8601 timestamp of the record's first write. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the status flip to `running`. */
  readonly startedAt?: string | undefined
  /** ISO-8601 timestamp of the terminal settle. */
  readonly finishedAt?: string | undefined
}

/** Metadata of one figure file saved into a project's paper directory. */
export interface FigureRecord {
  /** Composite key: `<projectId>:<relPath>` — one metadata row per figure file. */
  readonly id: string
  /** Owning wiki project id. */
  readonly projectId: string
  /** Path relative to the project's paper directory (`figures/foo.png`). */
  readonly relPath: string
  /** Free-form caption the saving agent attached. */
  readonly caption: string
  /** Experiment record the figure belongs to, when linked. */
  readonly experimentId?: string | undefined
  /** Where the figure was copied from, when the save recorded it. */
  readonly sourcePath?: string | undefined
  /** ISO-8601 timestamp of the record's first write. */
  readonly createdAt: string
}

/** One issue raised by an independent review round. */
export interface ReviewIssue {
  readonly severity: 'major' | 'minor'
  /** File and line region the issue refers to. */
  readonly location: string
  readonly problem: string
  readonly suggestion: string
}

/** The structured outcome of one independent review round. */
export interface ReviewRound {
  readonly verdict: Verdict
  readonly issues: ReviewIssue[]
  readonly summary: string
}

/* ── Web research panel wire payloads (the `research` Remote namespace) ───── */

/** The venue format a project targets (built-in registry entry or custom kit). */
export interface VenueView {
  /** Built-in registry id, or `custom` for an uploaded kit. */
  readonly id: string
  readonly name: string
  readonly custom: boolean
  readonly appliedAt: string
}

/** One project row as the research panel lists it. */
export interface ResearchProjectView {
  readonly id: string
  readonly title: string
  readonly stage: ProjectStage
  /** Paper directory relative to the workspace root; absent means `paper`. */
  readonly paperDir?: string | undefined
  /** Target venue of the paper; absent until one is applied. */
  readonly venue?: VenueView | undefined
  /** Number of completed independent-review rounds. */
  readonly reviewRounds: number
  /** Artifact paths relative to the workspace root (for the overview view). */
  readonly artifacts: readonly string[]
  readonly updatedAt: string
}

/** Compile lifecycle of the shared paper directory, per addressed project. */
export type ResearchCompileState = 'idle' | 'running' | 'ok' | 'error'

/** The research panel's view of one project's last compile. */
export interface ResearchCompileStatusView {
  readonly state: ResearchCompileState
  /** Errors and warnings of the last completed compile, in log order. */
  readonly issues: readonly LatexIssue[]
  /** Engine of the last completed compile; null until the first one settles. */
  readonly engine: LatexEngineKind | null
  /** mtime (ms) of the produced `main.pdf`; null until a successful compile. */
  readonly pdfUpdatedAt: number | null
}

/** Business failure of one `research` Remote call. */
export type ResearchFailure =
  | { readonly code: 'project-not-found'; readonly projectId: string }
  | { readonly code: 'paper-not-found' }
  | { readonly code: 'bib-not-found' }
  | { readonly code: 'invalid-dir'; readonly dir: string }
  | { readonly code: 'invalid-path'; readonly path: string }
  | { readonly code: 'figure-not-found'; readonly relPath: string }
  | { readonly code: 'artifact-not-found'; readonly name: string }
  | { readonly code: 'invalid-artifact'; readonly name: string }
  | { readonly code: 'server-not-found'; readonly id: string }
  | { readonly code: 'job-not-found'; readonly id: string }
  | { readonly code: 'experiment-not-found'; readonly id: string }
  | { readonly code: 'section-not-found'; readonly title: string }
  | { readonly code: 'subsection-not-found'; readonly sectionTitle: string; readonly title: string }
  | { readonly code: 'invalid-input'; readonly message: string }
  | { readonly code: 'snapshot-not-found'; readonly id: string }
  | { readonly code: 'invalid-name'; readonly name: string }
  | { readonly code: 'invalid-content' }
  | { readonly code: 'conflict'; readonly currentMtimeMs: number }
  | { readonly code: 'subscription-not-found'; readonly id: string }
  | { readonly code: 'operation-failed'; readonly message: string }

/** Success branch of one `research` Remote call. */
export interface ResearchSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** Business-failure branch of one `research` Remote call. */
export interface ResearchRejected<E extends ResearchFailure> {
  readonly ok: false
  readonly error: E
}

/** Closed result union of one `research` Remote call. */
export type ResearchResult<T> = ResearchSuccess<T> | ResearchRejected<ResearchFailure>

/** `listProjects` result: every wiki project, most recently updated first. */
export type ResearchListProjectsResult = ResearchResult<{ readonly projects: readonly ResearchProjectView[] }>

/** `importProject` request: one existing local directory holding a LaTeX project. */
export interface ResearchImportProjectRequest {
  /** Absolute or `~`-prefixed path of the source directory (copied, never referenced). */
  readonly path: string
  /** Explicit project title; falls back to the entry file's `\title{...}`, then the directory name. */
  readonly title?: string | undefined
}

/** `importProject` summary: what the copy-and-register pass produced. */
export interface ResearchImportedProject {
  readonly projectId: string
  readonly title: string
  /** The copied tree, relative to the workspace root (`imported/<slug>`). */
  readonly paperDir: string
  /** Entry .tex basename (the file carrying `\documentclass`). */
  readonly entryTex: string
  /** Image files detected (the `figures/` directory when present, else the whole tree). */
  readonly figureCount: number
  /** Non-fatal caveats (no figures/ directory, missing .bib, non-main entry file, …). */
  readonly warnings: readonly string[]
}

/** `importProject` result: the created project's summary. */
export type ResearchImportProjectResult = ResearchResult<ResearchImportedProject>

/** One built-in venue template entry as the panel lists it. */
export interface VenueTemplateView {
  readonly id: string
  readonly name: string
  readonly series: string
  readonly url: string
  readonly checklist: string
}

/** `listVenueTemplates` result: the built-in registry for the venue picker. */
export type ResearchVenueTemplatesResult = ResearchResult<{ readonly templates: readonly VenueTemplateView[] }>

/** `applyVenueTemplate` result: the venue now recorded on the project. */
export type ResearchApplyVenueResult = ResearchResult<{ readonly venue: VenueView }>

/** `clearVenueTemplate` result: the project whose venue was cleared. */
export type ResearchClearVenueResult = ResearchResult<{ readonly projectId: string }>

/* ── venue deadlines (会议/CCF DDL 追踪) ─────────────────────────────── */

/** Durable shape of one venue-watch row (the `venue_watches` wiki table). */
export interface VenueWatchRecord {
  /** Composite key: `<projectId>:<seriesKey>`. */
  readonly id: string
  readonly projectId: string
  /** ccfddl series key (lowercased title). */
  readonly series: string
  readonly createdAt: string
}

/** One submission round of one conference edition, deadlines as ISO instants. */
export interface VenueTimelineView {
  readonly abstractDeadline: string | null
  readonly deadline: string | null
  readonly comment: string | null
}

/** One conference edition as the panel shows it. */
export interface VenueConfView {
  readonly year: number
  readonly id: string
  readonly link: string
  /** Human date range from the source (`June 10-17, 2026`). */
  readonly date: string
  readonly place: string
  readonly timeline: readonly VenueTimelineView[]
}

/** One conference series with its current edition resolved. */
export interface VenueDeadlineView {
  /** ccfddl series key (lowercased title, e.g. `cvpr`). */
  readonly key: string
  readonly title: string
  readonly description: string
  /** ccfddl field code (`AI`, `DB`, …). */
  readonly sub: string
  readonly ccfRank: 'A' | 'B' | 'C' | 'N'
  readonly dblp: string | null
  readonly conf: VenueConfView
  /** ISO instant of the next pending deadline, or null when fully past. */
  readonly nextDeadlineAt: string | null
  readonly nextDeadlineKind: 'abstract' | 'paper' | null
}

/** One static CCF-A journal directory entry (no deadlines — reference only). */
export interface VenueJournalView {
  readonly title: string
  readonly fullName: string
  readonly sub: string
  readonly publisher: string
}

/** `listVenueDeadlines` result: the cached catalog plus the project's watch list. */
export type ResearchVenueDeadlinesResult = ResearchResult<{
  readonly venues: readonly VenueDeadlineView[]
  readonly journals: readonly VenueJournalView[]
  /** Series keys the addressed project watches. */
  readonly watched: readonly string[]
  /** When the cache was last refreshed; null when no fetch has ever succeeded. */
  readonly fetchedAt: string | null
}>

/** `setVenueWatch` result: the settled watch state. */
export type ResearchSetVenueWatchResult = ResearchResult<{
  readonly projectId: string
  readonly series: string
  readonly watched: boolean
}>

/** `refreshVenueDeadlines` result: the fresh fetch timestamp. */
export type ResearchRefreshVenueDeadlinesResult = ResearchResult<{ readonly fetchedAt: string }>


/** `getPaperOutline` result: the section tree of `<workspace>/paper/main.tex`. */
export type ResearchOutlineResult = ResearchResult<{
  readonly projectId: string
  readonly nodes: readonly OutlineNode[]
}>

/** `compile` result: the settled compile status of the addressed project. */
export type ResearchCompileResult = ResearchResult<ResearchCompileStatusView>

/** `getCompileStatus` result: the last known compile status (idle before the first run). */
export type ResearchCompileStatusResult = ResearchResult<ResearchCompileStatusView>

/** `getPaperSource` result: `main.tex` content plus the mtime it was read from. */
export type ResearchPaperSourceResult = ResearchResult<{
  readonly content: string
  readonly mtimeMs: number
}>

/** `savePaperSource` result: the committed mtime (a conflict rejects with its mtime). */
export type ResearchSavePaperSourceResult = ResearchResult<{ readonly mtimeMs: number }>

/** One file of one paper snapshot, as the panel lists it. */
export interface PaperSnapshotFileView {
  /** Path relative to the project's paper directory (`main.tex`, `sections/intro.tex`). */
  readonly path: string
  readonly sizeBytes: number
}

/** One paper snapshot (captured after a successful compile). */
export interface PaperSnapshotView {
  /** Compact UTC timestamp id (`20260823T063755939Z`, `-N` on collisions). */
  readonly id: string
  /** ISO-8601 timestamp of the capture. */
  readonly createdAt: string
  /** The captured `.tex`/`.bib` files, in sorted path order. */
  readonly files: readonly PaperSnapshotFileView[]
  /** Total bytes across the snapshot's files. */
  readonly sizeBytes: number
}

/** `listPaperSnapshots` result: the project's snapshots, newest first. */
export type ResearchPaperSnapshotsResult = ResearchResult<{ readonly snapshots: readonly PaperSnapshotView[] }>

/** `getPaperSnapshot` result: one snapshot's files with their full content. */
export type ResearchPaperSnapshotResult = ResearchResult<{
  readonly id: string
  readonly files: readonly { readonly path: string; readonly content: string }[]
}>

/** `revertPaperSnapshot` result: the committed `main.tex` mtime (a conflict rejects with its mtime). */
export type ResearchRevertPaperSnapshotResult = ResearchResult<{ readonly mtimeMs: number }>

/** `listPapers` result: every remembered paper, most recently added first. */
export type ResearchPapersResult = ResearchResult<{ readonly papers: readonly PaperRecord[] }>

/** `searchArxiv` result: the parsed arXiv entries matching the query. */
export type ResearchSearchArxivResult = ResearchResult<{ readonly results: readonly ArxivEntry[] }>

/** `searchWeb` result: one SearXNG web result row. */
export interface WebSearchEntry {
  /** Result page title. */
  readonly title: string
  /** Result URL, verbatim from the engine. */
  readonly url: string
  /** Snippet text the engine returned (may be empty). */
  readonly content: string
  /** Engine that produced this result (e.g. `arxiv`, `brave`). */
  readonly engine: string
  /** SearXNG category of the result (e.g. `science`, `general`). */
  readonly category: string
  /** ISO-8601 published date when the engine supplied one, else empty. */
  readonly publishedDate: string
}

/** `searchWeb` result: the parsed SearXNG results matching the query. */
export type ResearchSearchWebResult = ResearchResult<{ readonly results: readonly WebSearchEntry[] }>

/** `importPaper` result: false when the paper was already remembered. */
export type ResearchImportPaperResult = ResearchResult<{ readonly imported: boolean }>

/** `removePaper` result: the removed paper's arXiv id. */
export type ResearchRemovePaperResult = ResearchResult<{ readonly arxivId: string }>

/** `updatePaper` result: the stored record after the partial update. */
export type ResearchUpdatePaperResult = ResearchResult<{ readonly paper: PaperRecord }>

/** `fetchPaperPdf` result: the stored record with its `pdfPath` set. */
export type ResearchFetchPaperPdfResult = ResearchResult<{ readonly paper: PaperRecord }>

/**
 * One arXiv subscription as the panel lists it: the persisted record minus
 * its `seenIds` bookkeeping, with the cached details of the entries the
 * latest checks surfaced as new (`newEntries`, newest first).
 */
export interface ArxivSubscriptionView {
  readonly id: string
  /** The free-text query matched against all arXiv fields. */
  readonly query: string
  /** ISO-8601 timestamp of the subscription's creation. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the last check; null until the first one settles. */
  readonly lastCheckedAt: string | null
  /** Details of the entries reported as new and not yet superseded. */
  readonly newEntries: readonly ArxivEntry[]
}

/** `listArxivSubscriptions` result: every subscription, oldest first. */
export type ResearchArxivSubscriptionsResult = ResearchResult<{ readonly subscriptions: readonly ArxivSubscriptionView[] }>

/** `saveArxivSubscription` result: the created subscription (a duplicate query is `invalid-input`). */
export type ResearchSaveArxivSubscriptionResult = ResearchResult<{ readonly subscription: ArxivSubscriptionView }>

/** `deleteArxivSubscription` result: the removed subscription's id. */
export type ResearchDeleteArxivSubscriptionResult = ResearchResult<{ readonly id: string }>

/**
 * One subscription's outcome of a `checkArxivSubscriptions` run: the
 * post-check view (pre-check view when the fetch failed), the entries THIS
 * run surfaced as new, and the fetch failure when there was one (a failed
 * subscription leaves its stored record untouched).
 */
export interface ArxivSubscriptionCheckView {
  readonly subscription: ArxivSubscriptionView
  /** Entries this run found that the subscription had not seen before. */
  readonly added: readonly ArxivEntry[]
  /** The fetch failure message, or null when this subscription checked clean. */
  readonly error: string | null
}

/** `checkArxivSubscriptions` result: one outcome per checked subscription. */
export type ResearchCheckArxivSubscriptionsResult = ResearchResult<{ readonly checks: readonly ArxivSubscriptionCheckView[] }>

/** `listExperiments` result: experiment runs, filtered by project when given. */
export type ResearchExperimentsResult = ResearchResult<{ readonly experiments: readonly ExperimentRecord[] }>

/** `deleteExperiment` result: the deleted record's id. */
export type ResearchDeleteExperimentResult = ResearchResult<{ readonly id: string }>

/** `updateExperiment` result: the record after the update. */
export type ResearchUpdateExperimentResult = ResearchResult<{ readonly experiment: ExperimentRecord }>

/** `saveExperiment` input: the full-field upsert payload; an omitted `id` creates. */
export interface ExperimentInput {
  readonly id?: string | undefined
  readonly projectId: string
  readonly name: string
  readonly status: ExperimentStatus
  /** Scalar metrics keyed by name (numbers or strings). */
  readonly metrics: Record<string, number | string>
  readonly logPath?: string | undefined
  readonly serverId?: string | undefined
}

/** `saveExperiment` result: the stored record after the upsert. */
export type ResearchSaveExperimentResult = ResearchResult<{ readonly experiment: ExperimentRecord }>

/** `readArtifact` result: the markdown artifact's full text. */
export type ResearchArtifactResult = ResearchResult<{
  readonly name: string
  readonly content: string
  readonly mtimeMs: number
}>

/** One figure file discovered under a project's paper directory. */
export interface FigureEntry {
  /** Bare file name. */
  readonly name: string
  /** Path relative to the paper directory (`foo.png` or `figures/bar.svg`). */
  readonly relPath: string
  readonly sizeBytes: number
  readonly mtimeMs: number
  /** Caption from the wiki's figures metadata table, when the file has one. */
  readonly caption?: string | undefined
  /** Linked experiment id from the figures metadata table, when present. */
  readonly experimentId?: string | undefined
}

/** `listFigures` result: image files of the project's paper directory. */
export type ResearchFiguresResult = ResearchResult<{ readonly figures: readonly FigureEntry[] }>

/** `deleteFigure` result: the deleted file's paper-directory-relative path. */
export type ResearchDeleteFigureResult = ResearchResult<{ readonly relPath: string }>

/**
 * `renameFigure` result: the file's new paper-directory-relative path plus
 * the number of `.tex` files whose `\includegraphics` references were
 * rewritten to it.
 */
export type ResearchRenameFigureResult = ResearchResult<{
  readonly relPath: string
  readonly references: number
}>

/** `updateFigure` result: the figure metadata row after the caption upsert. */
export type ResearchUpdateFigureResult = ResearchResult<{
  readonly relPath: string
  readonly caption: string
}>

/**
 * `convertFigure` result: the paper-directory-relative path of the converted
 * product (`figures/foo.svg` → `figures/foo.pdf`, or `foo.png` from the
 * raster fallback) plus the converter that produced it (`cached` when a
 * fresh product already existed and was reused).
 */
export type ResearchConvertFigureResult = ResearchResult<{
  readonly relPath: string
  readonly converter: string
}>

/**
 * `saveFigure` result: the paper-directory-relative path of the SVG the
 * client generated (the experiments view's metric-comparison charts), the
 * caption registered in the wiki's figures table, and — when a converter is
 * available — the LaTeX-embeddable product written next to the SVG (the same
 * pipeline `convertFigure` runs). A machine with no usable converter reports
 * `warning` instead; the save itself still succeeded.
 */
export type ResearchSaveFigureResult = ResearchResult<{
  readonly relPath: string
  readonly caption: string
  readonly converted?: { readonly relPath: string; readonly converter: string } | undefined
  readonly warning?: string | undefined
}>

/** One generated group-meeting deck as listed on disk (meetings/<projectId>/). */
export interface MeetingDeckView {
  /** File name within the project's meetings directory. */
  readonly file: string
  readonly sizeBytes: number
  /** ISO-8601 mtime of the pptx file. */
  readonly updatedAt: string
}

/** `generateMeetingDeck` outcome: the produced file name plus slide count. */
export type ResearchGenerateMeetingResult = ResearchResult<{
  readonly file: string
  readonly slides: number
  /** AI illustrations embedded into the deck (0 when disabled/unconfigured). */
  readonly illustrations: number
}>

/** `getImageGenConfig` outcome: the panel-safe config view (key masked). */
export type ResearchGetImageGenConfigResult = ResearchResult<{
  readonly configured: boolean
  readonly baseUrl: string
  readonly model: string
  readonly size: string
  readonly apiKeyPreview: string
}>

/** `setImageGenConfig` outcome: the fresh masked view. */
export type ResearchSetImageGenConfigResult = ResearchGetImageGenConfigResult

/** `getSxngConfig` outcome: sxng-cli's native global config (Ollama key masked). */
export type ResearchGetSxngConfigResult = ResearchResult<{
  readonly configured: boolean
  readonly baseUrl: string
  readonly defaultEngine: string
  readonly allowedEngines: readonly string[]
  readonly defaultLimit: number
  readonly defaultFormat: 'md' | 'json'
  readonly useProxy: boolean
  readonly proxyUrl: string
  readonly timeout: number
  readonly ollamaApiKeyPreview: string
  readonly redundancyThreshold: number
  readonly redundancyBigramThreshold: number
}>

/** `setSxngConfig` outcome: the fresh masked sxng-cli config view. */
export type ResearchSetSxngConfigResult = ResearchGetSxngConfigResult

/** `listMeetingDecks` outcome, newest first. */
export type ResearchMeetingDecksResult = ResearchResult<{ readonly decks: readonly MeetingDeckView[] }>

/** `deleteMeetingDeck` outcome. */
export type ResearchDeleteMeetingDeckResult = ResearchResult<{ readonly file: string }>

/** Which sections a group-meeting deck carries. */
export interface MeetingInclude {
  readonly progress: boolean
  readonly experiments: boolean
  readonly figures: boolean
  readonly papers: boolean
}

/** One remembered compute server (a GPU box the experiments run on). */
export interface ServerRecord {
  readonly id: string
  readonly name: string
  readonly host: string
  readonly port: number
  /** SSH login user; an empty string downgrades probes to TCP-only. */
  readonly username: string
  /** Free-form operator note. */
  readonly note: string
  /** Operator-assigned grouping labels. */
  readonly tags: readonly string[]
  /** ISO-8601 timestamp of the record's first write. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the last write. */
  readonly updatedAt: string
}

/** Upsert payload of `saveServer`: `id` present updates, absent creates. */
export interface ServerInput {
  readonly id?: string | undefined
  readonly name: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly note: string
  /** Replacement tag list; omitted keeps the existing tags on update. */
  readonly tags?: string[] | undefined
}

/** One GPU row parsed from a remote `nvidia-smi` probe. */
export interface ServerGpuView {
  readonly name: string
  /** GPU utilization in percent. */
  readonly utilizationPct: number
  readonly memoryUsedMb: number
  readonly memoryTotalMb: number
}

/** One stage of the `checkServer` probe pipeline: TCP connect, ssh session, GPU readout. */
export type ServerProbeStage = 'tcp' | 'ssh' | 'gpu'

/** The settled outcome of one `checkServer` probe. */
export interface ServerStatusView {
  /** `online` once the TCP probe connects; the GPU readout is best-effort on top. */
  readonly state: 'online' | 'offline'
  /** TCP connect latency in ms; null when the probe never connected. */
  readonly latencyMs: number | null
  readonly gpus: readonly ServerGpuView[]
  /** ISO-8601 timestamp of the probe. */
  readonly checkedAt: string
  /** Failure detail (offline reason or the skipped/failed GPU probe); null when clean. */
  readonly message: string | null
  /**
   * Stage where the probe settled: the FAILED stage on failure, the deepest
   * completed stage on success (`tcp` for a TCP-only record without a login
   * user). Optional — older hosts omit it.
   */
  readonly stage?: ServerProbeStage | undefined
  /** TCP handshake latency in ms (the stage-wise twin of `latencyMs`); absent when the TCP probe never connected. */
  readonly tcpLatencyMs?: number | undefined
  /** Wall-clock ms of the ssh GPU readout; absent when it never ran. */
  readonly gpuLatencyMs?: number | undefined
}

/** `listServers` result: every remembered server, most recently updated first. */
export type ResearchListServersResult = ResearchResult<{ readonly servers: readonly ServerRecord[] }>

/** `saveServer` result: the upserted record (with its generated id on create). */
export type ResearchSaveServerResult = ResearchResult<{ readonly server: ServerRecord }>

/** `deleteServer` result: the deleted record's id. */
export type ResearchDeleteServerResult = ResearchResult<{ readonly id: string }>

/** `checkServer` result: the settled probe view. */
export type ResearchCheckServerResult = ResearchResult<ServerStatusView>

/** `submitJob` result: the queued record (the background run settles it later). */
export type ResearchSubmitJobResult = ResearchResult<{ readonly job: JobRecord }>

/** `listJobs` result: job records, most recently submitted first. */
export type ResearchListJobsResult = ResearchResult<{ readonly jobs: readonly JobRecord[] }>

/** `deleteJob` result: the deleted record's id. */
export type ResearchDeleteJobResult = ResearchResult<{ readonly id: string }>

/** `getBibliography` result: the parsed `references.bib` entries plus the file mtime (null when absent). */
export type ResearchBibliographyResult = ResearchResult<{
  readonly entries: readonly BibEntry[]
  readonly mtimeMs: number | null
}>

/** `saveBibliography` result: the committed mtime (a conflict rejects with its mtime). */
export type ResearchSaveBibliographyResult = ResearchResult<{ readonly mtimeMs: number }>

/** `importPapersToBib` result: appended and already-present citation keys. */
export type ResearchImportBibResult = ResearchResult<{
  readonly added: readonly string[]
  readonly skipped: readonly string[]
}>

/** One Zotero collection as the panel lists it. */
export interface ZoteroCollectionView {
  readonly key: string
  readonly name: string
  readonly itemCount: number
}

/** One Zotero item reduced to the fields the literature workbench shows. */
export interface ZoteroItemView {
  readonly key: string
  readonly title: string
  /** Display names of the item's creators, in order. */
  readonly authors: readonly string[]
  /** Four-digit publication year, or '' when the date does not carry one. */
  readonly year: string
  /** DOI, or '' when the item has none. */
  readonly doi: string
  /** Bare arXiv id recovered from `extra`/`url`, or null when absent. */
  readonly arxivId: string | null
  /** Journal/proceedings title, or '' for item types without one. */
  readonly publicationTitle: string
  /** Best external link: the item URL, else the DOI resolver link, else ''. */
  readonly url: string
}

/** The settled outcome of one `checkZotero` probe. */
export interface ZoteroStatusView {
  /**
   * `unconfigured` when the plugin config carries no API key/user id,
   * `ok` when the API accepted the credentials, `failed` otherwise.
   */
  readonly state: 'unconfigured' | 'ok' | 'failed'
  /** Failure reason when the state is `failed`; absent otherwise. */
  readonly message?: string | undefined
}

/** `checkZotero` result: the settled connection status (never a business failure). */
export type ResearchCheckZoteroResult = ResearchResult<ZoteroStatusView>

/** `listZoteroCollections` result: every collection of the configured user library. */
export type ResearchZoteroCollectionsResult = ResearchResult<{
  readonly collections: readonly ZoteroCollectionView[]
}>

/** `searchZotero` result: the parsed items matching the query. */
export type ResearchZoteroSearchResult = ResearchResult<{
  readonly results: readonly ZoteroItemView[]
}>

/** `importZoteroItem` result: whether the paper was newly imported, plus its papers-table id. */
export type ResearchZoteroImportResult = ResearchResult<{
  readonly imported: boolean
  /** The papers-table key: the bare arXiv id, or `zotero-<item key>` for arXiv-less items. */
  readonly paperId: string
}>

/** `exportZoteroCollectionToBib` result: appended and already-present citation keys. */
export type ResearchZoteroExportResult = ResearchResult<{
  readonly added: readonly string[]
  readonly skipped: readonly string[]
}>

/**
 * The research-wiki tables carried by an export snapshot, in domain order
 * (the runtime-only `jobs` table is excluded; `events` — the CBE engine's
 * single source of truth — is included since snapshot v3).
 */
export type ResearchWikiTableName = 'papers' | 'ideas' | 'claims' | 'projects' | 'experiments' | 'servers' | 'figures' | 'events'

/** One wiki export snapshot's table payload. */
export interface ResearchWikiSnapshotTables {
  readonly papers: readonly PaperRecord[]
  readonly ideas: readonly IdeaRecord[]
  readonly claims: readonly ClaimRecord[]
  readonly projects: readonly ProjectRecord[]
  readonly experiments: readonly ExperimentRecord[]
  readonly servers: readonly ServerRecord[]
  readonly figures: readonly FigureRecord[]
  /** The append-only ledger. Absent at runtime in a legacy v2 snapshot. */
  readonly events: readonly EventRecord[]
}

/**
 * One wiki backup snapshot: every record of all seven wiki tables plus the
 * whole ledger under a format envelope (`format`/`version` guard against
 * importing foreign JSON). `2` is still accepted by `importWiki` — a v2
 * snapshot carries no `events` and restores no ledger.
 */
export interface ResearchWikiSnapshot {
  readonly format: 'mimir-wiki'
  readonly version: 2 | 3
  readonly exportedAt: string
  readonly tables: ResearchWikiSnapshotTables
}

/** `exportWiki` result: the full snapshot. */
export type ResearchExportWikiResult = ResearchResult<{ readonly snapshot: ResearchWikiSnapshot }>

/** `importWiki` mode: merge upserts only absent keys; replace wipes first. */
export type ResearchImportWikiMode = 'merge' | 'replace'

/** `importWiki` result: per-table imported/skipped row counts. */
export type ResearchImportWikiResult = ResearchResult<{
  readonly imported: Record<ResearchWikiTableName, number>
  readonly skipped: Record<ResearchWikiTableName, number>
}>

/**
 * `listBackups` view: the scheduled-backup knobs plus what is on disk.
 * `enabled: false` means the timer is configured off (or the service was
 * built without backup knobs); the numeric fields then carry zeros.
 */
export interface ResearchBackupStatusView {
  readonly enabled: boolean
  readonly intervalMinutes: number
  readonly keep: number
  /** Backup files currently under the backup directory. */
  readonly count: number
  /** Newest backup's filename; null while none exists. */
  readonly latestName: string | null
}

/** `listBackups` result: the backup status line for the overview. */
export type ResearchListBackupsResult = ResearchResult<{ readonly backup: ResearchBackupStatusView }>

/**
 * Research-ledger (audit trail) types. The `events` wiki table is
 * append-only by convention in v1 (no remote/UI path deletes rows); the
 * event is the trail, the record it accompanies is the state.
 */

/** Who performed a ledgered action. */
export type LedgerActorKind = 'user' | 'agent' | 'subagent' | 'module' | 'system'

/** One ledger actor: the kind plus a stable identifying string. */
export interface LedgerActor {
  readonly kind: LedgerActorKind
  /** e.g. `panel`, `wiki_note`, `reviewer`, `autor`, `service`. */
  readonly id: string
}

/**
 * A value that round-trips losslessly through JSON. Declared in THIS package
 * on purpose: the Typert generator only codes recursive types declared in the
 * files of the package it generates for — an external alias (dsh-session's
 * `JsonValue`, zod's `JSONType`) is rejected at the Remote boundary ("not
 * owned by this face"). Structurally identical to both, so values are
 * interchangeable across those boundaries.
 */
export type LedgerJsonValue = null | boolean | number | string | LedgerJsonValue[] | { [key: string]: LedgerJsonValue }

/** Cross-record references carried by one event (the provenance edges). */
export interface EventRefs {
  readonly projectId?: string | undefined
  readonly experimentId?: string | undefined
  readonly runId?: string | undefined
  readonly serverId?: string | undefined
  readonly jobId?: string | undefined
  readonly artifactId?: string | undefined
  readonly figureId?: string | undefined
  readonly claimId?: string | undefined
  readonly ideaId?: string | undefined
  readonly paperId?: string | undefined
}

/**
 * One append-only ledger event, written at decision-grade moments (record
 * state changes, job lifecycle flips, compiles, review rounds, destructive
 * operations) — never for high-frequency reads or editor autosaves.
 */
export interface EventRecord {
  /** `ev-` id; the trailing sequence keeps same-millisecond writes ordered. */
  readonly id: string
  /** ISO-8601 timestamp (lexicographically sortable). */
  readonly ts: string
  readonly actor: LedgerActor
  /** Dotted action name, `<module>.<action>` (e.g. `compute.job.settled`). */
  readonly action: string
  /** Cross-record references; every field optional. */
  readonly refs: EventRefs
  /**
   * Bounded context; truncated with a marker past the payload cap. Constrained
   * to JSON values (the event crosses the Remote boundary via `listEvents` —
   * the Typert generator rejects unconstrained `unknown` there).
   */
  readonly payload: Record<string, LedgerJsonValue>
}

/** `listEvents` filter; every field optional, timestamps ISO-8601 bounds. */
export interface ResearchEventFilter {
  readonly projectId?: string | undefined
  readonly actorKind?: LedgerActorKind | undefined
  /** Match events whose action starts with this prefix (e.g. `compute.`). */
  readonly actionPrefix?: string | undefined
  readonly since?: string | undefined
  readonly until?: string | undefined
  /** Max events to return (default 200, hard cap 1000). */
  readonly limit?: number | undefined
  /** Sort direction (default `asc`). */
  readonly order?: 'asc' | 'desc' | undefined
  /**
   * Which end of the match set the `limit` keeps (default `newest`): the cap
   * is a sliding window over the newest events, so a ledger past the cap
   * still folds live activity instead of freezing on its first N events.
   * `oldest` is the explicit exception (e.g. "the earliest event in the
   * ledger") and must be asked for by name.
   */
  readonly anchor?: 'newest' | 'oldest' | undefined
}

/** `listEvents` result. */
export type ResearchListEventsResult = ResearchResult<{ readonly events: readonly EventRecord[] }>

/**
 * `generateProgressReport` options: a project filter plus ISO-8601 bounds
 * (`since` inclusive, `until` exclusive). A recent window (e.g. `since` = 7
 * days before now) turns the report into a weekly 组会 / progress digest;
 * omitted bounds cover full history.
 */
export interface ResearchProgressReportOptions {
  readonly projectId?: string | undefined
  readonly since?: string | undefined
  readonly until?: string | undefined
}

/** `generateProgressReport` result: the rendered Markdown report. */
export type ResearchProgressReportResult = ResearchResult<{
  readonly markdown: string
  readonly generatedAt: string
  readonly eventCount: number
}>

/**
 * `generateBrief` options: a project filter plus ISO-8601 bounds (`since`
 * inclusive, `until` exclusive), the same window contract as the progress
 * report — the cognitive brief reads the window's DDM-lite map plus the
 * user's L2 journal lines.
 */
export interface ResearchGenerateBriefOptions {
  readonly projectId?: string | undefined
  readonly since?: string | undefined
  readonly until?: string | undefined
}

/**
 * One interactive boundary question of the brief, label-resolved for the
 * view: the engine's abstract `CbeBoundaryQuestion` joined with the wiki
 * records so the card can name the line it asks about.
 */
export interface ResearchBriefQuestion {
  readonly kind: 'returning-branch' | 'pending-claim'
  readonly lineId: string
  /** The line's human label (idea/project title, or a claim-text excerpt). */
  readonly label: string
}

/**
 * The boundary question a journal entry answers (I4): rides the
 * `addJournalEntry` request when the entry was written from a question
 * card, and lands as a `cbe.question.answered` meta event.
 */
export interface ResearchJournalQuestionRef {
  readonly kind: 'returning-branch' | 'pending-claim'
  readonly lineId: string
}

/** `generateBrief` result: the rendered brief plus its interactive questions. */
export type ResearchGenerateBriefResult = ResearchResult<{
  readonly markdown: string
  readonly generatedAt: string
  readonly eventCount: number
  /** The derivation version the brief was rendered under (I5). */
  readonly derivationVersion: number
  readonly questions: readonly ResearchBriefQuestion[]
}>

/** `addJournalEntry` result: the stored journal event (the L2 write). */
export type ResearchAddJournalEntryResult = ResearchResult<{ readonly event: EventRecord }>

/* ── Worktree (S2) wire payloads — the research process as a working tree ── */

/** Lane lifecycle as the worktree renders it (idea records are the state). */
export type ResearchWorktreeLaneStatus = 'open' | 'failed' | 'adopted'

/** How one touch reads on the branch graph's bead scale. */
export type ResearchWorktreeTouchKind = 'create' | 'work' | 'meta' | 'terminal'

/** One work node on a lane: a timestamp, its bead class, and the action. */
export interface ResearchWorktreeTouchView {
  readonly at: string
  readonly kind: ResearchWorktreeTouchKind
  /** The ledger action name (labels resolve client-side). */
  readonly action: string
}

/**
 * One lane of the research worktree, label-resolved for the view: a research
 * line (idea, or `project:<id>`) wearing branch semantics — status, declared
 * parent, activity dates, and the documented-No numbers. E0 by construction:
 * numbers, dates, and user-declared edges only, no inferred genealogy.
 */
export interface ResearchWorktreeLaneView {
  readonly lineId: string
  readonly label: string
  readonly status: ResearchWorktreeLaneStatus
  /** The lane's brief state vocabulary (`settled` once terminal). */
  readonly state: 'settled' | 'dominant' | 'stalled' | 'converging' | 'returning-side' | 'exploring'
  /** The user-declared parent line, or null for a root branch. */
  readonly parentLineId: string | null
  /** The parent line's label (the declaring user's own landmark name). */
  readonly parentLabel: string | null
  readonly firstSeen: string
  readonly lastSeen: string
  readonly eventCount: number
  readonly drift: number
  /** The close adjudication's timestamp; null while open. */
  readonly closedAt: string | null
  /** The wiki record's failure reason — the documented No's own words. */
  readonly closeReason: string | null
  /** Failed lanes: days from the lane's last touch to its close (the GUT number). */
  readonly gutDays: number | null
  /** Open lanes: days since the lane's last touch to the derivation time. */
  readonly idleDays: number | null
  /** The lane's work nodes (timestamped touches), ts ascending — the beads. */
  readonly touches: readonly ResearchWorktreeTouchView[]
}

/** One mainline declaration (one ref move), label-resolved. */
export interface ResearchWorktreeMainlineView {
  readonly lineId: string
  readonly label: string
  readonly declaredAt: string
}

/** `getWorktree` payload: the whole derived worktree (a pure L0 projection). */
export interface ResearchWorktreeView {
  readonly derivedAt: string
  readonly lanes: readonly ResearchWorktreeLaneView[]
  /** The current mainline ref, or null before the first declaration. */
  readonly mainline: ResearchWorktreeMainlineView | null
  /** Every declaration in order — the mainline reflog (the 大改变 record). */
  readonly mainlineHistory: readonly ResearchWorktreeMainlineView[]
  readonly counts: {
    readonly open: number
    readonly failed: number
    readonly adopted: number
  }
}

/** `getWorktree` result: the derived worktree (a pure query, writes nothing). */
export type ResearchGetWorktreeResult = ResearchResult<{ readonly worktree: ResearchWorktreeView }>

/** `setMainline` result: the stored `cbe.mainline.set` event (one ref move). */
export type ResearchSetMainlineResult = ResearchResult<{ readonly event: EventRecord }>

/** `setIdeaParent` result: the stored `cbe.idea.parent.set` event (a declared edge). */
export type ResearchSetIdeaParentResult = ResearchResult<{ readonly event: EventRecord }>

/** `closeIdea` result: the stored `knowledge.idea.failed` event (a documented No). */
export type ResearchCloseIdeaResult = ResearchResult<{ readonly event: EventRecord }>

/** `adoptIdea` result: the stored `knowledge.idea.adopted` event (a declared merge). */
export type ResearchAdoptIdeaResult = ResearchResult<{ readonly event: EventRecord }>

/* ── Evidence engine (S3) wire payloads — E1, read-only until G1 ────────── */

/** One action's learned row of the evidence profile. */
export interface ResearchEvidenceActionView {
  readonly action: string
  /** The hand prior (LINE_WEIGHTS) — today's map value. */
  readonly prior: number
  /** The learned, share-accumulated mean of terminal outcomes. */
  readonly mean: number
  /** Accumulated eligibility share (evidence mass). */
  readonly mass: number
  /** The κ-shrunk effective value: `(mass·mean + κ·prior)/(mass + κ)`. */
  readonly effectiveValue: number
}

/** `getEvidenceProfile` payload: the folded profile, E1 instrumentation. */
export interface ResearchEvidenceProfileView {
  readonly derivationVersion: number
  readonly terminalsFolded: number
  readonly actions: readonly ResearchEvidenceActionView[]
}

/** `getEvidenceProfile` result: read-only; consumed by no UI until G1. */
export type ResearchGetEvidenceProfileResult = ResearchResult<{
  readonly profile: ResearchEvidenceProfileView
}>

/* ── Foraging (S4) wire payloads — the territory ledger and GUT cards ──── */

/** One research territory's E0 ledger row (label-resolved for the view). */
export interface ResearchTerritoryView {
  readonly projectId: string
  readonly label: string
  readonly eventCount: number
  readonly firstSeen: string
  readonly lastSeen: string
  /** Kernel-decayed |weight| mass — attention, sign-blind. */
  readonly activityMass: number
  /** Clean compiles — the v1 harvest proxy (claim/job terminals carry no project ref yet). */
  readonly harvestCount: number
  readonly lastHarvestAt: string | null
  readonly daysSinceHarvest: number | null
  readonly daysSinceActivity: number
}

/** The personal giving-up-time baseline (silent below its floor). */
export interface ResearchGutBaselineView {
  readonly samples: number
  readonly medianDays: number | null
  readonly iqrDays: number | null
  readonly minSamples: number
  readonly speaks: boolean
}

/** The GUT card's data: two numbers, zero verbs. */
export interface ResearchGutCardView {
  readonly projectId: string
  readonly label: string
  readonly daysSinceHarvest: number | null
  readonly daysSinceActivity: number
  readonly baselineMedianDays: number | null
}

/** `getForaging` payload: the whole foraging layer, E0 by construction. */
export interface ResearchForagingView {
  readonly derivedAt: string
  readonly territories: readonly ResearchTerritoryView[]
  readonly baseline: ResearchGutBaselineView
  readonly cards: readonly ResearchGutCardView[]
}

/** `getForaging` result: a pure query, writes nothing. */
export type ResearchGetForagingResult = ResearchResult<{ readonly foraging: ResearchForagingView }>

/* ── Library themes (S5) wire payloads — the shelf's own drift ────────── */

/** Where a theme came from: the user's own tag, or a repeated keyword. */
export type ResearchThemeSource = 'tag' | 'keyword'

/** How a theme moved between the previous window and the current one. */
export type ResearchThemeDirection = 'new' | 'rising' | 'flat' | 'falling' | 'gone'

/** One theme's weight inside one window. */
export interface ResearchThemeCountView {
  readonly theme: string
  readonly count: number
  readonly share: number
  readonly source: ResearchThemeSource
}

/** One window's theme mix. */
export interface ResearchThemeWindowView {
  readonly since: string
  readonly until: string
  readonly paperCount: number
  readonly themes: readonly ResearchThemeCountView[]
}

/** One theme's movement across the two windows. */
export interface ResearchThemeDriftView {
  readonly theme: string
  readonly source: ResearchThemeSource
  readonly currentCount: number
  readonly previousCount: number
  readonly deltaShare: number
  readonly direction: ResearchThemeDirection
}

/** `getLibraryThemes` payload: the reading shelf's theme drift. */
export interface ResearchLibraryThemesView {
  readonly derivedAt: string
  readonly current: ResearchThemeWindowView
  readonly previous: ResearchThemeWindowView
  readonly drift: readonly ResearchThemeDriftView[]
  readonly newThemes: readonly string[]
  readonly departedThemes: readonly string[]
  readonly speaks: boolean
}

/** `getLibraryThemes` result: a pure query over the `papers` table. */
export type ResearchGetLibraryThemesResult = ResearchResult<{
  readonly themes: ResearchLibraryThemesView
}>

/* ── Habits (S6) wire payloads — the researcher's own rhythm ──────────── */

/** One sitting: consecutive events with no gap wider than the session gap. */
export interface ResearchSessionView {
  readonly startedAt: string
  readonly endedAt: string
  readonly minutes: number
  readonly eventCount: number
}

/** One hour-of-day bucket (0–23, the researcher's local clock). */
export interface ResearchHourBucketView {
  readonly hour: number
  readonly count: number
}

/** One weekday bucket (0 = Sunday, the researcher's local calendar). */
export interface ResearchWeekdayBucketView {
  readonly weekday: number
  readonly count: number
}

/** `getHabits` payload: description only, never advice. */
export interface ResearchHabitProfileView {
  readonly derivedAt: string
  readonly eventCount: number
  readonly sessionCount: number
  readonly medianSessionMinutes: number | null
  readonly longestSessionMinutes: number | null
  readonly activeHours: readonly ResearchHourBucketView[]
  readonly weekdayHistogram: readonly ResearchWeekdayBucketView[]
  readonly activeDays: number
  readonly currentStreakDays: number
  readonly speaks: boolean
}

/** `getHabits` result: a pure query over event timestamps. */
export type ResearchGetHabitsResult = ResearchResult<{
  readonly habits: ResearchHabitProfileView
}>

/* ── Journal draft (S7) — the pre-filled diary, not a blank page ──────── */

/** The draft's span. */
export type ResearchJournalDraftKind = 'day' | 'week' | 'month'

/** `generateJournalDraft` result: Markdown the researcher edits, not writes. */
export type ResearchGenerateJournalDraftResult = ResearchResult<{
  readonly markdown: string
  readonly generatedAt: string
  readonly kind: ResearchJournalDraftKind
  readonly eventCount: number
}>

/* ── Digest (S8b–S8d) — the experience-capsule report (weekly/monthly/project) ── */

/** The assembled digest model the panel renders and the MMS exporter copies. */
export type ResearchDigestView = CbeDigestReport
/** The three report depths. */
export type ResearchDigestTier = CbeDigestTier
/** One report atom, from one of the six independent perspectives. */
export type ResearchExperienceCapsule = CbeExperienceCapsule
/** Which perspective a capsule belongs to. */
export type ResearchCapsulePerspective = CbeCapsulePerspective

/** `generateDigest` options: depth + window bounds + render language. */
export interface ResearchGenerateDigestOptions {
  /** Report depth; defaults to 'weekly'. */
  tier?: string | undefined
  /** ISO-8601 window start, inclusive; defaults to a 7-day span back from `until`. */
  since?: string | undefined
  /** ISO-8601 window end, exclusive; defaults to now. */
  until?: string | undefined
  /** MMS render language; defaults to 'zh'. */
  lang?: string | undefined
}

/** `generateDigest` result: the model, its MMS markdown, and the chosen tier/lang. */
export type ResearchGenerateDigestResult = ResearchResult<{
  readonly digest: ResearchDigestView
  readonly markdown: string
  readonly tier: ResearchDigestTier
  readonly lang: 'zh' | 'en'
  readonly generatedAt: string
}>

/* ── Eureka declaration (F) — the researcher names the milestone ── */

/** `setEureka` options: the milestone's line scope and the researcher's words. */
export interface ResearchSetEurekaOptions {
  /** Idea line the milestone belongs to (mutually exclusive with projectId). */
  ideaId?: string | undefined
  /** Project line the milestone belongs to (mutually exclusive with ideaId). */
  projectId?: string | undefined
  /** The researcher's own words for the milestone (non-blank). */
  title: string
}

/** `setEureka` result: the stored declaration event plus the pure-derived context receipt. */
export type ResearchSetEurekaResult = ResearchResult<{
  readonly event: EventRecord
  /** Lead/control window features at declaration time; never persisted. */
  readonly context?: CbeEurekaContextView | undefined
}>

/* ── Moment pin (F) — the researcher promotes one instant ── */

/** `pinMoment` options: the target event, an optional note, and unpin support. */
export interface ResearchPinMomentOptions {
  /** The anchoring event id to pin (or unpin). */
  targetEventId: string
  /** The researcher's own words for the moment; empty when none. */
  note?: string | undefined
  /** true to pin (default), false to unpin (append-only: a superseding declaration). */
  pinned?: boolean | undefined
}

/** `pinMoment` result: the stored pin event. */
export type ResearchPinMomentResult = ResearchResult<{ readonly event: EventRecord }>

/* ── Moment index & Eureka view (S9b read paths — pull-only, zero verbs) ── */

/** `getMomentIndex` result: the unified timeline over the five sources. */
export type ResearchGetMomentIndexResult = ResearchResult<ResearchMomentIndexView>

/** `getEurekaView` result: declarations × lead/control features + the speaks-gated profile. */
export type ResearchGetEurekaViewResult = ResearchResult<ResearchEurekaView>

/** The unified moment timeline: canonical / candidate / declined, (at, id) order. */
export interface ResearchMomentIndexView {
  readonly derivedAt: string
  readonly window: { readonly since: string; readonly until: string }
  readonly retrieval: {
    /** Decision-grade events actually folded (observations stripped). */
    readonly eventsHit: number
    /** The true match count, uncapped. */
    readonly eventsTotal: number
    readonly truncated: boolean
    readonly silences: readonly string[]
  }
  /** Whether the eureka profile speaks (gates the closeness footnote render). */
  readonly speaks: boolean
  readonly moments: readonly ResearchMomentView[]
}

/** One row of the unified timeline (view shape of a curated moment). */
export interface ResearchMomentView {
  readonly id: string
  readonly at: string
  readonly lineId: string | null
  readonly lineLabel: string | null
  readonly kind: CbeMomentKind
  readonly sources: readonly CbeMomentSource[]
  readonly action: string
  readonly note: string | null
  readonly pinned: boolean
  readonly declined: boolean
  /** pinned || kind === 'eureka' — the researcher's (or declaration's) word. */
  readonly canonical: boolean
  readonly eventCount: number
  readonly stats: CbeMomentStats
  readonly closeness: CbeClosenessVotes | null
  readonly evidence: readonly string[]
}

/** The retrospective eureka view: every declaration with its measured road. */
export interface ResearchEurekaView {
  readonly derivedAt: string
  readonly declarations: readonly {
    readonly id: string
    readonly at: string
    readonly title: string
    readonly lineId: string | null
    readonly lineLabel: string | null
    readonly lead: CbeWindowFeatures
    readonly control: CbeWindowFeatures | null
  }[]
  /** speaks=false ⇒ lift rows stay null (I2), rendered with the descriptive-not-predictive note. */
  readonly profile: CbeEurekaProfile
}

/* ── Evidence graph (v1): declared evidence edges + the pure fold's audit view ── */

/**
 * `addEvidenceEdge` request: one explicit relation assertion. `src`/`dst`
 * are node keys (`<kind>:<value>`, ≤128); `keys` carries the destination's
 * (or source's) normalized aliases for the fold's union-find; the optional
 * refs scope the edge to a project/idea/claim. The dedupKey is computed
 * server-side — callers never supply one.
 */
export interface AddEvidenceEdgeRequest {
  readonly rel: string
  readonly src: string
  readonly dst: string
  readonly srcLabel?: string | undefined
  readonly dstLabel?: string | undefined
  readonly keys?: {
    readonly arxiv?: string | undefined
    readonly doi?: string | undefined
    readonly url?: string | undefined
    readonly titleFp?: string | undefined
  } | undefined
  readonly note?: string | undefined
  readonly projectId?: string | undefined
  readonly ideaId?: string | undefined
  readonly claimId?: string | undefined
}

/** `addEvidenceEdge` result: the edge's server-computed identity. */
export type ResearchAddEvidenceEdgeResult = ResearchResult<{
  readonly dedupKey: string
  readonly rel: string
  readonly src: string
  readonly dst: string
}>

/**
 * `retractEvidenceEdge` request: the dedupKey identity of the edge to
 * retract (the retraction covers ALL duplicate declarations of that edge —
 * dedupKey-level granularity), plus an optional one-line reason. The scope
 * refs ride along for attribution; the permission check (panel retracts
 * anything, an agent only its own declarations) happens in the service.
 */
export interface RetractEvidenceEdgeRequest {
  readonly dedupKey: string
  readonly reason?: string | undefined
  readonly projectId?: string | undefined
  readonly ideaId?: string | undefined
  readonly claimId?: string | undefined
}

/** `retractEvidenceEdge` result: the dedupKey the retraction landed on. */
export type ResearchRetractEvidenceEdgeResult = ResearchResult<{
  readonly dedupKey: string
}>

/** `getEvidenceGraph` result: the pure fold's audit view over one window. */
export type ResearchGetEvidenceGraphResult = ResearchResult<ResearchEvidenceGraphView>

/**
 * The evidence graph view (L1: re-derivable, never persisted). Wraps the
 * fold's product with the read's retrieval honesty (what was folded vs. the
 * true total) and the resolved window.
 */
export interface ResearchEvidenceGraphView {
  readonly derivedAt: string
  readonly window: { readonly since: string; readonly until: string }
  readonly retrieval: {
    /** Decision-grade events actually folded (observations stripped). */
    readonly eventsHit: number
    /** The true match count, uncapped. */
    readonly eventsTotal: number
    readonly truncated: boolean
  }
  readonly graph: EvidenceGraph
}


/**
 * One wiki change notification pushed to open panels over the
 * `/research/events` SSE stream: the domain table and record key that
 * changed, or a file-side pseudo-table (`paper-source`, `bibliography`)
 * keyed by project id. The payload stays location-only — a panel re-reads
 * the slices it actually shows, so the frame never carries record bodies.
 */
export interface ResearchWikiChangeEvent {
  /** Domain table name, or a pseudo-table for file-side writes. */
  readonly table: string
  /** Record key; the project id for the file-side pseudo-tables. */
  readonly key: string
  /** Write discriminant; file-side writes always report `put`. */
  readonly operation: 'put' | 'deleted'
}
