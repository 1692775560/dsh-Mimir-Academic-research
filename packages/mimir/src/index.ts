/**
 * Research-assistant plugin suite: an arXiv literature surface, a persistent
 * research wiki (papers / ideas / claims / projects), a LaTeX compile tool,
 * nine bundled research-workflow skills, and an independent fresh-reviewer
 * loop — the ARIS workflow mechanisms as one dsh-native plugin.
 * @module dsh-mimir
 */

import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ResearchCapabilitiesView, ResearchCapability } from './types.ts'
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
import type { ResearchServiceConfig } from './service.ts'
import { ResearchService } from './service.ts'
import { recoverInterruptedJobs } from './services/server.ts'
import { recoverPendingWikiImport } from './services/wiki-admin.ts'
import { buildDeps } from './services/wiring.ts'
import { registerResearchSkills } from './skills.ts'
import { registerDigdigSkill } from './digdig-skill.ts'
import { startWikiBackupLoop } from './backup.ts'
import { startArxivSubscriptionLoop } from './arxiv-subscriptions.ts'
import { TaskHealthRegistry } from './task-health.ts'
import { createWikiChangeHub, createWikiEventsHandler } from './wiki-events.ts'
import {
  createFigureHandler,
  createFigureUploadHandler,
  createMeetingDeckHandler,
  createPaperPdfHandler,
  createPdfHandler,
  createTemplateUploadHandler,
} from './routes.ts'
import { guardRoute } from './http-guard.ts'
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
  ResearchGetDigdigConfigResult,
  ResearchSetDigdigConfigResult,
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
  ResearchGetEvidenceGraphResult,
  ResearchEvidenceGraphView,
  ResearchAddEvidenceEdgeResult,
  ResearchRetractEvidenceEdgeResult,
  AddEvidenceEdgeRequest,
  RetractEvidenceEdgeRequest,
  ResearchGetHabitsResult,
  ResearchGetLibraryThemesResult,
  ResearchImportPaperResult,
  ResearchExportLibraryBibResult,
  ResearchJournalDraftKind,
  ResearchImportProjectRequest,
  ResearchImportProjectResult,
  ResearchImportedProject,
  ResearchGetCapabilitiesResult,
  ResearchCapabilitiesView,
  ResearchCapability,
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
// `LatexIssue` is what the panel's compile-fix view reads, so it stays on the
// root even though `parseLatexErrors` (its producer) moved to experimental.
export type { LatexIssue } from './latex-log.ts'
export { researchWikiDomainSpec } from './store.ts'
export type { ResearchWikiDomain } from './store.ts'
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
export type { ReviewerOptions, ReviewRequest, ReviewOutcome } from './reviewer.ts'
export { compileLatex, renderLatexResult, createLatexCompileTool, resolveLatexEngine, parseTectonicErrors, classifyProbeFailure } from './tools/latex.ts'
export type { LatexCompileResult, LatexToolOptions, LatexEngineKind, ResolvedLatexEngine, LatexEngineProbe } from './tools/latex.ts'
export { createArxivSearchTool, createPaperFetchTool, fetchArxivPdf, fetchArxivSearch, paperPdfFileName, parseArxivFeed, ARXIV_PDF_MAX_BYTES } from './tools/arxiv.ts'
export type { ArxivEntry, ArxivSearchOptions } from './tools/arxiv.ts'
export { createWebSearchTool, fetchWebSearch } from './tools/web-search.ts'
export { getDigdigConfig, readDigdigConfig, setDigdigConfig } from './services/digdig-config.ts'
export type { WebSearchOptions, WebSearchRunner } from './tools/web-search.ts'
export { registerDigdigSkill } from './digdig-skill.ts'
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
    /** Wall-clock budget per reviewer attempt in milliseconds (default 600_000). */
    timeoutMs?: number
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
    /**
     * Per-request timeout of arXiv search fetches in milliseconds (default
     * 30000): the panel's `searchArxiv` and the subscription check both bound
     * one request with it (the internal API attempt fails fast and falls back
     * to the web search page within the same budget).
     */
    timeoutMs?: number
  }
  /** Web search deployment knobs (the digdig CLI, `dg`, over a self-hosted SearXNG). */
  search?: {
    /**
     * The digdig executable (default `auto`): `'auto'` registers the
     * `web_search` tool when `dg` resolves on PATH or as the bundled
     * optional `digdig` dependency; an explicit binary name or absolute
     * path registers it unconditionally and fails per call with install
     * guidance when missing.
     */
    command?: string
    /** Search kill timeout in milliseconds (default 30000). */
    timeoutMs?: number
    /**
     * Default result cap of one web search (default 10, hard cap 50). Its
     * own knob: it used to ride on `arxiv.maxResults`, so tuning arXiv
     * silently resized every web search (#232).
     */
    maxResults?: number
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

/** The layer set, in the order the panel reports it (#242). */
const ALL_CAPABILITIES: readonly ResearchCapability[] = Object.freeze([
  'core', 'automation', 'compute', 'insights', 'presentation',
])

/** Schemastery configuration for the research suite. */
/**
 * One default per knob (#218).
 *
 * These constants are the single source: the schema below applies them, and
 * `resolveConfig` reads the same objects when it normalizes a config the
 * Loader never touched. A default written twice is a default that can drift.
 */
export const DEFAULTS = {
  workspaceDir: '.research',
  reviewer: { provider: 'spawn', maxRounds: 3, timeoutMs: 600_000 },
  latex: { engine: 'auto', timeoutMs: 120_000 },
  arxiv: { maxResults: 10, timeoutMs: 30_000 },
  search: { command: 'auto', timeoutMs: 30_000, maxResults: 10 },
  zotero: { apiKey: '', userId: '' },
  subscriptions: { enabled: true, intervalMinutes: 1440 },
  backup: { enabled: true, intervalMinutes: 60, keep: 24, dir: 'backups' },
  skills: { enabled: true },
  serverTools: { enabled: true },
} as const satisfies Record<string, unknown>

/**
 * Schemastery configuration for the research suite.
 *
 * Every `default(...)` below reads {@link DEFAULTS}; none of them restates a
 * literal, so adding a knob means adding it to `Config`, to `DEFAULTS`, and
 * to the schema — three edits in one file, and the type of `resolveConfig`'s
 * result is inferred from the shape rather than declared a fourth time.
 */
export const Config: z<Config> = z.object({
  workspaceDir: z.string().default(DEFAULTS.workspaceDir),
  reviewer: z.object({
    provider: z.string().default(DEFAULTS.reviewer.provider),
    maxRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.reviewer.maxRounds),
    timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.reviewer.timeoutMs),
  }).default(DEFAULTS.reviewer),
  latex: z.object({
    engine: z.string().default(DEFAULTS.latex.engine),
    timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.latex.timeoutMs),
  }).default(DEFAULTS.latex),
  arxiv: z.object({
    maxResults: z.number().step(1).min(1).max(100).default(DEFAULTS.arxiv.maxResults),
    timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.arxiv.timeoutMs),
  }).default(DEFAULTS.arxiv),
  search: z.object({
    command: z.string().default(DEFAULTS.search.command),
    timeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.search.timeoutMs),
    maxResults: z.number().step(1).min(1).max(50).default(DEFAULTS.search.maxResults),
  }).default(DEFAULTS.search),
  zotero: z.object({
    apiKey: z.string().default(DEFAULTS.zotero.apiKey),
    userId: z.string().default(DEFAULTS.zotero.userId),
  }).default(DEFAULTS.zotero),
  subscriptions: z.object({
    enabled: z.boolean().default(DEFAULTS.subscriptions.enabled),
    intervalMinutes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.subscriptions.intervalMinutes),
  }).default(DEFAULTS.subscriptions),
  backup: z.object({
    enabled: z.boolean().default(DEFAULTS.backup.enabled),
    intervalMinutes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.backup.intervalMinutes),
    keep: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.backup.keep),
    dir: z.string().default(DEFAULTS.backup.dir),
  }).default(DEFAULTS.backup),
  skills: z.object({
    enabled: z.boolean().default(DEFAULTS.skills.enabled),
  }).default(DEFAULTS.skills),
  serverTools: z.object({
    enabled: z.boolean().default(DEFAULTS.serverTools.enabled),
  }).default(DEFAULTS.serverTools),
})

