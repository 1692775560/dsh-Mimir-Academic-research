/**
 * Research-assistant plugin suite: an arXiv literature surface, a persistent
 * research wiki (papers / ideas / claims / projects), a LaTeX compile tool,
 * nine bundled research-workflow skills, and an independent fresh-reviewer
 * loop — the ARIS workflow mechanisms as one dsh-native plugin.
 * @module dsh-mimir
 */

import { createReadStream, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the ctx.webServer Context merge for the PDF route below.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { quarantineUnsafePaperIds, researchWikiDomainSpec } from './store.ts'
import { createArxivSearchTool, createPaperFetchTool } from './tools/arxiv.ts'
import { createWebSearchTool } from './tools/web-search.ts'
import { createWikiNoteTool } from './tools/wiki.ts'
import { createFigureOrganizeTool, createFigureSaveTool } from './tools/figure.ts'
import { createMeetingDeckTool } from './tools/meeting.ts'
import { createLatexCompileTool } from './tools/latex.ts'
import { createServerCheckTool, createServerListJobsTool, createServerListTool, createServerSubmitJobTool } from './tools/server.ts'
import { registerIdeaCommand } from './commands/idea.ts'
import { registerPlanCommand } from './commands/plan.ts'
import { registerReviewCommand } from './commands/review.ts'
import { registerPaperCommands } from './commands/paper.ts'
import { registerSkillSyncCommand } from './commands/skill-sync.ts'
import type { ResearchCommandDeps } from './commands/common.ts'
import { resolvePaperDir } from './paper-source.ts'
import { isSameOriginWrite, projectPaperDir } from './http-write-boundary.ts'
import type { ResearchServiceConfig } from './service.ts'
import { isFigureFile } from './artifacts.ts'
import { TEMPLATE_DIR_NAME } from './services/venue.ts'
import { meetingDeckPath } from './services/meeting.ts'
import { ResearchService } from './service.ts'
import { recoverInterruptedJobs } from './services/server.ts'
import { registerResearchSkills } from './skills.ts'
import { registerSxngSkill } from './sxng-skill.ts'
import { startWikiBackupLoop } from './backup.ts'
import { startArxivSubscriptionLoop } from './arxiv-subscriptions.ts'
import { createWikiChangeHub, createWikiEventsHandler } from './wiki-events.ts'
import { startVenueDeadlineLoop } from './services/venue-deadlines.ts'
import { createVenueSearchTool } from './tools/venue.ts'

export type { Verdict, PaperRecord, PaperRelevance, IdeaRecord, ClaimRecord, ProjectRecord, ReviewIssue, ReviewRound, ProjectStage, ExperimentRecord, ExperimentStatus, ExperimentInput, FigureRecord, JobRecord, JobStatus, EventRecord, LedgerActor, LedgerActorKind, EventRefs, LedgerJsonValue, ResearchEventFilter, ResearchListEventsResult, ResearchProgressReportOptions, ResearchProgressReportResult } from './types.ts'
export type {
  ArxivSubscriptionCheckView,
  ArxivSubscriptionView,
  FigureEntry,
  OutlineNode,
  ResearchAddJournalEntryResult,
  ResearchArtifactResult,
  ResearchArxivSubscriptionsResult,
  ResearchBackupStatusView,
  ResearchBriefQuestion,
  ResearchCheckArxivSubscriptionsResult,
  ResearchCheckServerResult,
  ResearchCompileResult,
  ResearchCompileState,
  ResearchCompileStatusResult,
  ResearchCompileStatusView,
  ResearchConvertFigureResult,
  ResearchDeleteArxivSubscriptionResult,
  ResearchDeleteFigureResult,
  ResearchDeleteJobResult,
  ResearchDeleteServerResult,
  ResearchExperimentsResult,
  ResearchFailure,
  ResearchFetchPaperPdfResult,
  ResearchGetSxngConfigResult,
  ResearchSetSxngConfigResult,
  ResearchFiguresResult,
  ResearchGenerateBriefOptions,
  ResearchGenerateBriefResult,
  ResearchGenerateJournalDraftResult,
  ResearchDigestView,
  ResearchDigestTier,
  ResearchExperienceCapsule,
  ResearchCapsulePerspective,
  ResearchGenerateDigestOptions,
  ResearchGenerateDigestResult,
  ResearchPinMomentOptions,
  ResearchPinMomentResult,
  ResearchSetEurekaOptions,
  ResearchSetEurekaResult,
  ResearchGetHabitsResult,
  ResearchGetLibraryThemesResult,
  ResearchImportPaperResult,
  ResearchJournalDraftKind,
  ResearchImportProjectRequest,
  ResearchImportProjectResult,
  ResearchImportedProject,
  ResearchListBackupsResult,
  ResearchListJobsResult,
  ResearchListProjectsResult,
  ResearchListServersResult,
  ResearchOutlineResult,
  ResearchPaperSourceResult,
  ResearchPapersResult,
  ResearchProjectView,
  ResearchRejected,
  ResearchRemovePaperResult,
  ResearchRenameFigureResult,
  ResearchResult,
  ResearchSaveExperimentResult,
  ResearchSaveArxivSubscriptionResult,
  ResearchSavePaperSourceResult,
  ResearchSaveServerResult,
  ResearchSearchArxivResult,
  ResearchSearchWebResult,
  WebSearchEntry,
  ResearchSubmitJobResult,
  ResearchSuccess,
  ResearchUpdateFigureResult,
  ResearchCheckZoteroResult,
  ResearchZoteroCollectionsResult,
  ResearchZoteroExportResult,
  ResearchZoteroImportResult,
  ResearchZoteroSearchResult,
  ServerGpuView,
  ServerInput,
  ServerRecord,
  ServerStatusView,
  ZoteroCollectionView,
  ZoteroItemView,
  ZoteroStatusView,
} from './types.ts'
export { researchWikiDomainSpec } from './store.ts'
export type { ResearchWikiDomain } from './store.ts'
/**
 * The L0 primitives. These are the锅底 every fold is written against, and they
 * are exported so a consumer — or a twelfth fold — never has to re-declare
 * the canonical ordering, the window slice, the session cut, or the day and
 * minute units. A re-declared primitive is how two folds come to disagree.
 */
export { MS_PER_DAY, MS_PER_MINUTE, orderedEvents, sessionize, sliceEvents, tsToMs } from './time.ts'
/**
 * The two vocabulary names that are not already re-exported through
 * `./cognitive-map.ts` above. The constants themselves (`LINE_WEIGHTS`,
 * `TERMINAL_ACTIONS`, `CREATION_ACTIONS`, `CBE_SESSION_GAP_MINUTES`) and
 * `signedWeight` keep their original export path, so no existing import
 * breaks.
 */
export { isDecisionEvent, lineOf } from './vocabulary.ts'
export {
  appendEvent,
  buildProgressReport,
  emitEvent,
  listEvents,
  newEvent,
  truncatePayload,
  PANEL_ACTOR,
  REVIEWER_ACTOR,
  SERVICE_ACTOR,
  WIKI_AGENT_ACTOR,
  EVENT_PAYLOAD_MAX_CHARS,
  JOURNAL_TEXT_MAX_CHARS,
  LIST_EVENTS_DEFAULT_LIMIT,
  LIST_EVENTS_MAX_LIMIT,
} from './ledger.ts'
export type { LedgerEventInput } from './ledger.ts'
export {
  deriveLines,
  detectMoments,
  deriveTransitions,
  deriveOpenLoops,
  deriveQuestions,
  deriveBrief,
  deriveNarrative,
  lineInferenceCard,
  renderBriefMarkdown,
  signedWeight,
  claimsOf,
  LINE_WEIGHTS,
  TERMINAL_ACTIONS,
  CREATION_ACTIONS,
  JOURNAL_ACTION,
  QUESTION_SHOWED_ACTION,
  QUESTION_ANSWERED_ACTION,
  CBE_HALF_LIFE_DAYS,
  CBE_SESSION_GAP_MINUTES,
  CBE_DOMINANT_DRIFT,
  CBE_STALLED_DRIFT,
  CBE_EXPLORE_EVENTS,
  CBE_RETURN_SESSIONS,
  CBE_FOCUS_DISPERSION,
  CBE_LINE_EVIDENCE_CAP,
  CBE_QUESTION_CAP,
  CBE_DERIVATION_VERSION,
  CBE_TIER_SILENT_LINE_EVENTS,
  CBE_TIER_E1_LINE_EVENTS,
  CBE_TIER_E1_USER_EVENTS,
} from './cognitive-map.ts'
export type {
  CbeBrief,
  CbeBriefWindow,
  CbeBoundaryQuestion,
  CbeEvidenceTier,
  CbeLine,
  CbeLineState,
  CbeMoment,
  CbeNarrative,
  CbeOpenLoop,
  CbeOpenLoopKind,
  CbeQuestionKind,
  CbeTransition,
  CbeWikiSnapshot,
  InferenceCard,
} from './cognitive-map.ts'
export { PARAMETER_REGISTRY } from './registry.ts'
export type { CbeParameterEntry, CbeParameterTrack } from './registry.ts'
export {
  deriveWorktree,
  ideaParentEdges,
  MAINLINE_ACTION,
  IDEA_PARENT_ACTION,
  IDEA_CLOSE_REASON_MAX_CHARS,
} from './worktree.ts'
export type {
  CbeWorktree,
  CbeWorktreeLane,
  CbeWorktreeLaneStatus,
  CbeMainlineDeclaration,
} from './worktree.ts'
export {
  evidenceModelAt,
  evidenceProfileOf,
  effectiveValue,
  initialModel,
  terminalOutcome,
  isTerminalOutcome,
  updateOnTerminal,
  CBE_ENGINE_ALPHA,
  CBE_ENGINE_KAPPA,
  CBE_ENGINE_N_FLIP,
  CBE_ENGINE_FOLD_WINDOW_DAYS,
} from './cbe-engine.ts'
export type {
  CbeEvidenceModel,
  CbeActionValue,
  CbeEvidenceActionRow,
} from './cbe-engine.ts'
export {
  deriveForaging,
  deriveTerritories,
  deriveGutBaseline,
  CBE_GUT_BASELINE_MIN_DEPARTURES,
} from './foraging.ts'
export type {
  CbeForaging,
  CbeTerritory,
  CbeGutBaseline,
  CbeGutCard,
} from './foraging.ts'
export {
  deriveLibraryThemes,
  countThemes,
  tagThemesOf,
  themeTokens,
  CBE_THEME_MIN_PAPERS,
  CBE_THEME_KEYWORD_MIN_DOCS,
  CBE_THEME_TOP_N,
  CBE_THEME_FLAT_BAND,
} from './library-themes.ts'
export type {
  CbeLibraryThemes,
  CbeThemeCount,
  CbeThemeDirection,
  CbeThemeDriftRow,
  CbeThemeSource,
  CbeThemeWindow,
} from './library-themes.ts'
export {
  deriveHabits,
  deriveSessions,
  CBE_HABIT_MIN_SESSIONS,
  CBE_HABIT_MIN_EVENTS,
} from './habits.ts'
export type {
  CbeHabitProfile,
  CbeSession,
  CbeHourBucket,
  CbeWeekdayBucket,
} from './habits.ts'
export {
  eurekaDeclarations,
  eurekaFeatures,
  eurekaModelAt,
  eurekaProfileOf,
  eurekaContextAt,
  eurekaWindowBounds,
  EUREKA_ACTION,
  EUREKA_FEATURE_KEYS,
  CBE_EUREKA_WINDOW_DAYS,
  CBE_EUREKA_MIN_DECLARATIONS,
} from './eureka.ts'
export {
  eurekaCriticalStateData,
} from './eureka.ts'
export type {
  CbeEurekaDeclaration,
  CbeEurekaFeatureKey,
  CbeEurekaFeatureRow,
  CbeEurekaFeatures,
  CbeEurekaModel,
  CbeEurekaProfile,
  CbeCriticalStateSample,
  CbeEurekaContextView,
  EurekaWindowBounds,
} from './eureka.ts'
export {
  windowFeatures,
} from './window-features.ts'
export type {
  CbeWindowFeatures,
} from './window-features.ts'
export {
  deriveCapsules,
  formatCapsule,
} from './report-capsules.ts'
export type {
  CbeCapsulePerspective,
  CbeExperienceCapsule,
  CbeCapsuleInput,
  CapsuleLang,
} from './report-capsules.ts'
export {
  assembleDigest,
} from './report-tier.ts'
export type {
  CbeDigestReport,
  CbeDigestTier,
  CbeDigestStat,
  CbeDigestRetrieval,
  CbeDigestEurekaRow,
  CbeDigestPerspectiveBlock,
  DigestInput,
} from './report-tier.ts'
export {
  renderDigest,
} from './render-digest.ts'
export {
  actionSequence,
  conditionalEntropy,
  ewsOrder,
  ewsReading,
  surprisalSequence,
  unigramEntropy,
  CBE_EWS_MIN_EVENTS,
  CBE_EWS_MAX_ORDER,
} from './ledger-ews.ts'
export type { CbeEwsReading } from './ledger-ews.ts'
export {
  deriveCuratedMoments,
  momentPins,
  MOMENT_PIN_ACTION,
  CBE_MOMENT_BURST_MIN_EVENTS,
} from './moment-index.ts'
export type { CbeCuratedMoment, CbeMomentKind, CbeMomentPin } from './moment-index.ts'
export {
  deriveMomentCandidates,
  kindOfBurst,
  CBE_MOMENT_RETURN_GAP_DAYS,
  CBE_MOMENT_CONVERGENCE_LINES,
  CBE_MOMENT_LONG_SITTING_FACTOR,
  CBE_MOMENT_LONG_SITTING_MIN_SESSIONS,
  CBE_MOMENT_CLOSNESS_ENABLED,
} from './moment-candidates.ts'
export type {
  CbeMomentSource,
  CbeMomentStats,
  CbeMomentCandidate,
  CbeClosenessVotes,
} from './moment-candidates.ts'
export { renderJournalDraft } from './journal-draft.ts'
export type { JournalDraftInput, JournalDraftKind, JournalDraftLang } from './journal-draft.ts'
export { parseLatexErrors } from './latex-log.ts'
export type { LatexIssue } from './latex-log.ts'
export { parseTexOutline } from './outline.ts'
export { readPaperSource, resolvePaperDir, savePaperSourceFile } from './paper-source.ts'
export type { PaperSourceSnapshot, SavePaperOutcome } from './paper-source.ts'
export { DEFAULT_PAPER_DIR } from './paper-source.ts'
export { isArtifactName, isFigureFile, listPaperFigures, readWorkspaceArtifact, ARTIFACT_NAMES } from './artifacts.ts'
export type { ArtifactName, FigureFile } from './artifacts.ts'
export { convertSvgFigure, svgConverterNames, svgProductName, whichOnPath, SVG_CONVERTERS } from './svg-convert.ts'
export type { SvgConversion, SvgConversionDeps, SvgConverterKind, SvgConverterSpec, SvgRunner } from './svg-convert.ts'
export { ResearchService } from './service.ts'
export type { ResearchServiceConfig } from './service.ts'
export { BUNDLED_SKILLS, registerResearchSkills } from './skills.ts'
export {
  ARXIV_SUBSCRIPTIONS_FILE,
  ARXIV_SUBSCRIPTION_CHECK_RESULTS,
  ARXIV_SUBSCRIPTION_FIRST_DELAY_MS,
  ARXIV_SUBSCRIPTION_FETCH_TIMEOUT_MS,
  ARXIV_SUBSCRIPTION_GAP_MS,
  ARXIV_SUBSCRIPTION_NEW_LIMIT,
  ARXIV_SUBSCRIPTION_QUERY_MAX,
  ARXIV_SUBSCRIPTION_SEEN_LIMIT,
  foldArxivSubscriptionCheck,
  loadArxivSubscriptions,
  runArxivSubscriptionCheck,
  saveArxivSubscriptions,
  startArxivSubscriptionLoop,
} from './arxiv-subscriptions.ts'
export type {
  ArxivSubscriptionCheckOptions,
  ArxivSubscriptionCheckOutcome,
  ArxivSubscriptionLoopOptions,
  ArxivSubscriptionRecord,
} from './arxiv-subscriptions.ts'
export { runReview, renderReviewRound } from './reviewer.ts'
export type { ReviewerOptions, ReviewRequest } from './reviewer.ts'
export { compileLatex, renderLatexResult, createLatexCompileTool, resolveLatexEngine, parseTectonicErrors } from './tools/latex.ts'
export type { LatexCompileResult, LatexToolOptions, LatexEngineKind, ResolvedLatexEngine, LatexEngineProbe } from './tools/latex.ts'
export { createArxivSearchTool, createPaperFetchTool, fetchArxivPdf, fetchArxivSearch, paperPdfFileName, parseArxivFeed, ARXIV_PDF_MAX_BYTES } from './tools/arxiv.ts'
export type { ArxivEntry, ArxivSearchOptions } from './tools/arxiv.ts'
export { createWebSearchTool, fetchWebSearch } from './tools/web-search.ts'
export { getSxngConfig, readSxngConfig, setSxngConfig } from './services/sxng-config.ts'
export type { WebSearchOptions, WebSearchRunner } from './tools/web-search.ts'
export { registerSxngSkill } from './sxng-skill.ts'
export { createZoteroClient } from './tools/zotero.ts'
export type { ZoteroBibRequest, ZoteroClient, ZoteroClientConfig, ZoteroCollection, ZoteroFetch, ZoteroItem } from './tools/zotero.ts'
export { createWikiNoteTool } from './tools/wiki.ts'
export { createFigureOrganizeTool, createFigureSaveTool } from './tools/figure.ts'
export { createServerCheckTool, createServerListJobsTool, createServerListTool, createServerSubmitJobTool } from './tools/server.ts'
export type { ResearchServiceResolver } from './tools/server.ts'
export { createMeetingDeckTool } from './tools/meeting.ts'
export { buildWikiSnapshot } from './wiki-snapshot.ts'
export type { WikiSnapshotSource } from './wiki-snapshot.ts'
export {
  backupFileName,
  isBackupFileName,
  pruneBackupNames,
  runWikiBackup,
  startWikiBackupLoop,
  WIKI_BACKUP_FIRST_DELAY_MS,
  WIKI_BACKUP_PREFIX,
  WIKI_BACKUP_SUFFIX,
} from './backup.ts'
export type { WikiBackupLoopOptions } from './backup.ts'

/** Cordis plugin name. */
export const name = 'mimir'
/** The wiki needs the domain form; commands, tools, and review need their registries; the panel's PDF preview needs the HTTP carrier. */
export const inject = ['commands', 'tools', 'subagents', 'storageDomain', 'webServer']

/** Deployment policy for the research suite. */
export interface Config {
  /** Research workspace root, resolved against the process cwd (default `.research`). */
  workspaceDir?: string
  /** Independent-review deployment knobs. */
  reviewer?: {
    /** Subagent provider route (default `spawn`); reserved for cross-model review. */
    provider?: string
    /** Review-round budget per project (default 3). */
    maxRounds?: number
  }
  /** LaTeX compile deployment knobs. */
  latex?: {
    /**
     * Engine selection (default `auto`): `'auto'` probes `latexmk` then
     * `tectonic` on PATH (cached for the process lifetime); an explicit
     * engine name (`'latexmk'` / `'tectonic'`) is used as-is; an absolute
     * path runs that executable, its basename picking the command line.
     */
    engine?: string
    /** Compile kill timeout in milliseconds (default 120000). */
    timeoutMs?: number
  }
  /** arXiv search deployment knobs. */
  arxiv?: {
    /** Default result cap for `arxiv_search` (default 10). */
    maxResults?: number
  }
  /** Web search deployment knobs (the sxng CLI over a self-hosted SearXNG). */
  search?: {
    /**
     * The sxng executable (default `auto`): `'auto'` registers the
     * `web_search` tool when the command resolves on PATH or as the bundled
     * optional `sxng-cli` dependency; an explicit binary name or absolute
     * path registers it unconditionally and fails per call with install
     * guidance when missing.
     */
    command?: string
    /** Search kill timeout in milliseconds (default 30000). */
    timeoutMs?: number
  }
  /**
   * Zotero Web API credentials (read-only integration; both absent disables
   * it). The key is a secret: it is read from this config only, sent to the
   * API as a header, and never written to the wiki, a log, or the panel.
   */
  zotero?: {
    /** Web API key from zotero.org/settings/keys; '' counts as unconfigured. */
    apiKey?: string
    /** Numeric user id shown on the settings page; '' counts as unconfigured. */
    userId?: string
  }
  /** arXiv subscription new-paper check knobs. */
  subscriptions?: {
    /** Master switch of the scheduled check (default true); false disables the timer entirely. */
    enabled?: boolean
    /** Check cadence in minutes (default 1440 — once a day, >= 1). */
    intervalMinutes?: number
  }
  /** Scheduled wiki backup knobs. */
  backup?: {
    /** Master switch (default true); false disables the timer entirely. */
    enabled?: boolean
    /** Backup cadence in minutes (default 60, >= 1). */
    intervalMinutes?: number
    /** How many of the newest backups to keep (default 24, >= 1). */
    keep?: number
    /**
     * Backup directory, resolved against `workspaceDir` unless absolute
     * (default `'backups'`).
     */
    dir?: string
  }
  /**
   * Register the model-callable `server_*` tools (list / check / submit /
   * list jobs) that forward to the `server.*` Remote namespace (default
   * true). These let the running agent drive remembered ssh runtimes the
   * panel manages — a capability with real remote-execution reach, so
   * compositions that want the panel's Servers view but no agent-driven
   * compute can turn it off.
   */
  serverTools?: {
    /** Master switch (default true); false skips registering the four server_* tools. */
    enabled?: boolean
  }
  /** Bundled research-skill registration knobs. */
  skills?: {
    /**
     * Master switch (default true); false skips registering the nine bundled
     * research skills into the composition's skill registry. Registrations
     * only happen when a `skills` service is mounted at all.
     */
    enabled?: boolean
  }
}

/** Schemastery configuration for the research suite. */
export const Config: z<Config> = z.object({
  workspaceDir: z.string().default('.research'),
  reviewer: z.object({
    provider: z.string().default('spawn'),
    maxRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
  }).default({ provider: 'spawn', maxRounds: 3 }),
  latex: z.object({
    engine: z.string().default('auto'),
    timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(120_000),
  }).default({ engine: 'auto', timeoutMs: 120_000 }),
  arxiv: z.object({
    maxResults: z.number().step(1).min(1).max(100).default(10),
  }).default({ maxResults: 10 }),
  search: z.object({
    command: z.string().default('auto'),
    timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(30_000),
  }).default({ command: 'auto', timeoutMs: 30_000 }),
  zotero: z.object({
    apiKey: z.string().default(''),
    userId: z.string().default(''),
  }).default({ apiKey: '', userId: '' }),
  subscriptions: z.object({
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1440),
  }).default({ enabled: true, intervalMinutes: 1440 }),
  backup: z.object({
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(60),
    keep: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(24),
    dir: z.string().default('backups'),
  }).default({ enabled: true, intervalMinutes: 60, keep: 24, dir: 'backups' }),
  skills: z.object({
    enabled: z.boolean().default(true),
  }).default({ enabled: true }),
  serverTools: z.object({
    enabled: z.boolean().default(true),
  }).default({ enabled: true }),
})