/**
 * Fully defaulted config view used by tools and commands (#218).
 *
 * The shape is {@link DEFAULTS} made concrete: the schema applies those same
 * objects, so a knob added to `DEFAULTS` reaches this type without a second
 * declaration — which is exactly the drift this issue was about. (`Config`'s
 * schema parameter only carries the input type, so the output cannot be
 * recovered from the schema value; `DEFAULTS` is the part that can.)
 * `capabilities` is derived, never defaulted (#242), so it is intersected on
 * top of the widened shape.
 */
type Widen<T> = T extends string ? string
  : T extends number ? number
  : T extends boolean ? boolean
  : T extends object ? { readonly [K in keyof T]: Widen<T[K]> }
  : T

type ResolvedConfig = Widen<typeof DEFAULTS> & { readonly capabilities: ResearchCapabilitiesView }

/**
 * Fill in every default and derive what is derived (#218, #242). Exported for
 * the config tests: this is the seam every knob is checked at. Validates the
 * defaults even when a caller invokes apply() without Loader normalization.
 * @param config - the raw Loader config.
 * @returns the normalized config the plugin applies.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  // Every fallback reads DEFAULTS — the same objects the schema applies, so a
  // caller that bypasses Loader normalization and one that does not end up
  // with one set of numbers (#218).
  const workspaceDir = config.workspaceDir ?? DEFAULTS.workspaceDir
  const reviewer = {
    provider: config.reviewer?.provider ?? DEFAULTS.reviewer.provider,
    maxRounds: config.reviewer?.maxRounds ?? DEFAULTS.reviewer.maxRounds,
    timeoutMs: config.reviewer?.timeoutMs ?? DEFAULTS.reviewer.timeoutMs,
  }
  const latex = {
    engine: config.latex?.engine ?? DEFAULTS.latex.engine,
    timeoutMs: config.latex?.timeoutMs ?? DEFAULTS.latex.timeoutMs,
  }
  const arxiv = {
    maxResults: config.arxiv?.maxResults ?? DEFAULTS.arxiv.maxResults,
    timeoutMs: config.arxiv?.timeoutMs ?? DEFAULTS.arxiv.timeoutMs,
  }
  const search = {
    command: config.search?.command ?? DEFAULTS.search.command,
    timeoutMs: config.search?.timeoutMs ?? DEFAULTS.search.timeoutMs,
    maxResults: config.search?.maxResults ?? DEFAULTS.search.maxResults,
  }
  const zotero = {
    apiKey: config.zotero?.apiKey ?? DEFAULTS.zotero.apiKey,
    userId: config.zotero?.userId ?? DEFAULTS.zotero.userId,
  }
  const subscriptions = {
    enabled: config.subscriptions?.enabled ?? DEFAULTS.subscriptions.enabled,
    intervalMinutes: config.subscriptions?.intervalMinutes ?? DEFAULTS.subscriptions.intervalMinutes,
  }
  const backup = {
    enabled: config.backup?.enabled ?? DEFAULTS.backup.enabled,
    intervalMinutes: config.backup?.intervalMinutes ?? DEFAULTS.backup.intervalMinutes,
    keep: config.backup?.keep ?? DEFAULTS.backup.keep,
    dir: config.backup?.dir ?? DEFAULTS.backup.dir,
  }
  const skills = { enabled: config.skills?.enabled ?? DEFAULTS.skills.enabled }
  const serverTools = { enabled: config.serverTools?.enabled ?? DEFAULTS.serverTools.enabled }
  if (workspaceDir.trim().length === 0) throw new TypeError('workspaceDir must be a non-empty path')
  if (reviewer.provider.trim().length === 0) throw new TypeError('reviewer.provider must be a non-empty provider name')
  if (!Number.isSafeInteger(reviewer.maxRounds) || reviewer.maxRounds < 1) throw new TypeError('reviewer.maxRounds must be a positive safe integer')
  if (!Number.isSafeInteger(reviewer.timeoutMs) || reviewer.timeoutMs < 1) throw new TypeError('reviewer.timeoutMs must be a positive safe integer')
  if (latex.engine.trim().length === 0) throw new TypeError('latex.engine must be a non-empty engine selection')
  if (!Number.isSafeInteger(latex.timeoutMs) || latex.timeoutMs < 1) throw new TypeError('latex.timeoutMs must be a positive safe integer')
  if (!Number.isSafeInteger(arxiv.maxResults) || arxiv.maxResults < 1) throw new TypeError('arxiv.maxResults must be a positive safe integer')
  if (!Number.isSafeInteger(arxiv.timeoutMs) || arxiv.timeoutMs < 1) throw new TypeError('arxiv.timeoutMs must be a positive safe integer')
  if (search.command.trim().length === 0) throw new TypeError('search.command must be a non-empty command name')
  if (!Number.isSafeInteger(search.timeoutMs) || search.timeoutMs < 1) throw new TypeError('search.timeoutMs must be a positive safe integer')
  if (!Number.isSafeInteger(search.maxResults) || search.maxResults < 1) throw new TypeError('search.maxResults must be a positive safe integer')
  if (!Number.isSafeInteger(subscriptions.intervalMinutes) || subscriptions.intervalMinutes < 1) throw new TypeError('subscriptions.intervalMinutes must be a positive safe integer')
  if (!Number.isSafeInteger(backup.intervalMinutes) || backup.intervalMinutes < 1) throw new TypeError('backup.intervalMinutes must be a positive safe integer')
  if (!Number.isSafeInteger(backup.keep) || backup.keep < 1) throw new TypeError('backup.keep must be a positive safe integer')
  if (backup.dir.trim().length === 0) throw new TypeError('backup.dir must be a non-empty path')
  // The capability layers are derived, never configured (#242): a second place
  // to state which layer is on would be a second place to disagree with the
  // switch that actually gates the feature.
  const layers: readonly ResearchCapability[] = Object.freeze([
    'core',
    ...(subscriptions.enabled ? ['automation'] as const : []),
    ...(serverTools.enabled ? ['compute'] as const : []),
    ...(skills.enabled ? ['insights'] as const : []),
    'presentation',
  ])
  const capabilities: ResearchCapabilitiesView = Object.freeze({
    enabled: layers,
    disabled: Object.freeze(ALL_CAPABILITIES.filter(layer => !layers.includes(layer))),
  })
  return { workspaceDir, reviewer, latex, arxiv, search, zotero, subscriptions, backup, skills, serverTools, capabilities }
}


/** The digdig CLI command (`dg`) the auto-detected web search resolves to. */
const DIGDIG_COMMAND = 'dg'

/**
 * Absolute path of the digdig CLI bundled as an optional dependency, when the
 * npm install brought it along (`node_modules/digdig/dist/index.js`). The
 * bin ships a node shebang, so the path runs directly under `execFile`.
 * @returns the absolute binary path, or undefined when the optional
 * dependency is absent.
 */
function bundledDigdigCommand(): string | undefined {
  try {
    const packageJson = createRequire(import.meta.url).resolve('digdig/package.json')
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
  const workspaceDir = resolve(process.cwd(), resolved.workspaceDir)
  await recoverPendingWikiImport({ workspaceDir, domain })
  // Stored paper records with path-unsafe ids predate the whitelist (or were
  // hand-edited); quarantine them before any surface can join them into a
  // filesystem path. The schema stays permissive so their presence can never
  // abort the open itself.
  await quarantineUnsafePaperIds(domain, message => ctx.logger.warn(message))
  await recoverInterruptedJobs({ workspaceDir, domain })

  const deps: ResearchCommandDeps = {
    workspaceDir,
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

  // Web search is optional: `auto` registers the tool when `dg` resolves on
  // PATH (probed once) or as the bundled optional dependency; an
  // explicit command always registers and reports install guidance per call
  // when missing. The panel's searchWeb Remote follows the same availability.
  const searchCommand = resolved.search.command === 'auto'
    ? (await commandOnPath(DIGDIG_COMMAND)) ? DIGDIG_COMMAND : bundledDigdigCommand()
    : resolved.search.command
  const searchConfig = searchCommand === undefined
    ? undefined
    : { command: searchCommand, timeoutMs: resolved.search.timeoutMs, maxResults: resolved.search.maxResults }
  if (searchCommand !== undefined) {
    ctx.tools.register(createWebSearchTool({
      command: searchCommand,
      timeoutMs: resolved.search.timeoutMs,
      maxResults: resolved.search.maxResults,
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
  // Shared scheduled-task health book (#223): the three timer loops record
  // every pass here; the service exposes the snapshot via `getTaskHealth`.
  const taskHealth = new TaskHealthRegistry()

  // One assembly point (#231): the config is built here, never re-mapped by
  // the service constructor — `buildDeps` is the single description of what a
  // service config IS, so a knob added to one side cannot go missing on the
  // other.
  const serviceConfig: ResearchServiceConfig = buildDeps({
    workspaceDir: deps.workspaceDir,
    domain,
    config: {
      latex: resolved.latex,
      backup: { ...resolved.backup, dir: backupDir },
      ...(searchConfig === undefined ? {} : { search: searchConfig }),
      arxiv: { timeoutMs: resolved.arxiv.timeoutMs },
      ...(resolved.zotero === undefined ? {} : { zotero: resolved.zotero }),
      taskHealth,
      notifyWikiChange: event => wikiChangeHub.publish(event),
      capabilities: resolved.capabilities,
    },
  })

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
    registerDigdigSkill(ctx)
  }

  ctx.plugin(ResearchService, serviceConfig)
  if (resolved.backup.enabled) {
    ctx.effect(
      () => startWikiBackupLoop({
        domain,
        dir: backupDir,
        intervalMs: resolved.backup.intervalMinutes * 60_000,
        keep: resolved.backup.keep,
        health: taskHealth,
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
        timeoutMs: resolved.arxiv.timeoutMs,
        health: taskHealth,
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
      health: taskHealth,
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
      handler: guardRoute(createWikiEventsHandler(wikiChangeHub)),
    }),
    'mimir.wikiEventsRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/pdf',
      handler: guardRoute(createPdfHandler(deps)),
    }),
    'mimir.pdfRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/paper-pdf',
      handler: guardRoute(createPaperPdfHandler(deps)),
    }),
    'mimir.paperPdfRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/figure',
      handler: guardRoute(createFigureHandler(deps)),
    }),
    'mimir.figureRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/figure-upload',
      handler: guardRoute(createFigureUploadHandler(deps)),
    }),
    'mimir.figureUploadRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/template-upload',
      handler: guardRoute(createTemplateUploadHandler(deps)),
    }),
    'mimir.templateUploadRoute',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/research/meeting',
      handler: guardRoute(createMeetingDeckHandler(deps)),
    }),
    'mimir.meetingDeckRoute',
  )
}