/** Fully defaulted config view used by tools and commands. */
interface ResolvedConfig {
  readonly workspaceDir: string
  readonly reviewer: { readonly provider: string; readonly maxRounds: number }
  readonly latex: { readonly engine: string; readonly timeoutMs: number }
  readonly arxiv: { readonly maxResults: number }
  readonly search: { readonly command: string; readonly timeoutMs: number }
  readonly zotero: { readonly apiKey: string; readonly userId: string }
  readonly subscriptions: {
    readonly enabled: boolean
    readonly intervalMinutes: number
  }
  readonly backup: {
    readonly enabled: boolean
    readonly intervalMinutes: number
    readonly keep: number
    readonly dir: string
  }
  readonly skills: { readonly enabled: boolean }
  readonly serverTools: { readonly enabled: boolean }
}

/** Validate defaults even when a caller invokes apply() without Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const workspaceDir = config.workspaceDir ?? '.research'
  const reviewer = { provider: config.reviewer?.provider ?? 'spawn', maxRounds: config.reviewer?.maxRounds ?? 3 }
  const latex = { engine: config.latex?.engine ?? 'auto', timeoutMs: config.latex?.timeoutMs ?? 120_000 }
  const arxiv = { maxResults: config.arxiv?.maxResults ?? 10 }
  const search = { command: config.search?.command ?? 'auto', timeoutMs: config.search?.timeoutMs ?? 30_000 }
  const zotero = { apiKey: config.zotero?.apiKey ?? '', userId: config.zotero?.userId ?? '' }
  const subscriptions = {
    enabled: config.subscriptions?.enabled ?? true,
    intervalMinutes: config.subscriptions?.intervalMinutes ?? 1440,
  }
  const backup = {
    enabled: config.backup?.enabled ?? true,
    intervalMinutes: config.backup?.intervalMinutes ?? 60,
    keep: config.backup?.keep ?? 24,
    dir: config.backup?.dir ?? 'backups',
  }
  const skills = { enabled: config.skills?.enabled ?? true }
  const serverTools = { enabled: config.serverTools?.enabled ?? true }
  if (workspaceDir.trim().length === 0) throw new TypeError('workspaceDir must be a non-empty path')
  if (reviewer.provider.trim().length === 0) throw new TypeError('reviewer.provider must be a non-empty provider name')
  if (!Number.isSafeInteger(reviewer.maxRounds) || reviewer.maxRounds < 1) throw new TypeError('reviewer.maxRounds must be a positive safe integer')
  if (latex.engine.trim().length === 0) throw new TypeError('latex.engine must be a non-empty engine selection')
  if (!Number.isSafeInteger(latex.timeoutMs) || latex.timeoutMs < 1) throw new TypeError('latex.timeoutMs must be a positive safe integer')
  if (!Number.isSafeInteger(arxiv.maxResults) || arxiv.maxResults < 1) throw new TypeError('arxiv.maxResults must be a positive safe integer')
  if (search.command.trim().length === 0) throw new TypeError('search.command must be a non-empty command name')
  if (!Number.isSafeInteger(search.timeoutMs) || search.timeoutMs < 1) throw new TypeError('search.timeoutMs must be a positive safe integer')
  if (!Number.isSafeInteger(subscriptions.intervalMinutes) || subscriptions.intervalMinutes < 1) throw new TypeError('subscriptions.intervalMinutes must be a positive safe integer')
  if (!Number.isSafeInteger(backup.intervalMinutes) || backup.intervalMinutes < 1) throw new TypeError('backup.intervalMinutes must be a positive safe integer')
  if (!Number.isSafeInteger(backup.keep) || backup.keep < 1) throw new TypeError('backup.keep must be a positive safe integer')
  if (backup.dir.trim().length === 0) throw new TypeError('backup.dir must be a non-empty path')
  return { workspaceDir, reviewer, latex, arxiv, search, zotero, subscriptions, backup, skills, serverTools }
}

/**
 * Stream the compiled paper PDF for one wiki project. The paper directory
 * resolves per request — a `?dir=` query override, else the project record's
 * `paperDir`, else `paper` — always confined inside the workspace (a
 * violating `dir` is a 400), so the project id only selects WHICH project's
 * panel may read it: an unknown id is a 404.
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
function createPdfHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const pathname = url.pathname
    const prefix = '/research/pdf/'
    if (!pathname.startsWith(prefix) || pathname.length === prefix.length) {
      res.writeHead(404).end('expected /research/pdf/<project id>')
      return
    }
    let projectId: string
    try {
      projectId = decodeURIComponent(pathname.slice(prefix.length))
    } catch {
      res.writeHead(400).end('invalid encoded project id')
      return
    }
    const record = deps.domain.table('projects').get(projectId)
    if (record === undefined) {
      res.writeHead(404).end('unknown research project')
      return
    }
    const requestDir = url.searchParams.get('dir') ?? undefined
    const dir = resolvePaperDir(root, requestDir, record.paperDir)
    if (dir === undefined) {
      res.writeHead(400).end('dir must be a relative path inside the research workspace')
      return
    }
    const pdfPath = resolve(dir, 'main.pdf')
    const stats = await stat(pdfPath).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) {
      res.writeHead(404).end('paper pdf not found; compile first')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': stats.size,
      // The panel cache-busts with ?v=<pdfUpdatedAt>; a stale cached preview
      // would otherwise survive a recompile under the same URL.
      'Cache-Control': 'no-cache',
      // Defense-in-depth: the served bytes are not our app; never let the
      // browser guess a type or let a crafted PDF inherit our origin's
      // privileges, even though the file is workspace-local.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(pdfPath).pipe(res)
  }
}

/**
 * Stream one remembered paper's fetched PDF (the literature workbench's
 * embedded reader). The arXiv id only selects WHICH paper's file may be read:
 * an unknown id is a 404, as is a paper whose PDF was never fetched. The
 * stored `pdfPath` is workspace-relative; a path escaping the workspace is a
 * 400 (the fetch writer only ever produces `papers/<id>.pdf`, so a violating
 * value means a hand-edited store).
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
function createPaperPdfHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const prefix = '/research/paper-pdf/'
    if (!url.pathname.startsWith(prefix) || url.pathname.length === prefix.length) {
      res.writeHead(404).end('expected /research/paper-pdf/<arxiv id>')
      return
    }
    let arxivId: string
    try {
      arxivId = decodeURIComponent(url.pathname.slice(prefix.length))
    } catch {
      res.writeHead(400).end('invalid encoded arXiv id')
      return
    }
    const record = deps.domain.table('papers').get(arxivId)
    if (record === undefined) {
      res.writeHead(404).end('unknown research paper')
      return
    }
    if (record.pdfPath === undefined) {
      res.writeHead(404).end('paper pdf not fetched yet')
      return
    }
    const pdfPath = resolve(root, record.pdfPath)
    if (!pdfPath.startsWith(root + sep)) {
      res.writeHead(400).end('pdfPath escapes the research workspace')
      return
    }
    const stats = await stat(pdfPath).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) {
      res.writeHead(404).end('paper pdf file is gone; fetch it again')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': stats.size,
      // Same cache-bust rationale as the compiled-paper route: a refetch
      // overwrites the same file, and the panel busts with ?v=<timestamp>.
      'Cache-Control': 'no-cache',
      // Defense-in-depth: the served bytes are not our app; never let the
      // browser guess a type or let a crafted PDF/SVG inherit our origin's
      // privileges (sniffing + sandbox), even though these files are
      // workspace-local.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(pdfPath).pipe(res)
  }
}
/** Content-Type of one servable figure extension. */
const FIGURE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
}

/** The sxng CLI command the auto-detected web search resolves to. */
const SXNG_COMMAND = 'sxng'

/**
 * Absolute path of the sxng CLI bundled as an optional dependency, when the
 * npm install brought it along (`node_modules/sxng-cli/dist/index.js`). The
 * bin ships a node shebang, so the path runs directly under `execFile`.
 * @returns the absolute binary path, or undefined when the optional
 * dependency is absent.
 */
function bundledSxngCommand(): string | undefined {
  try {
    const packageJson = createRequire(import.meta.url).resolve('sxng-cli/package.json')
    const binary = join(dirname(packageJson), 'dist/index.js')
    return existsSync(binary) ? binary : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether one bare command name resolves to a runnable executable (a PATH
 * lookup via `<command> --version`). Injectable probe paths live in the
 * tools; this is the plugin's one startup check.
 * @param command - the bare command name.
 * @returns whether the executable resolved and ran.
 */
function commandOnPath(command: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    execFile(command, ['--version'], { timeout: 10_000 }, (error) => {
      resolveProbe(!(error !== null && (error as { code?: unknown }).code === 'ENOENT'))
    })
  })
}

/**
 * Stream one figure file of a wiki project's paper directory. The paper
 * directory resolves like the PDF route (`?dir=` override, record
 * `paperDir`, default); `?path=` is relative to it — an absolute path, a
 * `..` escape, or a non-figure extension is a 400, a missing file a 404.
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
function createFigureHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const prefix = '/research/figure/'
    if (!url.pathname.startsWith(prefix) || url.pathname.length === prefix.length) {
      res.writeHead(404).end('expected /research/figure/<project id>')
      return
    }
    let projectId: string
    try {
      projectId = decodeURIComponent(url.pathname.slice(prefix.length))
    } catch {
      res.writeHead(400).end('invalid encoded project id')
      return
    }
    const record = deps.domain.table('projects').get(projectId)
    if (record === undefined) {
      res.writeHead(404).end('unknown research project')
      return
    }
    const relPath = url.searchParams.get('path')
    if (relPath === null || relPath.length === 0 || !isFigureFile(relPath)) {
      res.writeHead(400).end('path must name a figure file (.png/.jpg/.jpeg/.svg/.pdf)')
      return
    }
    const dir = resolvePaperDir(root, url.searchParams.get('dir') ?? undefined, record.paperDir)
    if (dir === undefined) {
      res.writeHead(400).end('dir must be a relative path inside the research workspace')
      return
    }
    const figurePath = resolve(dir, relPath)
    if (!figurePath.startsWith(dir + sep)) {
      res.writeHead(400).end('path escapes the paper directory')
      return
    }
    const stats = await stat(figurePath).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) {
      res.writeHead(404).end('figure not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': FIGURE_CONTENT_TYPES[extname(relPath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stats.size,
      // Same cache-bust rationale as the PDF route; figures are immutable per
      // mtime from the panel's point of view.
      'Cache-Control': 'no-cache',
      // Defense-in-depth: a `.svg` is served as `image/svg+xml` from our
      // origin, and SVG can carry scripts. Pin the type (no sniff) and drop
      // all privileges (sandbox + default-src 'none') so a served figure
      // can never act as our page.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(figurePath).pipe(res)
  }
}

/** Raw-body cap of the figure upload route (a security invariant, not a tunable). */
const FIGURE_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024

/**
 * Receive one uploaded figure for a wiki project's paper directory. The query
 * carries `?project=` (an unknown id is a 404), `?name=` (reduced to its
 * basename, so no traversal is expressible; a non-figure extension is a 400).
 * The route requires an exact same-origin `Origin` header and always resolves
 * the destination from the project record's `paperDir`; callers cannot select
 * a different workspace directory. The raw body lands at `figures/<name>` under the paper directory (created on demand,
 * same-name overwrite); a body over {@link FIGURE_UPLOAD_LIMIT_BYTES} is a
 * 413, any method but POST a 405.
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
function createFigureUploadHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    if (!isSameOriginWrite(req.headers)) {
      res.writeHead(403).end('cross-origin uploads are not allowed')
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const projectId = url.searchParams.get('project')
    if (projectId === null || projectId.length === 0) {
      res.writeHead(400).end('expected ?project=<project id>')
      return
    }
    const record = deps.domain.table('projects').get(projectId)
    if (record === undefined) {
      res.writeHead(404).end('unknown research project')
      return
    }
    const name = basename(url.searchParams.get('name') ?? '')
    if (name === '' || !isFigureFile(name)) {
      res.writeHead(400).end('name must name a figure file (.png/.jpg/.jpeg/.svg/.pdf)')
      return
    }
    const dir = projectPaperDir(root, record.paperDir)
    if (dir === undefined) {
      res.writeHead(400).end('dir must be a relative path inside the research workspace')
      return
    }
    const chunks: Buffer[] = []
    let sizeBytes = 0
    for await (const chunk of req) {
      sizeBytes += (chunk as Buffer).length
      if (sizeBytes > FIGURE_UPLOAD_LIMIT_BYTES) {
        res.writeHead(413).end('figure exceeds the 50MB limit')
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }
    const figuresDir = join(dir, 'figures')
    await mkdir(figuresDir, { recursive: true })
    await writeFile(join(figuresDir, name), Buffer.concat(chunks))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ relPath: `figures/${name}` }))
  }
}

/** Raw-body cap of the template upload route (a security invariant, not a tunable). */
const TEMPLATE_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024

/** Extensions a venue-kit upload accepts (plain LaTeX kit files; no archives). */
const TEMPLATE_UPLOAD_EXTENSIONS = new Set(['.cls', '.sty', '.tex', '.bst', '.bbx', '.cbx', '.clo', '.def', '.cfg', '.md', '.txt', '.pdf'])

/**
 * Receive one uploaded venue-kit file for a wiki project's paper directory.
 * The query carries `?project=` (an unknown id is a 404) and `?name=`
 * (reduced to its basename; an extension outside
 * {@link TEMPLATE_UPLOAD_EXTENSIONS} is a 400). The route requires an exact
 * same-origin `Origin` header and always resolves the destination from the
 * project record's `paperDir`; callers cannot select a different workspace
 * directory. The raw body lands at
 * `template/<name>` under the paper directory (created on demand, same-name
 * overwrite); a body over {@link TEMPLATE_UPLOAD_LIMIT_BYTES} is a 413, any
 * method but POST a 405.
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
function createTemplateUploadHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    if (!isSameOriginWrite(req.headers)) {
      res.writeHead(403).end('cross-origin uploads are not allowed')
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const projectId = url.searchParams.get('project')
    if (projectId === null || projectId.length === 0) {
      res.writeHead(400).end('expected ?project=<project id>')
      return
    }
    const record = deps.domain.table('projects').get(projectId)
    if (record === undefined) {
      res.writeHead(404).end('unknown research project')
      return
    }
    const name = basename(url.searchParams.get('name') ?? '')
    if (name === '' || !TEMPLATE_UPLOAD_EXTENSIONS.has(extname(name).toLowerCase())) {
      res.writeHead(400).end('name must name a LaTeX kit file (.cls/.sty/.tex/.bst/...)')
      return
    }
    const dir = projectPaperDir(root, record.paperDir)
    if (dir === undefined) {
      res.writeHead(400).end('dir must be a relative path inside the research workspace')
      return
    }
    const chunks: Buffer[] = []
    let sizeBytes = 0
    for await (const chunk of req) {
      sizeBytes += (chunk as Buffer).length
      if (sizeBytes > TEMPLATE_UPLOAD_LIMIT_BYTES) {
        res.writeHead(413).end('template file exceeds the 50MB limit')
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }
    const templateDir = join(dir, TEMPLATE_DIR_NAME)
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, name), Buffer.concat(chunks))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ relPath: `${TEMPLATE_DIR_NAME}/${name}` }))
  }
}

/**
 * Download one generated group-meeting deck. The query carries `?project=`
 * (an unknown id is a 404) and `?file=` (reduced to its basename and confined
 * to `meetings/<projectId>/` by {@link meetingDeckPath}, so no traversal is
 * expressible; a non-.pptx name is a 400). Streams the pptx as an attachment,
 * so the panel's `<a href>` forces a download.
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
function createMeetingDeckHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const projectId = url.searchParams.get('project')
    const file = url.searchParams.get('file')
    if (projectId === null || file === null) {
      res.writeHead(400).end('expected ?project=<project id>&file=<deck file>')
      return
    }
    if (deps.domain.table('projects').get(projectId) === undefined) {
      res.writeHead(404).end('unknown research project')
      return
    }
    const deckPath = meetingDeckPath(root, projectId, file)
    if (deckPath === undefined) {
      res.writeHead(400).end('file must name a .pptx deck')
      return
    }
    const stats = await stat(deckPath).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) {
      res.writeHead(404).end('meeting deck not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Length': stats.size,
      'Content-Disposition': `attachment; filename="${basename(deckPath)}"`,
      'Cache-Control': 'no-cache',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(deckPath).pipe(res)
  }
}


/**
 * Mount the research suite: open the wiki domain, register the four tools and
 * the five commands, mount the research panel's Remote service and its HTTP
 * routes (compiled-paper PDF, paper PDF, figure, figure upload, template
 * upload, meeting-deck download), and tie the domain's close to the plugin lifecycle.
 * @param ctx - Plugin context.
 * @param config - Validated plugin config.
 * @returns resolution after the domain is open and every surface is registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const domain = await ctx.storageDomain.open(researchWikiDomainSpec)
  ctx.effect(() => () => domain.close(), 'mimir.domainClose')
  // Stored paper records with path-unsafe ids predate the whitelist (or were
  // hand-edited); quarantine them before any surface can join them into a
  // filesystem path. The schema stays permissive so their presence can never
  // abort the open itself.
  await quarantineUnsafePaperIds(domain, message => ctx.logger.warn(message))
  await recoverInterruptedJobs({ workspaceDir: resolve(process.cwd(), resolved.workspaceDir), domain })

  const deps: ResearchCommandDeps = {
    workspaceDir: resolve(process.cwd(), resolved.workspaceDir),
    domain,
    reviewer: resolved.reviewer,
    latex: resolved.latex,
  }

  // Scheduled wiki backup: first pass one minute after start (startup stays
  // fast), then every intervalMinutes; failures warn and the loop retries
  // next cycle. The effect ties the timers to the plugin lifecycle; the
  // service gets the resolved knobs either way so listBackups can report
  // `enabled: false` when the timer is configured off.
  const backupDir = resolve(deps.workspaceDir, resolved.backup.dir)

  ctx.tools.register(createArxivSearchTool(resolved.arxiv.maxResults))
  ctx.tools.register(createPaperFetchTool(domain))
  ctx.tools.register(createWikiNoteTool(domain))
  ctx.tools.register(createFigureSaveTool(deps.workspaceDir, domain))
  ctx.tools.register(createFigureOrganizeTool(deps.workspaceDir, domain))
  ctx.tools.register(createMeetingDeckTool(deps.workspaceDir, domain))
  ctx.tools.register(createLatexCompileTool(resolved.latex))
  ctx.tools.register(createVenueSearchTool(deps.workspaceDir))

  // Web search is optional: `auto` registers the tool when the sxng CLI
  // resolves on PATH (probed once) or as the bundled optional dependency; an
  // explicit command always registers and reports install guidance per call
  // when missing. The panel's searchWeb Remote follows the same availability.
  const searchCommand = resolved.search.command === 'auto'
    ? (await commandOnPath(SXNG_COMMAND)) ? SXNG_COMMAND : bundledSxngCommand()
    : resolved.search.command
  const searchConfig = searchCommand === undefined
    ? undefined
    : { command: searchCommand, timeoutMs: resolved.search.timeoutMs }
  if (searchCommand !== undefined) {
    ctx.tools.register(createWebSearchTool({
      command: searchCommand,
      timeoutMs: resolved.search.timeoutMs,
      maxResults: resolved.arxiv.maxResults,
    }))
  }
  // The panel's Servers view and the model-callable server_* tools share the
  // same server/job state through ResearchService; the tools only forward, so
  // registering them is a pure addition to the runtime the panel already
  // drives. The controller tests and the ssh-jobs harness construct the
  // service directly, so `ctx.research` may not be set in-process for the
  // full apply() wiring — resolve it lazily at execution time instead of
  // at registration time.
  if (resolved.serverTools.enabled) {
    const getResearch = () => ctx.get('research') as ResearchService | undefined
    ctx.tools.register(createServerListTool(getResearch))
    ctx.tools.register(createServerCheckTool(getResearch))
    ctx.tools.register(createServerSubmitJobTool(getResearch))
    ctx.tools.register(createServerListJobsTool(getResearch))
  }
  // Live wiki change push hub: the domain bridge and the events route are
  // wired further down; the service config below already carries the notify
  // hook for file-side writes.
  const wikiChangeHub = createWikiChangeHub()

  const serviceConfig: ResearchServiceConfig = {
    workspaceDir: deps.workspaceDir,
    domain,
    latex: resolved.latex,
    backup: { ...resolved.backup, dir: backupDir },
    ...(searchConfig === undefined ? {} : { search: searchConfig }),
    zotero: resolved.zotero,
    notifyWikiChange: event => wikiChangeHub.publish(event),
  }

  registerIdeaCommand(ctx, deps)
  registerPlanCommand(ctx, deps)
  registerReviewCommand(ctx, deps)
  registerPaperCommands(ctx, deps)
  registerSkillSyncCommand(ctx)

  // Bundled research skills: runtime contributions to the composition's
  // skill registry when one is mounted (ctx.inject makes the dependency
  // optional — bare compositions load the suite without it).
  if (resolved.skills.enabled) {
    registerResearchSkills(ctx)
    registerSxngSkill(ctx)
  }

  ctx.plugin(ResearchService, serviceConfig)
  if (resolved.backup.enabled) {
    ctx.effect(
      () => startWikiBackupLoop({
        domain,
        dir: backupDir,
        intervalMs: resolved.backup.intervalMinutes * 60_000,
        keep: resolved.backup.keep,
        onError: (error) => { console.warn('[mimir] wiki backup failed:', error) },
      }),
      'mimir.wikiBackup',
    )
  }
  // Scheduled arXiv subscription check (same timer pattern as the wiki
  // backup): first pass two minutes after start, then every intervalMinutes
  // (default once a day). Per-subscription fetch failures are captured in the
  // run's outcomes and never reach onError; the panel also surfaces them.
  if (resolved.subscriptions.enabled) {
    ctx.effect(
      () => startArxivSubscriptionLoop({
        workspaceDir: deps.workspaceDir,
        intervalMs: resolved.subscriptions.intervalMinutes * 60_000,
        onError: (error) => { console.warn('[mimir] arXiv subscription check failed:', error) },
      }),
      'mimir.arxivSubscriptions',
    )
  }
  // CCF venue-deadline refresh (same timer pattern as the wiki backup):
  // first pass two seconds after start, then every six hours; a failed pass
  // keeps the previous cache, and reads always hit the cache, never the
  // network — the panel and the venue_search tool work offline.
  ctx.effect(
    () => startVenueDeadlineLoop({
      workspaceDir: deps.workspaceDir,
      onError: (error) => { console.warn('[mimir] venue deadline refresh failed:', error) },
    }),
    'mimir.venueDeadlines',
  )
  // Live wiki change push: every durable domain write (agent tools, slash
  // commands, panel edits alike funnel through the domain) is bridged onto
  // the SSE hub the open panels subscribe to; file-side writes (main.tex,
  // bibliography.bib) reach the same hub through the service's notify hook.
  // The listener is global: `domain/changed` is emitted on the storage-domain
  // service context, whose scope filter excludes this plugin's context, so a
  // plain `ctx.on` here would never fire.
  ctx.effect(
    () => ctx.on('domain/changed', (change) => {
      if (change.domain !== researchWikiDomainSpec.name) return
      wikiChangeHub.publish({ table: change.table, key: change.key, operation: change.operation })
    }, { global: true }),
    'mimir.wikiChangeBridge',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/events',
      handler: createWikiEventsHandler(wikiChangeHub),
    }),
    'mimir.wikiEventsRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/pdf',
      handler: createPdfHandler(deps),
    }),
    'mimir.pdfRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/paper-pdf',
      handler: createPaperPdfHandler(deps),
    }),
    'mimir.paperPdfRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/figure',
      handler: createFigureHandler(deps),
    }),
    'mimir.figureRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/figure-upload',
      handler: createFigureUploadHandler(deps),
    }),
    'mimir.figureUploadRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/template-upload',
      handler: createTemplateUploadHandler(deps),
    }),
    'mimir.templateUploadRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/meeting',
      handler: createMeetingDeckHandler(deps),
    }),
    'mimir.meetingDeckRoute',
  )
}
