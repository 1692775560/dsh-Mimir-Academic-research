/**
 * Browser-local object layer behind the research panel: one controller per
 * client runtime backs both the project list and the selected project's
 * outline and compile status. Every read goes through the generated `research`
 * Remote; the generated face wraps each call in {@link RemoteResult}, so a
 * carrier failure arrives as the `ok: false` branch rather than a rejection.
 * Failures surface as `{ code, message }` pairs — the component maps the codes
 * it knows to localized copy and falls back to the Host-supplied message.
 * @module dsh-client-ui-mimir/client/controller
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ResearchKey } from './locales.ts'
import { figureBlockOf, findFigureReferenceLine, insertFigureBlock, isSvgFigure, svgConvertedRelPaths } from './figure-insert.ts'
import { WORKTREE_REASON_MAX_CHARS } from './worktree-view.ts'
import { anySubscriptionDue } from './subscriptions.ts'
import { metricFigureCaption, metricFigureFileName, metricFigureSvg } from './metric-figure.ts'
import type { MetricChartRow } from './view-common.ts'
import { pruneExpiredToasts, pushToast, type ResearchToast, type ResearchToastKind } from './toasts.ts'
import type {
  ArxivEntry,
  ArxivSubscriptionView,
  BibEntry,
  EventRecord,
  ExperimentRecord,
  ExperimentInput,
  FigureEntry,
  JobRecord,
  OutlineNode,
  PaperRecord,
  PaperSnapshotView,
  ResearchArtifactResult,
  ResearchArxivSubscriptionsResult,
  ResearchAddJournalEntryResult,
  ResearchCloseIdeaResult,
  ResearchAdoptIdeaResult,
  ResearchGetForagingResult,
  ResearchGetWorktreeResult,
  ResearchGetMomentIndexResult,
  ResearchGetEurekaViewResult,
  ResearchMomentIndexView,
  ResearchEurekaView,
  ResearchForagingView,
  ResearchSetIdeaParentResult,
  ResearchSetMainlineResult,
  ResearchWorktreeView,
  ResearchBriefQuestion,
  ResearchBackupStatusView,
  ResearchBibliographyResult,
  ResearchCheckArxivSubscriptionsResult,
  ResearchCheckServerResult,
  ResearchCheckZoteroResult,
  ResearchCompileResult,
  ResearchCompileStatusResult,
  ResearchCompileStatusView,
  ResearchConvertFigureResult,
  ResearchDeleteArxivSubscriptionResult,
  ResearchDeleteExperimentResult,
  ResearchDeleteFigureResult,
  ResearchDeleteJobResult,
  ResearchDeleteServerResult,
  ResearchEventFilter,
  ResearchExperimentsResult,
  ResearchExportWikiResult,
  ResearchFailure,
  ResearchFetchPaperPdfResult,
  ResearchFiguresResult,
  ResearchGenerateBriefOptions,
  ResearchGenerateBriefResult,
  ResearchGenerateDigestResult,
  ResearchDigestView,
  ResearchDigestTier,
  ResearchSetEurekaResult,
  ResearchPinMomentResult,
  ResearchJournalQuestionRef,
  ResearchImportBibResult,
  ResearchImportPaperResult,
  ResearchImportProjectRequest,
  ResearchImportProjectResult,
  ResearchImportedProject,
  ResearchImportWikiMode,
  ResearchImportWikiResult,
  ResearchListBackupsResult,
  ResearchListEventsResult,
  ResearchListJobsResult,
  ResearchListProjectsResult,
  ResearchListServersResult,
  ResearchScheduledTaskView,
  ResearchTaskHealthResult,
  ResearchVenueTemplatesResult,
  ResearchApplyVenueResult,
  ResearchClearVenueResult,
  ResearchDeleteMeetingDeckResult,
  ResearchGenerateMeetingResult,
  ResearchGetImageGenConfigResult,
  ResearchGetSxngConfigResult,
  ResearchMeetingDecksResult,
  MeetingDeckView,
  MeetingInclude,
  VenueTemplateView,
  ResearchOutlineResult,
  ResearchPaperSnapshotResult,
  ResearchPaperSnapshotsResult,
  ResearchPaperSourceResult,
  ResearchPapersResult,
  ResearchProjectView,
  ResearchProgressReportOptions,
  ResearchProgressReportResult,
  ResearchRemovePaperResult,
  ResearchRenameFigureResult,
  ResearchRevertPaperSnapshotResult,
  ResearchSaveArxivSubscriptionResult,
  ResearchSaveBibliographyResult,
  ResearchSaveExperimentResult,
  ResearchSavePaperSourceResult,
  ResearchSaveFigureResult,
  ResearchSaveServerResult,
  ResearchSearchArxivResult,
  ResearchSearchWebResult,
  ResearchSetImageGenConfigResult,
  ResearchSetSxngConfigResult,
  ResearchSubmitJobResult,
  ResearchUpdateExperimentResult,
  ResearchUpdateFigureResult,
  ResearchUpdatePaperResult,
  ResearchRefreshVenueDeadlinesResult,
  ResearchSetVenueWatchResult,
  ResearchVenueDeadlinesResult,
  ResearchWikiSnapshot,
  VenueDeadlineView,
  VenueJournalView,
  ResearchZoteroCollectionsResult,
  ResearchZoteroExportResult,
  ResearchZoteroImportResult,
  ResearchZoteroSearchResult,
  SectionMove,
  SectionOutlineTitles,
  ServerInput,
  ServerRecord,
  ServerStatusView,
  SubsectionMove,
  WebSearchEntry,
  ZoteroCollectionView,
  ZoteroItemView,
  ResearchWikiChangeEvent,
} from 'dsh-mimir/types'
import {
  createWikiChangeAggregator,
  type LiveSlice,
  type WikiChangeAggregator,
} from './live-refresh.ts'

// Re-exported so view components (DigestView) can import these model types
// from the controller module rather than reaching into the package directly.
export type {
  ResearchDigestView,
  ResearchDigestTier,
  ResearchExperienceCapsule,
  ResearchCapsulePerspective,
} from 'dsh-mimir/types'

/**
 * The Remote calls this controller needs, exactly as the
 * generated `research` namespace types them. The ledger remotes keep
 * `actorKind`/`order` as widened `string` (the generated face elides the
 * literal unions across the boundary).
 */
export interface ResearchRemote {
  listProjects: () => Promise<RemoteResult<ResearchListProjectsResult>>
  importProject: (request: ResearchImportProjectRequest) => Promise<RemoteResult<ResearchImportProjectResult>>
  getPaperOutline: (request: { projectId: string; dir?: string | undefined }) => Promise<RemoteResult<ResearchOutlineResult>>
  compile: (request: { projectId?: string; dir?: string | undefined }, signal?: AbortSignal) => Promise<RemoteResult<ResearchCompileResult>>
  getCompileStatus: (request: { projectId?: string }) => Promise<RemoteResult<ResearchCompileStatusResult>>
  getPaperSource: (request: { projectId: string; dir?: string | undefined }) => Promise<RemoteResult<ResearchPaperSourceResult>>
  savePaperSource: (request: {
    projectId: string
    content: string
    baseMtimeMs: number
    dir?: string | undefined
  }) => Promise<RemoteResult<ResearchSavePaperSourceResult>>
  listPapers: () => Promise<RemoteResult<ResearchPapersResult>>
  searchArxiv: (request: { query: string; maxResults?: number }) => Promise<RemoteResult<ResearchSearchArxivResult>>
  searchWeb: (request: {
    query: string
    maxResults?: number
    categories?: string | undefined
    lang?: string | undefined
  }) => Promise<RemoteResult<ResearchSearchWebResult>>
  importPaper: (request: { entry: ArxivEntry; projectId?: string | undefined }) => Promise<RemoteResult<ResearchImportPaperResult>>
  removePaper: (request: { arxivId: string }) => Promise<RemoteResult<ResearchRemovePaperResult>>
  updatePaper: (request: {
    arxivId: string
    tags?: string[] | undefined
    projectIds?: string[] | undefined
    notes?: string | undefined
    relevance?: { projectId: string; score: number; reason: string } | undefined
  }) => Promise<RemoteResult<ResearchUpdatePaperResult>>
  fetchPaperPdf: (request: { arxivId: string }) => Promise<RemoteResult<ResearchFetchPaperPdfResult>>
  checkZotero: () => Promise<RemoteResult<ResearchCheckZoteroResult>>
  listZoteroCollections: () => Promise<RemoteResult<ResearchZoteroCollectionsResult>>
  searchZotero: (request: { query: string; maxResults?: number }) => Promise<RemoteResult<ResearchZoteroSearchResult>>
  importZoteroItem: (request: { key: string; projectId?: string | undefined }) => Promise<RemoteResult<ResearchZoteroImportResult>>
  exportZoteroCollectionToBib: (request: {
    projectId: string
    collectionKey: string
    dir?: string | undefined
  }) => Promise<RemoteResult<ResearchZoteroExportResult>>
  listArxivSubscriptions: () => Promise<RemoteResult<ResearchArxivSubscriptionsResult>>
  saveArxivSubscription: (request: { query: string }) => Promise<RemoteResult<ResearchSaveArxivSubscriptionResult>>
  deleteArxivSubscription: (request: { id: string }) => Promise<RemoteResult<ResearchDeleteArxivSubscriptionResult>>
  checkArxivSubscriptions: (request: { id?: string }) => Promise<RemoteResult<ResearchCheckArxivSubscriptionsResult>>
  listExperiments: (request: { projectId?: string }) => Promise<RemoteResult<ResearchExperimentsResult>>
  deleteExperiment: (request: { id: string }) => Promise<RemoteResult<ResearchDeleteExperimentResult>>
  updateExperiment: (request: {
    id: string
    serverId?: string | null | undefined
  }) => Promise<RemoteResult<ResearchUpdateExperimentResult>>
  saveExperiment: (request: { experiment: ExperimentInput }) => Promise<RemoteResult<ResearchSaveExperimentResult>>
  readArtifact: (request: { projectId: string; name: string }) => Promise<RemoteResult<ResearchArtifactResult>>
  listFigures: (request: { projectId: string; dir?: string | undefined }) => Promise<RemoteResult<ResearchFiguresResult>>
  deleteFigure: (request: { projectId: string; relPath: string; dir?: string | undefined }) => Promise<RemoteResult<ResearchDeleteFigureResult>>
  renameFigure: (request: {
    projectId: string
    relPath: string
    newName: string
    dir?: string | undefined
  }) => Promise<RemoteResult<ResearchRenameFigureResult>>
  updateFigure: (request: {
    projectId: string
    relPath: string
    caption: string
  }) => Promise<RemoteResult<ResearchUpdateFigureResult>>
  convertFigure: (request: { projectId: string; relPath: string; dir?: string | undefined }) => Promise<RemoteResult<ResearchConvertFigureResult>>
  saveFigure: (request: {
    projectId: string
    name: string
    content: string
    caption?: string | undefined
    dir?: string | undefined
  }) => Promise<RemoteResult<ResearchSaveFigureResult>>
  listServers: () => Promise<RemoteResult<ResearchListServersResult>>
  listVenueTemplates: () => Promise<RemoteResult<ResearchVenueTemplatesResult>>
  applyVenueTemplate: (request: {
    projectId: string
    dir?: string | undefined
    templateId?: string | undefined
    customName?: string | undefined
  }) => Promise<RemoteResult<ResearchApplyVenueResult>>
  clearVenueTemplate: (request: { projectId: string }) => Promise<RemoteResult<ResearchClearVenueResult>>
  listVenueDeadlines: (request: { projectId?: string | undefined }) => Promise<RemoteResult<ResearchVenueDeadlinesResult>>
  setVenueWatch: (request: {
    projectId: string
    series: string
    watched: boolean
  }) => Promise<RemoteResult<ResearchSetVenueWatchResult>>
  refreshVenueDeadlines: () => Promise<RemoteResult<ResearchRefreshVenueDeadlinesResult>>
  generateMeetingDeck: (request: {
    projectId: string
    title?: string | undefined
    presenter?: string | undefined
    date?: string | undefined
    paperIds?: readonly string[] | undefined
    figureRelPaths?: readonly string[] | undefined
    include?: Partial<MeetingInclude> | undefined
    aiIllustrations?: boolean | undefined
  }) => Promise<RemoteResult<ResearchGenerateMeetingResult>>
  listMeetingDecks: (request: { projectId: string }) => Promise<RemoteResult<ResearchMeetingDecksResult>>
  deleteMeetingDeck: (request: { projectId: string; file: string }) => Promise<RemoteResult<ResearchDeleteMeetingDeckResult>>
  getImageGenConfig: () => Promise<RemoteResult<ResearchGetImageGenConfigResult>>
  setImageGenConfig: (request: {
    baseUrl?: string | undefined
    apiKey?: string | undefined
    model?: string | undefined
    size?: string | undefined
  }) => Promise<RemoteResult<ResearchSetImageGenConfigResult>>
  getSxngConfig: () => Promise<RemoteResult<ResearchGetSxngConfigResult>>
  setSxngConfig: (request: {
    baseUrl?: string | undefined
    defaultEngine?: string | undefined
    allowedEngines?: readonly string[] | undefined
    defaultLimit?: number | undefined
    defaultFormat?: 'md' | 'json' | undefined
    useProxy?: boolean | undefined
    proxyUrl?: string | undefined
    timeout?: number | undefined
    ollamaApiKey?: string | undefined
    redundancyThreshold?: number | undefined
    redundancyBigramThreshold?: number | undefined
  }) => Promise<RemoteResult<ResearchSetSxngConfigResult>>
  saveServer: (request: { server: ServerInput }) => Promise<RemoteResult<ResearchSaveServerResult>>
  deleteServer: (request: { id: string }) => Promise<RemoteResult<ResearchDeleteServerResult>>
  checkServer: (request: { id: string }) => Promise<RemoteResult<ResearchCheckServerResult>>
  submitJob: (request: {
    serverId: string
    command: string
    experimentId?: string | undefined
  }) => Promise<RemoteResult<ResearchSubmitJobResult>>
  listJobs: (request: { serverId?: string }) => Promise<RemoteResult<ResearchListJobsResult>>
  deleteJob: (request: { id: string }) => Promise<RemoteResult<ResearchDeleteJobResult>>
  getBibliography: (request: { projectId: string; dir?: string | undefined }) => Promise<RemoteResult<ResearchBibliographyResult>>
  saveBibliography: (request: {
    projectId: string
    entries: BibEntry[]
    baseMtimeMs: number | null
    dir?: string | undefined
  }) => Promise<RemoteResult<ResearchSaveBibliographyResult>>
  importPapersToBib: (request: {
    projectId: string
    arxivIds: string[]
    dir?: string | undefined
  }) => Promise<RemoteResult<ResearchImportBibResult>>
  reorderPaperSections: (request: {
    projectId: string
    moves: SectionMove[]
    baseOutline: string[]
    dir?: string | undefined
  }) => Promise<RemoteResult<ResearchSavePaperSourceResult>>
  reorderPaperSubsections: (request: {
    projectId: string
    moves: SubsectionMove[]
    baseOutline: SectionOutlineTitles[]
    dir?: string | undefined
  }) => Promise<RemoteResult<ResearchSavePaperSourceResult>>
  listPaperSnapshots: (request: { projectId: string }) => Promise<RemoteResult<ResearchPaperSnapshotsResult>>
  getPaperSnapshot: (request: { projectId: string; id: string }) => Promise<RemoteResult<ResearchPaperSnapshotResult>>
  revertPaperSnapshot: (request: {
    projectId: string
    id: string
    baseMtimeMs: number
    dir?: string | undefined
  }) => Promise<RemoteResult<ResearchRevertPaperSnapshotResult>>
  exportWiki: () => Promise<RemoteResult<ResearchExportWikiResult>>
  importWiki: (request: {
    snapshot: ResearchWikiSnapshot
    mode: ResearchImportWikiMode
    confirmReplace?: boolean
  }) => Promise<RemoteResult<ResearchImportWikiResult>>
  listBackups: () => Promise<RemoteResult<ResearchListBackupsResult>>
  getTaskHealth: () => Promise<RemoteResult<ResearchTaskHealthResult>>
  listEvents: (request: {
    projectId?: string | undefined
    actorKind?: string | undefined
    actionPrefix?: string | undefined
    since?: string | undefined
    until?: string | undefined
    limit?: number | undefined
    order?: string | undefined
  }) => Promise<RemoteResult<ResearchListEventsResult>>
  generateProgressReport: (request: {
    projectId?: string | undefined
    since?: string | undefined
    until?: string | undefined
  }) => Promise<RemoteResult<ResearchProgressReportResult>>
  generateBrief: (request: {
    projectId?: string | undefined
    since?: string | undefined
    until?: string | undefined
  }) => Promise<RemoteResult<ResearchGenerateBriefResult>>
  addJournalEntry: (request: {
    text: string
    projectId?: string | undefined
    ideaId?: string | undefined
    valence?: number | undefined
    arousal?: number | undefined
    question?: ResearchJournalQuestionRef | undefined
  }) => Promise<RemoteResult<ResearchAddJournalEntryResult>>
  getForaging: () => Promise<RemoteResult<ResearchGetForagingResult>>
  getWorktree: () => Promise<RemoteResult<ResearchGetWorktreeResult>>
  setMainline: (request: {
    ideaId?: string | undefined
    projectId?: string | undefined
  }) => Promise<RemoteResult<ResearchSetMainlineResult>>
  setIdeaParent: (request: {
    ideaId: string
    parentIdeaId: string | null
  }) => Promise<RemoteResult<ResearchSetIdeaParentResult>>
  adoptIdea: (request: { ideaId: string }) => Promise<RemoteResult<ResearchAdoptIdeaResult>>
  closeIdea: (request: {
    ideaId: string
    reason: string
  }) => Promise<RemoteResult<ResearchCloseIdeaResult>>
  /** Assemble one digest (weekly / monthly / project) as a pure fold, rendered as MMS. */
  generateDigest: (request: {
    tier?: string | undefined
    since?: string | undefined
    until?: string | undefined
    lang?: string | undefined
  }) => Promise<RemoteResult<ResearchGenerateDigestResult>>
  /** Declare one Eureka — the researcher's own named milestone (never system-declared). */
  setEureka: (request: {
    ideaId?: string | undefined
    projectId?: string | undefined
    title: string
  }) => Promise<RemoteResult<ResearchSetEurekaResult>>
  /** Pin (or unpin/decline) one moment — the explicit bookmark of a curated instant. */
  pinMoment: (request: {
    targetEventId: string
    note?: string | undefined
    pinned?: boolean | undefined
  }) => Promise<RemoteResult<ResearchPinMomentResult>>
  /** Read the unified moment timeline (S9b): pull-only, five sources, zero verbs. */
  getMomentIndex: (request: {
    since?: string | undefined
    until?: string | undefined
  }) => Promise<RemoteResult<ResearchGetMomentIndexResult>>
  /** Read the retrospective eureka view (S8c): declarations × measured roads. */
  getEurekaView: () => Promise<RemoteResult<ResearchGetEurekaViewResult>>
}

/** Quiet period after the last keystroke before the draft autosaves. */
export const AUTOSAVE_DEBOUNCE_MS = 800
/** Quiet period after a successful save before the auto-compile fires. */
export const COMPILE_DEBOUNCE_MS = 1500
/** Quiet window that collapses an agent's burst of wiki writes into one refresh. */
export const LIVE_REFRESH_DEBOUNCE_MS = 400
/** Hard cap on the burst window: a sustained write stream never postpones the flush past this. */
export const LIVE_REFRESH_MAX_WAIT_MS = 2_000

/** One open `/research/events` stream handle (EventSource or a test double). */
export interface WikiEventStream {
  close(): void
}

/**
 * Opener for the wiki events stream; the default uses the page's EventSource.
 * @param url - the events route.
 * @param onEvent - parsed change-frame consumer.
 * @param onReconnect - fired on every open AFTER the first: the stream gave
 *   no replay guarantee, so writes landed during the outage are unknown and
 *   the consumer must re-read from scratch.
 * @returns the stream handle, or null where EventSource is unavailable.
 */
export type WikiEventStreamFactory = (
  url: string,
  onEvent: (event: ResearchWikiChangeEvent) => void,
  onReconnect?: () => void,
) => WikiEventStream | null

/** The browser default: one EventSource with silent auto-reconnect. */
const defaultWikiEventStream: WikiEventStreamFactory = (url, onEvent, onReconnect) => {
  if (typeof globalThis.EventSource !== 'function') return null
  const source = new EventSource(url)
  let opened = false
  source.onopen = () => {
    // The first open needs no compensation (every slice loads on demand); a
    // RE-open means frames may have been lost while the stream was down.
    if (opened) onReconnect?.()
    opened = true
  }
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(String(message.data)) as ResearchWikiChangeEvent)
    } catch {
      // A malformed frame is dropped; the stream stays open.
    }
  }
  return source
}

/** Load lifecycle of one fetched view. */
export type ResearchLoadStatus = 'cold' | 'loading' | 'ready' | 'error'

/** One settled failure: a known code for localized copy plus the raw message. */
export interface ResearchFailureView {
  readonly code: string
  readonly message: string
}

/** The selected project's outline load. */
export interface ResearchOutlineView {
  readonly projectId: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly nodes: readonly OutlineNode[]
  readonly failure: ResearchFailureView | null
}

/** Compile status annotated with the project it belongs to. */
export interface ResearchCompileView extends ResearchCompileStatusView {
  readonly projectId: string | null
}

/** Autosave lifecycle of the editor draft. */
export type ResearchSaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'save-error'

/** The selected project's source-editor view. */
export interface ResearchSourceView {
  readonly projectId: string
  readonly status: 'loading' | 'ready' | 'error'
  /** The draft: the file's content, with local edits not yet saved. */
  readonly content: string
  /** mtime the current draft is based on; null until the first load settles. */
  readonly mtimeMs: number | null
  readonly saveState: ResearchSaveState
  readonly failure: ResearchFailureView | null
}

/**
 * A pending editor jump the paper view applies once its draft shows the
 * target line (the figures view's insert-into-paper outcome). The monotonic
 * `seq` re-fires the paper view's effect when two jumps land on the same line.
 */
export interface ResearchPaperJump {
  readonly projectId: string
  /** 1-based target line in the current draft. */
  readonly line: number
  readonly seq: number
}

/** The literature view: every remembered paper. */
export interface ResearchPapersView {
  readonly status: ResearchLoadStatus
  readonly list: readonly PaperRecord[]
  readonly failure: ResearchFailureView | null
}

/** The venue picker's built-in template registry slice. */
export interface ResearchVenueTemplatesView {
  readonly status: ResearchLoadStatus
  readonly list: readonly VenueTemplateView[]
  readonly failure: ResearchFailureView | null
}

/** The arXiv search panel: the last query's outcome (null before any search). */
export interface ResearchArxivSearchView {
  readonly query: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly list: readonly ArxivEntry[]
  readonly failure: ResearchFailureView | null
}

/** The web search panel: the last query's outcome (null before any search). */
export interface ResearchWebSearchView {
  readonly query: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly list: readonly WebSearchEntry[]
  readonly failure: ResearchFailureView | null
}

/** The papers view's Zotero section: connection status plus the collection list. */
export interface ResearchZoteroView {
  readonly status: ResearchLoadStatus
  /** The settled probe outcome; null while the first check is still cold. */
  readonly state: 'unconfigured' | 'ok' | 'failed' | null
  /** The probe's failure reason (state `failed`); null otherwise. */
  readonly message: string | null
  /** The configured library's collections; empty until a successful check loads them. */
  readonly collections: readonly ZoteroCollectionView[]
  readonly failure: ResearchFailureView | null
}

/** The Zotero search panel: the last query's outcome (null before any search). */
export interface ResearchZoteroSearchView {
  readonly query: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly list: readonly ZoteroItemView[]
  readonly failure: ResearchFailureView | null
}

/** The arXiv subscription bar of the papers view. */
export interface ResearchSubscriptionsView {
  readonly status: ResearchLoadStatus
  readonly list: readonly ArxivSubscriptionView[]
  /** True while a check run is in flight (manual or open-triggered). */
  readonly checking: boolean
  /** Whole-call failure of the list load; per-subscription check failures live in `checkErrors`. */
  readonly failure: ResearchFailureView | null
  /** The last run's per-subscription fetch failures, keyed by subscription id. */
  readonly checkErrors: Readonly<Record<string, string>>
}

/** One per-project fetched view (experiments, artifact, figures). */
export interface ResearchProjectSlice<T> {
  readonly projectId: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly list: T
  readonly failure: ResearchFailureView | null
}

/** The meetings view's image-generation config (the panel-safe masked view). */
export interface ResearchImageGenView {
  readonly status: ResearchLoadStatus
  /** Whether an API key is stored host-side. */
  readonly configured: boolean
  readonly baseUrl: string
  readonly model: string
  readonly size: string
  /** The stored key's mask (e.g. `sk-ab…34`); '' when unconfigured. */
  readonly apiKeyPreview: string
  readonly failure: ResearchFailureView | null
}

/** The Papers view's native sxng-cli configuration. */
export interface ResearchSxngConfigView {
  readonly status: ResearchLoadStatus
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
  readonly failure: ResearchFailureView | null
}

/** The markdown artifact viewer's load. */
export interface ResearchArtifactView {
  readonly projectId: string
  readonly name: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly content: string
  readonly mtimeMs: number | null
  readonly failure: ResearchFailureView | null
}

/** The servers view: every remembered compute server. */
export interface ResearchServersView {
  readonly status: ResearchLoadStatus
  readonly list: readonly ServerRecord[]
  readonly failure: ResearchFailureView | null
}

/**
 * The venues view: the cached ccfddl conference catalog (every series with
 * its current edition resolved), the static CCF-A journal directory, and the
 * watch list of the project the list was loaded for (`watchedProjectId`, null
 * = no project addressed). `fetchedAt` is the upstream snapshot's age; null
 * means the cache has never been fetched (first-ever start, offline).
 */
export interface ResearchVenuesView {
  readonly status: ResearchLoadStatus
  readonly list: readonly VenueDeadlineView[]
  readonly journals: readonly VenueJournalView[]
  readonly watched: readonly string[]
  readonly watchedProjectId: string | null
  readonly fetchedAt: string | null
  readonly failure: ResearchFailureView | null
}

/** The remote-jobs view: every submitted job, most recently submitted first. */
export interface ResearchJobsView {
  readonly status: ResearchLoadStatus
  readonly list: readonly JobRecord[]
  readonly failure: ResearchFailureView | null
}

/** Settled counts of one `importPapersToBib` run (appended vs already-present keys). */
export interface ResearchImportCounts {
  readonly added: readonly string[]
  readonly skipped: readonly string[]
}

/** The ledger (growth record) view: one time window's events, newest first. */
export interface ResearchLedgerView {
  readonly status: ResearchLoadStatus
  readonly list: readonly EventRecord[]
  readonly failure: ResearchFailureView | null
}

/** The last progress report the ledger view generated (null fields while none). */
export interface ResearchReportView {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly markdown: string
  readonly generatedAt: string | null
  readonly eventCount: number | null
  readonly failure: ResearchFailureView | null
}

/** The last cognitive brief the ledger view generated (null fields while none). */
export interface ResearchBriefView {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly markdown: string
  readonly generatedAt: string | null
  readonly eventCount: number | null
  /** The derivation version the brief was rendered under (I5). */
  readonly derivationVersion: number | null
  /** True when this version differs from the last one seen (I5: the map re-calibrated). */
  readonly recalibrated: boolean
  /** Label-resolved boundary questions (the confirmation cards' data). */
  readonly questions: readonly ResearchBriefQuestion[]
  readonly failure: ResearchFailureView | null
}

/** The worktree (S2) slice: the derived working tree, cold until first opened. */
export interface ResearchWorktreeSlice {
  readonly status: ResearchLoadStatus
  readonly view: ResearchWorktreeView | null
  readonly failure: ResearchFailureView | null
}

/**
 * The digest (B–F) slice: the weekly / monthly / project report as a
 * generated model. It is generation-driven (like the brief) but pushed
 * proactively when the ledger view first opens. The model is a plain data
 * object — no prediction, no "you are near an insight" prompt.
 */
export interface ResearchDigestSlice {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  /** The depth last requested (or `weekly` before the first generation). */
  readonly tier: ResearchDigestTier
  /** The language the report model + MMS were rendered in. */
  readonly lang: 'zh' | 'en'
  /** The assembled report model (rendered directly by DigestView); null until ready. */
  readonly report: ResearchDigestView | null
  /** The MMS string for copy / download into a wiki, Obsidian, or GitHub. */
  readonly markdown: string
  readonly generatedAt: string | null
  readonly failure: ResearchFailureView | null
}

/** The foraging (S4) slice: the territory ledger + GUT baseline, cold until opened. */
export interface ResearchForagingSlice {
  readonly status: ResearchLoadStatus
  readonly view: ResearchForagingView | null
  readonly failure: ResearchFailureView | null
}

/** The moments (S9b) slice: the unified timeline, cold until first opened. */
export interface ResearchMomentsSlice {
  readonly status: ResearchLoadStatus
  readonly view: ResearchMomentIndexView | null
  readonly failure: ResearchFailureView | null
}

/** The eureka (S8c) slice: declarations × measured roads, cold until opened. */
export interface ResearchEurekaSlice {
  readonly status: ResearchLoadStatus
  readonly view: ResearchEurekaView | null
  readonly failure: ResearchFailureView | null
}

/** The selected project's `references.bib` view, edited entry-wise through the panel. */
export interface ResearchBibView {
  readonly projectId: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly entries: readonly BibEntry[]
  /** Optimistic-concurrency base for entry deletes; null while the file is absent. */
  readonly mtimeMs: number | null
  readonly saveState: ResearchSaveState
  readonly failure: ResearchFailureView | null
  /** The last import's counts, surfaced as the panel's confirmation line. */
  readonly lastImport: ResearchImportCounts | null
}

/** One server's probe lifecycle: in flight, or the last settled view. */
export type ServerCheckState = ServerStatusView | 'checking'

/** One snapshot's fetched content (the diff source of the snapshots panel). */
export interface ResearchSnapshotDetailView {
  readonly projectId: string
  readonly id: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly files: readonly { readonly path: string; readonly content: string }[]
  readonly failure: ResearchFailureView | null
}

/** Immutable view published to the panel. */
export interface ResearchView {
  readonly projects: readonly ResearchProjectView[]
  readonly projectsStatus: ResearchLoadStatus
  readonly projectsFailure: ResearchFailureView | null
  readonly outline: ResearchOutlineView | null
  readonly compile: ResearchCompileView
  readonly source: ResearchSourceView | null
  readonly papers: ResearchPapersView
  /** The papers view's arXiv search outcome; null before the first search. */
  readonly arxivSearch: ResearchArxivSearchView | null
  /** The papers view's web search outcome; null before the first search. */
  readonly webSearch: ResearchWebSearchView | null
  /** The papers view's arXiv subscription bar. */
  readonly arxivSubscriptions: ResearchSubscriptionsView
  /** The papers view's Zotero section (connection status plus collections). */
  readonly zotero: ResearchZoteroView
  /** The Zotero section's search outcome; null before the first search. */
  readonly zoteroSearch: ResearchZoteroSearchView | null
  readonly experiments: ResearchProjectSlice<readonly ExperimentRecord[]> | null
  readonly artifact: ResearchArtifactView | null
  readonly figures: ResearchProjectSlice<readonly FigureEntry[]> | null
  /** The meetings view's generated decks of the selected project; null until first opened. */
  readonly meetings: ResearchProjectSlice<readonly MeetingDeckView[]> | null
  /** The meetings view's image-generation config; `cold` until first fetched. */
  readonly imageGen: ResearchImageGenView
  /** The Papers view's sxng-cli config; `cold` until its Web tab opens. */
  readonly sxngConfig: ResearchSxngConfigView
  readonly servers: ResearchServersView
  /** Per-server probe state, keyed by server id; absent means never probed. */
  readonly serverChecks: Readonly<Record<string, ServerCheckState>>
  /** Submitted remote jobs (the servers view's jobs section). */
  readonly jobs: ResearchJobsView
  /** The selected project's bibliography; null until the bib panel first opens. */
  readonly bib: ResearchBibView | null
  /** The selected project's paper snapshots; null until the snapshots panel first opens. */
  readonly snapshots: ResearchProjectSlice<readonly PaperSnapshotView[]> | null
  /** The venue picker's built-in template registry; loads once, lazily. */
  readonly venueTemplates: ResearchVenueTemplatesView
  /** The venues view's ccfddl catalog + the selected project's watch list; cold until first opened. */
  readonly venues: ResearchVenuesView
  /** The snapshot the snapshots panel expanded for diffing; null when closed. */
  readonly snapshotDetail: ResearchSnapshotDetailView | null
  /** The ledger (growth record) view's events for its selected window. */
  readonly ledger: ResearchLedgerView
  /** The ledger view's progress report; `idle` before the first generation. */
  readonly report: ResearchReportView
  /** The ledger view's cognitive brief (CBE roadbook); `idle` before the first generation. */
  readonly brief: ResearchBriefView
  /** The ledger view's worktree (S2): the process as branches, dead ends, and the mainline ref. */
  readonly worktree: ResearchWorktreeSlice
  /** The ledger view's foraging layer (S4): territories, the GUT baseline, the GUT cards. */
  readonly foraging: ResearchForagingSlice
  /** The ledger view's moments (S9b): the unified timeline, five sources, zero verbs. */
  readonly moments: ResearchMomentsSlice
  /** The ledger view's eureka (S8c): declarations with their measured roads. */
  readonly eureka: ResearchEurekaSlice
  /** The ledger view's digest (B–F): six-perspective capsules + Eureka EWS, pushed on open. */
  readonly digest: ResearchDigestSlice
  /** The corner toast queue (oldest first); the host component sweeps expiries. */
  readonly toasts: readonly ResearchToast[]
  /** Scheduled-backup status for the overview; null until loaded (or on failure). */
  readonly backup: ResearchBackupStatusView | null
  /** Scheduled-task health snapshot (#223); null until loaded (or on failure). */
  readonly taskHealth: readonly ResearchScheduledTaskView[] | null
  /** The pending paper-editor jump of a figure insert; null once consumed. */
  readonly paperJump: ResearchPaperJump | null
}

const INITIAL_VIEW: ResearchView = Object.freeze({
  projects: Object.freeze([]),
  projectsStatus: 'cold',
  projectsFailure: null,
  outline: null,
  compile: Object.freeze({ projectId: null, state: 'idle', issues: Object.freeze([]), engine: null, pdfUpdatedAt: null, observed: false }),
  source: null,
  papers: Object.freeze({ status: 'cold', list: Object.freeze([]), failure: null }),
  arxivSearch: null,
  webSearch: null,
  arxivSubscriptions: Object.freeze({
    status: 'cold', list: Object.freeze([]), checking: false, failure: null, checkErrors: Object.freeze({}),
  }),
  zotero: Object.freeze({
    status: 'cold', state: null, message: null, collections: Object.freeze([]), failure: null,
  }),
  zoteroSearch: null,
  experiments: null,
  artifact: null,
  figures: null,
  meetings: null,
  imageGen: Object.freeze({
    status: 'cold', configured: false, baseUrl: '', model: '', size: '', apiKeyPreview: '', failure: null,
  }),
  sxngConfig: Object.freeze({
    status: 'cold', configured: false, baseUrl: '', defaultEngine: '', allowedEngines: Object.freeze([]), defaultLimit: 10,
    defaultFormat: 'md', useProxy: false, proxyUrl: '', timeout: 30_000, ollamaApiKeyPreview: '',
    redundancyThreshold: 0.7, redundancyBigramThreshold: 0.5, failure: null,
  }),
  servers: Object.freeze({ status: 'cold', list: Object.freeze([]), failure: null }),
  serverChecks: Object.freeze({}),
  jobs: Object.freeze({ status: 'cold', list: Object.freeze([]), failure: null }),
  bib: null,
  snapshots: null,
  snapshotDetail: null,
  venueTemplates: Object.freeze({ status: 'cold', list: Object.freeze([]), failure: null }),
  venues: Object.freeze({
    status: 'cold', list: Object.freeze([]), journals: Object.freeze([]),
    watched: Object.freeze([]), watchedProjectId: null, fetchedAt: null, failure: null,
  }),
  ledger: Object.freeze({ status: 'cold', list: Object.freeze([]), failure: null }),
  report: Object.freeze({ status: 'idle', markdown: '', generatedAt: null, eventCount: null, failure: null }),
  brief: Object.freeze({ status: 'idle', markdown: '', generatedAt: null, eventCount: null, derivationVersion: null, recalibrated: false, questions: Object.freeze([]), failure: null }),
  worktree: Object.freeze({ status: 'cold', view: null, failure: null }),
  foraging: Object.freeze({ status: 'cold', view: null, failure: null }),
  moments: Object.freeze({ status: 'cold', view: null, failure: null }),
  eureka: Object.freeze({ status: 'cold', view: null, failure: null }),
  digest: Object.freeze({ status: 'idle', tier: 'weekly', lang: 'zh', report: null, markdown: '', generatedAt: null, failure: null }),
  toasts: Object.freeze([]),
  backup: null,
  taskHealth: null,
  paperJump: null,
})

/** Translate one settled Remote envelope or business branch into a failure view. */
function failureOf(code: string, message: string): ResearchFailureView {
  return Object.freeze({ code, message })
}

/** Failure view of one host business failure; only some variants carry a message. */
function businessFailure(error: ResearchFailure): ResearchFailureView {
  return failureOf(error.code, 'message' in error ? error.message : error.code)
}

/** Failure view of a thrown transport error. */
function transportFailure(error: unknown): ResearchFailureView {
  return failureOf('transport', error instanceof Error ? error.message : 'research remote call failed')
}

/**
 * The panel's object layer. The paper directory is shared across projects, so
 * compile status is tracked per addressed project id but describes the same
 * physical compile; the Host owns the authoritative record.
 */
export class ResearchController implements HostObservable<ResearchView> {
  private view = INITIAL_VIEW
  private readonly listeners = new Set<() => void>()
  private loadPromise: Promise<void> | null = null
  private backupPromise: Promise<void> | null = null
  private taskHealthPromise: Promise<void> | null = null
  private papersPromise: Promise<void> | null = null
  private subscriptionsPromise: Promise<void> | null = null
  private zoteroPromise: Promise<void> | null = null
  private zoteroGeneration = 0
  private serversPromise: Promise<void> | null = null
  private jobsPromise: Promise<void> | null = null
  /** Cancels stale outline replies after project changes or outline refreshes. */
  private outlineGeneration = 0
  /** Cancels stale source replies independently of the outline lifecycle. */
  private sourceGeneration = 0
  /** Cancels stale experiment replies independently of paper reads. */
  private experimentsGeneration = 0
  /** Cancels stale compile-status replies after project changes. */
  private compileGeneration = 0
  private artifactGeneration = 0
  private figuresGeneration = 0
  private arxivGeneration = 0
  private webGeneration = 0
  private bibGeneration = 0
  private snapshotsGeneration = 0
  private snapshotDetailGeneration = 0
  private ledgerGeneration = 0
  private reportGeneration = 0
  private briefGeneration = 0
  /** In-flight digest generation counter (the supersede contract). */
  private digestGeneration = 0
  /** In-flight digest load guard (the ensure contract). */
  private digestPromise: Promise<ResearchFailureView | null> | null = null
  /** In-flight worktree load guard (the ensure/refresh contract). */
  private worktreePromise: Promise<void> | null = null
  /** In-flight foraging load guard (the ensure/refresh contract). */
  private foragingPromise: Promise<void> | null = null
  private momentsPromise: Promise<void> | null = null
  private eurekaPromise: Promise<void> | null = null
  private figuresInFlight = false
  private figuresRefreshPending: { readonly projectId: string; readonly quiet: boolean } | null = null
  private meetingsGeneration = 0
  private meetingsInFlight = false
  private meetingsRefreshProject: string | null = null
  private imageGenInFlight = false
  private sxngConfigInFlight = false
  /** A venue-registry load already in flight is left alone. */
  private venueTemplatesInFlight = false
  /** A venue-catalog load already in flight is left alone. */
  private venuesInFlight = false
  /** Cancels a stale venue-catalog reply when a newer request queued behind it. */
  private venuesGeneration = 0
  /** The newest venue load requested while another was in flight. */
  private venuesPending: { readonly projectId: string | null; readonly quiet: boolean } | null = null
  private snapshotsInFlight = false
  private compileAbort: AbortController | null = null
  private compileProject: string | null = null
  private compileQueued = new Set<string>
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private compileTimer: ReturnType<typeof setTimeout> | null = null
  private saveInFlight = false
  private saveAgain = false
  /** Identifies the save currently holding {@link saveInFlight}; a stale save's finally must not clear it. */
  private saveSeq = 0
  /**
   * The last dirty draft of a project the user navigated away from while its
   * save was still in flight; persisted by a trailing save chained off the
   * in-flight save's settle.
   */
  private pendingTrailingSave: { readonly projectId: string; readonly content: string; readonly mtimeMs: number } | null = null
  /** Live-refresh: supersedes an older overlapping source re-read; a late reply loses. */
  private liveSourceReadSeq = 0
  /** Live-refresh: the open `/research/events` stream, or null. */
  private eventStream: WikiEventStream | null = null
  /** Live-refresh: the trailing-debounce aggregator behind pushed changes. */
  private readonly liveAggregator: WikiChangeAggregator = createWikiChangeAggregator(
    slices => this.applyLiveSlices(slices),
    LIVE_REFRESH_DEBOUNCE_MS,
    LIVE_REFRESH_MAX_WAIT_MS,
  )
  /** The filter of the last ledger load, replayed by the live refresh. */
  private ledgerFilter: ResearchEventFilter | null = null
  private disposed = false
  private toastSeq = 0
  private paperJumpSeq = 0

  /**
   * @param remote - the research Remote namespace.
   */
  constructor(private readonly remote: ResearchRemote) {}

  /** Return the cached immutable view. */
  getSnapshot = (): ResearchView => this.view

  /** Subscribe to view replacement. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Load the project list once; a failed load stays retryable. */
  ensure(): void {
    if (this.view.projectsStatus === 'ready' || this.loadPromise !== null) return
    this.loadPromise = this.loadProjects().finally(() => { this.loadPromise = null })
    this.backupPromise ??= this.loadBackup().finally(() => { this.backupPromise = null })
    this.taskHealthPromise ??= this.loadTaskHealth().finally(() => { this.taskHealthPromise = null })
  }

  /** Re-read the project list (the retry entry and the reconnect resync). */
  resync(): void {
    if (this.view.projectsStatus === 'cold') return
    this.loadPromise ??= this.loadProjects().finally(() => { this.loadPromise = null })
    this.backupPromise ??= this.loadBackup().finally(() => { this.backupPromise = null })
    this.taskHealthPromise ??= this.loadTaskHealth().finally(() => { this.taskHealthPromise = null })
  }

  /**
   * Fetch the scheduled-backup status for the overview's data section.
   * Informational only: any failure leaves the slice null, hiding the line
   * instead of surfacing an error.
   */
  private async loadBackup(): Promise<void> {
    try {
      const carried = await this.remote.listBackups()
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
      if (this.disposed) return
      if (!carried.ok || !carried.value.ok) return
      this.publish({ backup: carried.value.value.backup })
    } catch {
      // Quiet by design: the line simply stays hidden.
    }
  }

  /**
   * Fetch the scheduled-task health snapshot (#223) for the overview's data
   * section. Informational only: any failure leaves the slice null, hiding
   * the block instead of surfacing an error.
   */
  private async loadTaskHealth(): Promise<void> {
    try {
      const carried = await this.remote.getTaskHealth()
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
      if (this.disposed) return
      if (!carried.ok || !carried.value.ok) return
      this.publish({ taskHealth: carried.value.value.tasks })
    } catch {
      // Quiet by design: the block simply stays hidden.
    }
  }

  /**
   * Push one toast into the corner stack: same copy+detail dedupes to a
   * refresh, the queue caps at {@link TOAST_LIMIT} (oldest drops first).
   * Only user-initiated, slow, or asynchronous completions call this — never
   * high-frequency editor state like the autosave pill.
   * @param kind - toast severity.
   * @param copy - locale copy key (the controller stays locale-free).
   * @param detail - optional verbatim suffix (counts, the failure message).
   */
  notify(kind: ResearchToastKind, copy: ResearchKey, detail: string | null = null): void {
    if (this.disposed) return
    this.toastSeq += 1
    const { list } = pushToast(this.view.toasts, kind, copy, detail, Date.now(), this.toastSeq)
    this.publish({ toasts: list })
  }

  /** Remove one toast (the × button). @param id - toast id. */
  dismissToast(id: number): void {
    this.publish({ toasts: Object.freeze(this.view.toasts.filter(toast => toast.id !== id)) })
  }

  /** Sweep expired toasts (the host component's expiry timer). */
  pruneToasts(): void {
    const kept = pruneExpiredToasts(this.view.toasts, Date.now())
    if (kept !== this.view.toasts) this.publish({ toasts: kept })
  }

  /**
   * Export the whole wiki as one snapshot (the overview data section's
   * download button).
   * @returns the snapshot, or the settled failure view.
   */
  async exportWiki(): Promise<ResearchWikiSnapshot | ResearchFailureView> {
    try {
      const carried = await this.remote.exportWiki()
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      return result.value.snapshot
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Import one parsed snapshot in the given mode, then re-fetch every loaded
   * slice so the panel reflects the new wiki without a reopen.
   * @param snapshot - the parsed export JSON (revalidated host-side).
   * @param mode - `merge` skips existing keys; `replace` wipes first.
   * @param confirmReplace - must be true for `replace`.
   * @returns the per-table counts, or the settled failure view.
   */
  async importWiki(
    snapshot: unknown,
    mode: ResearchImportWikiMode,
    confirmReplace: boolean,
  ): Promise<{ imported: Record<string, number>; skipped: Record<string, number> } | ResearchFailureView> {
    try {
      // The boundary type is the snapshot shape; the parsed file is unknown
      // here and revalidated row-by-row host-side before any write.
      const carried = await this.remote.importWiki({ snapshot: snapshot as ResearchWikiSnapshot, mode, confirmReplace })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.reloadAll()
      const imported = Object.values(result.value.imported).reduce((sum, count) => sum + count, 0)
      const skipped = Object.values(result.value.skipped).reduce((sum, count) => sum + count, 0)
      this.notify('success', 'toast.wikiImported', `${imported} / ${skipped}`)
      return result.value
    } catch (error) {
      return transportFailure(error)
    }
  }

  /** Re-fetch every loaded slice (the post-import repaint). */
  reloadAll(): void {
    if (this.view.projectsStatus !== 'cold') void this.loadProjects()
    if (this.view.papers.status !== 'cold') void this.loadPapers()
    if (this.view.servers.status !== 'cold') void this.loadServers()
    if (this.view.jobs.status !== 'cold') void this.loadJobs()
    const projectId = this.view.outline?.projectId ?? null
    if (projectId === null) return
    this.select(projectId)
    if (this.view.figures !== null) this.loadFigures(projectId, true)
    if (this.view.snapshots !== null) this.loadSnapshots(projectId, true)
    const artifact = this.view.artifact
    if (artifact !== null) this.loadArtifact(artifact.projectId, artifact.name, true)
    if (this.view.bib !== null) this.reloadBibliography()
  }

  /**
   * Load one window of ledger (growth record) events for the ledger view. A
   * newer window supersedes an in-flight one, whose late reply is discarded by
   * generation; the previous window's events stay on screen while the refresh
   * runs (no blank flash on a window switch).
   * @param filter - the window/scope/order/limit filter the view assembled.
   */
  loadLedger(filter: ResearchEventFilter): void {
    this.ledgerFilter = filter
    this.ledgerGeneration += 1
    const generation = this.ledgerGeneration
    const publishLedger = (view: ResearchLedgerView): void => {
      if (this.disposed || generation !== this.ledgerGeneration) return
      this.publish({ ledger: Object.freeze(view) })
    }
    const current = this.view.ledger
    publishLedger({ ...current, status: 'loading', failure: null })
    void (async (): Promise<void> => {
      try {
        const carried = await this.remote.listEvents({ ...filter })
        if (!carried.ok) {
          publishLedger({ status: 'error', list: Object.freeze([]), failure: failureOf(carried.error.code, carried.error.message) })
          return
        }
        const result = carried.value
        if (!result.ok) {
          publishLedger({ status: 'error', list: Object.freeze([]), failure: businessFailure(result.error) })
          return
        }
        publishLedger({ status: 'ready', list: Object.freeze(result.value.events), failure: null })
      } catch (error) {
        publishLedger({ status: 'error', list: Object.freeze([]), failure: transportFailure(error) })
      }
    })()
  }

  /**
   * Generate the progress report of one window (the ledger view's button):
   * publish `loading`, then the rendered Markdown or the settled failure. A
   * newer generation supersedes an in-flight one; the returned failure (when
   * any) is what the button surfaces — a success toasts once.
   * @param options - the window/scope options the view assembled.
   * @returns null on success, the settled failure view otherwise.
   */
  async generateReport(options: ResearchProgressReportOptions): Promise<ResearchFailureView | null> {
    this.reportGeneration += 1
    const generation = this.reportGeneration
    this.publish({
      report: Object.freeze({ status: 'loading', markdown: '', generatedAt: null, eventCount: null, failure: null }),
    })
    try {
      const carried = await this.remote.generateProgressReport({ ...options })
      if (this.disposed || generation !== this.reportGeneration) return null
      if (!carried.ok) {
        const failure = failureOf(carried.error.code, carried.error.message)
        this.publish({ report: Object.freeze({ ...this.view.report, status: 'error', failure }) })
        return failure
      }
      const result = carried.value
      if (!result.ok) {
        const failure = businessFailure(result.error)
        this.publish({ report: Object.freeze({ ...this.view.report, status: 'error', failure }) })
        return failure
      }
      this.publish({
        report: Object.freeze({
          status: 'ready',
          markdown: result.value.markdown,
          generatedAt: result.value.generatedAt,
          eventCount: result.value.eventCount,
          failure: null,
        }),
      })
      this.notify('success', 'ledger.report.ready')
      return null
    } catch (error) {
      const failure = transportFailure(error)
      if (!this.disposed && generation === this.reportGeneration) {
        this.publish({ report: Object.freeze({ ...this.view.report, status: 'error', failure }) })
      }
      return failure
    }
  }

  /** localStorage key of the last-seen derivation version (I5 notice). */
  private static readonly DERIVATION_STORAGE_KEY = 'mimir:cbe-derivation-version'

  /**
   * I5: remember the derivation version the user last saw; a changed
   * version returns true so the brief view can show the re-calibration
   * notice. Persistence is best-effort — a blocked storage just drops the
   * cross-session comparison, never the brief.
   */
  private derivationRecalibrated(version: number): boolean {
    let previous: string | null = null
    try {
      previous = localStorage.getItem(ResearchController.DERIVATION_STORAGE_KEY)
      localStorage.setItem(ResearchController.DERIVATION_STORAGE_KEY, String(version))
    } catch {
      previous = null
    }
    return previous !== null && previous !== String(version)
  }

  /**
   * Generate the cognitive brief (CBE roadbook) of one window (the brief
   * card's button): the same publish/supersede contract as
   * {@link generateReport}. A success toasts once.
   * @param options - the window/scope options the view assembled.
   * @returns null on success, the settled failure view otherwise.
   */
  async generateBrief(options: ResearchGenerateBriefOptions): Promise<ResearchFailureView | null> {
    this.briefGeneration += 1
    const generation = this.briefGeneration
    this.publish({
      brief: Object.freeze({
        status: 'loading',
        markdown: '',
        generatedAt: null,
        eventCount: null,
        derivationVersion: null,
        recalibrated: false,
        questions: Object.freeze([]),
        failure: null,
      }),
    })
    try {
      const carried = await this.remote.generateBrief({ ...options })
      if (this.disposed || generation !== this.briefGeneration) return null
      if (!carried.ok) {
        const failure = failureOf(carried.error.code, carried.error.message)
        this.publish({ brief: Object.freeze({ ...this.view.brief, status: 'error', failure }) })
        return failure
      }
      const result = carried.value
      if (!result.ok) {
        const failure = businessFailure(result.error)
        this.publish({ brief: Object.freeze({ ...this.view.brief, status: 'error', failure }) })
        return failure
      }
      this.publish({
        brief: Object.freeze({
          status: 'ready',
          markdown: result.value.markdown,
          generatedAt: result.value.generatedAt,
          eventCount: result.value.eventCount,
          derivationVersion: result.value.derivationVersion,
          recalibrated: this.derivationRecalibrated(result.value.derivationVersion),
          questions: Object.freeze(result.value.questions),
          failure: null,
        }),
      })
      this.notify('success', 'brief.ready')
      return null
    } catch (error) {
      const failure = transportFailure(error)
      if (!this.disposed && generation === this.briefGeneration) {
        this.publish({ brief: Object.freeze({ ...this.view.brief, status: 'error', failure }) })
      }
      return failure
    }
  }

  /**
   * Generate the digest (B–F) of one tier (the digest card's tier switch, or
   * the proactive first-open push): publish `loading`, then the assembled
   * report model + MMS string, or the settled failure. A newer generation
   * supersedes an in-flight one.
   * @param tier - weekly / monthly / project.
   * @param lang - zh / en.
   * @returns null on success, the settled failure view otherwise.
   */
  async generateDigest(tier: ResearchDigestTier, lang: 'zh' | 'en'): Promise<ResearchFailureView | null> {
    this.digestGeneration += 1
    const generation = this.digestGeneration
    this.publish({
      digest: Object.freeze({ ...this.view.digest, status: 'loading', tier, lang }),
    })
    try {
      const carried = await this.remote.generateDigest({ tier, lang })
      if (this.disposed || generation !== this.digestGeneration) return null
      if (!carried.ok) {
        const failure = failureOf(carried.error.code, carried.error.message)
        this.publish({ digest: Object.freeze({ ...this.view.digest, status: 'error', failure }) })
        return failure
      }
      const result = carried.value
      if (!result.ok) {
        const failure = businessFailure(result.error)
        this.publish({ digest: Object.freeze({ ...this.view.digest, status: 'error', failure }) })
        return failure
      }
      this.publish({
        digest: Object.freeze({
          status: 'ready',
          tier: result.value.tier,
          lang: result.value.lang,
          report: result.value.digest,
          markdown: result.value.markdown,
          generatedAt: result.value.generatedAt,
          failure: null,
        }),
      })
      return null
    } catch (error) {
      const failure = transportFailure(error)
      if (!this.disposed && generation === this.digestGeneration) {
        this.publish({ digest: Object.freeze({ ...this.view.digest, status: 'error', failure }) })
      }
      return failure
    }
  }

  /** Load the digest once, on the ledger view's first open (active push). */
  ensureDigest(): void {
    if (this.view.digest.status !== 'idle' || this.digestPromise !== null) return
    this.digestPromise = this.generateDigest('weekly', 'zh').finally(() => { this.digestPromise = null })
  }

  /** Re-fetch the digest at its current tier/lang (the card's refresh button). */
  refreshDigest(): void {
    if (this.digestPromise !== null) return
    void this.generateDigest(this.view.digest.tier, this.view.digest.lang)
  }

  /**
   * Declare one Eureka (the digest card's "name a milestone" form) — the
   * researcher's own words; the system never declares one and never prompts
   * "you are near an insight". A success toasts once and refreshes the digest
   * so the new milestone's lead-in EWS appears.
   * @returns null on success, the settled failure view otherwise.
   */
  async setEureka(
    ideaId: string | undefined,
    projectId: string | undefined,
    title: string,
  ): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.setEureka({ ideaId, projectId, title })
      if (!carried.ok) { this.notify('error', 'eureka.failed'); return failureOf(carried.error.code, carried.error.message) }
      const result = carried.value
      if (!result.ok) { this.notify('error', 'eureka.failed'); return businessFailure(result.error) }
      this.notify('success', 'eureka.ready')
      if (this.view.digest.status === 'ready') void this.generateDigest(this.view.digest.tier, this.view.digest.lang)
      return null
    } catch (error) {
      this.notify('error', 'eureka.failed')
      return transportFailure(error)
    }
  }

  /**
   * Pin one moment (a capsule's pin affordance) — the explicit bookmark of a
   * curated instant. A success toasts once and refreshes the digest so the
   * pinned moment's capsule updates.
   * @returns null on success, the settled failure view otherwise.
   */
  async pinMoment(targetEventId: string, note?: string | undefined): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.pinMoment({ targetEventId, note, pinned: true })
      if (!carried.ok) { this.notify('error', 'moment.failed'); return failureOf(carried.error.code, carried.error.message) }
      const result = carried.value
      if (!result.ok) { this.notify('error', 'moment.failed'); return businessFailure(result.error) }
      this.notify('success', 'moment.pinned')
      if (this.view.digest.status === 'ready') void this.generateDigest(this.view.digest.tier, this.view.digest.lang)
      await this.refreshMoments()
      return null
    } catch (error) {
      this.notify('error', 'moment.failed')
      return transportFailure(error)
    }
  }

  /**
   * Decline one moment candidate (the timeline's decline affordance): a
   * `pinned:false` declaration on a never-canonical candidate — "seen and
   * refused", distinct from unpin. The row stays (append-only readability)
   * and moves to the declined group.
   * @returns null on success, the settled failure view otherwise.
   */
  async declineMoment(targetEventId: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.pinMoment({ targetEventId, pinned: false })
      if (!carried.ok) { this.notify('error', 'moment.failed'); return failureOf(carried.error.code, carried.error.message) }
      const result = carried.value
      if (!result.ok) { this.notify('error', 'moment.failed'); return businessFailure(result.error) }
      this.notify('success', 'moment.declined')
      await this.refreshMoments()
      return null
    } catch (error) {
      this.notify('error', 'moment.failed')
      return transportFailure(error)
    }
  }

  /**
   * Write one L2 journal line (the journal box's submit): the text plus the
   * project scope the view assembled, and optional refs — an `ideaId` writes
   * the entry against one line (the boundary-question cards' answer path),
   * `valence`/`arousal` are 1–5 self-report ratings that ride the payload.
   * A success toasts once and returns null; a failure returns the failure
   * view WITHOUT a toast — the journal box surfaces it inline.
   * @param text - the user's words (validated client-side, capped server-side).
   * @param projectId - the project scope, or null for an unscoped entry.
   * @param refs - optional line ref and self-reported mood ratings.
   * @returns null on success, the settled failure view otherwise.
   */
  async addJournal(
    text: string,
    projectId: string | null,
    refs?: { ideaId?: string | undefined; valence?: number | undefined; arousal?: number | undefined; question?: ResearchJournalQuestionRef | undefined },
  ): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.addJournalEntry({
        text,
        ...(projectId === null ? {} : { projectId }),
        ...(refs?.ideaId === undefined ? {} : { ideaId: refs.ideaId }),
        ...(refs?.valence === undefined ? {} : { valence: refs.valence }),
        ...(refs?.arousal === undefined ? {} : { arousal: refs.arousal }),
        ...(refs?.question === undefined ? {} : { question: refs.question }),
      })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.notify('success', 'journal.added')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Load the worktree (S2) slice: the derived working tree over the full
   * ledger — lanes with their statuses and documented-No numbers, the
   * declared parent edges, the mainline ref and its reflog. Publishing
   * contract mirrors {@link generateBrief}: loading → ready/error, the
   * previous view kept while loading.
   */
  private async loadWorktree(): Promise<void> {
    this.publish({
      worktree: Object.freeze({ status: 'loading', view: this.view.worktree.view, failure: null }),
    })
    try {
      const carried = await this.remote.getWorktree()
      if (!carried.ok) {
        const failure = failureOf(carried.error.code, carried.error.message)
        this.publish({ worktree: Object.freeze({ status: 'error', view: null, failure }) })
        return
      }
      const result = carried.value
      if (!result.ok) {
        const failure = businessFailure(result.error)
        this.publish({ worktree: Object.freeze({ status: 'error', view: null, failure }) })
        return
      }
      this.publish({
        worktree: Object.freeze({ status: 'ready', view: result.value.worktree, failure: null }),
      })
    } catch (error) {
      const failure = transportFailure(error)
      this.publish({ worktree: Object.freeze({ status: 'error', view: null, failure }) })
    }
  }

  /**
   * Load the foraging (S4) slice: the territory ledger, the GUT baseline,
   * and the GUT cards — the same publish contract as the worktree slice.
   */
  private async loadForaging(): Promise<void> {
    this.publish({
      foraging: Object.freeze({ status: 'loading', view: this.view.foraging.view, failure: null }),
    })
    try {
      const carried = await this.remote.getForaging()
      if (!carried.ok) {
        const failure = failureOf(carried.error.code, carried.error.message)
        this.publish({ foraging: Object.freeze({ status: 'error', view: null, failure }) })
        return
      }
      const result = carried.value
      if (!result.ok) {
        const failure = businessFailure(result.error)
        this.publish({ foraging: Object.freeze({ status: 'error', view: null, failure }) })
        return
      }
      this.publish({
        foraging: Object.freeze({ status: 'ready', view: result.value.foraging, failure: null }),
      })
    } catch (error) {
      const failure = transportFailure(error)
      this.publish({ foraging: Object.freeze({ status: 'error', view: null, failure }) })
    }
  }

  /** Load the foraging layer once, on the ledger view's first open. */
  ensureForaging(): void {
    if (this.view.foraging.status === 'ready' || this.foragingPromise !== null) return
    this.foragingPromise = this.loadForaging().finally(() => { this.foragingPromise = null })
  }

  /**
   * Load the moments (S9b) slice: the unified timeline over the five
   * deterministic sources, unified with pins and declines. Pull-only; the
   * same publish contract as the worktree/foraging slices.
   */
  private async loadMoments(): Promise<void> {
    this.publish({
      moments: Object.freeze({ status: 'loading', view: this.view.moments.view, failure: null }),
    })
    try {
      const carried = await this.remote.getMomentIndex({})
      if (!carried.ok) {
        const failure = failureOf(carried.error.code, carried.error.message)
        this.publish({ moments: Object.freeze({ status: 'error', view: null, failure }) })
        return
      }
      const result = carried.value
      if (!result.ok) {
        const failure = businessFailure(result.error)
        this.publish({ moments: Object.freeze({ status: 'error', view: null, failure }) })
        return
      }
      this.publish({
        moments: Object.freeze({ status: 'ready', view: result.value, failure: null }),
      })
    } catch (error) {
      const failure = transportFailure(error)
      this.publish({ moments: Object.freeze({ status: 'error', view: null, failure }) })
    }
  }

  /** Load the moments timeline once, on the ledger view's first open. */
  ensureMoments(): void {
    if (this.view.moments.status === 'ready' || this.momentsPromise !== null) return
    this.momentsPromise = this.loadMoments().finally(() => { this.momentsPromise = null })
  }

  /**
   * Reload the moments timeline after a pin/decline/unpin write, so the
   * timeline reflects the researcher's latest declarations.
   */
  async refreshMoments(): Promise<void> {
    await this.loadMoments()
  }

  /** Load the eureka (S8c) slice: declarations × lead/control features + profile. */
  private async loadEureka(): Promise<void> {
    this.publish({
      eureka: Object.freeze({ status: 'loading', view: this.view.eureka.view, failure: null }),
    })
    try {
      const carried = await this.remote.getEurekaView()
      if (!carried.ok) {
        const failure = failureOf(carried.error.code, carried.error.message)
        this.publish({ eureka: Object.freeze({ status: 'error', view: null, failure }) })
        return
      }
      const result = carried.value
      if (!result.ok) {
        const failure = businessFailure(result.error)
        this.publish({ eureka: Object.freeze({ status: 'error', view: null, failure }) })
        return
      }
      this.publish({
        eureka: Object.freeze({ status: 'ready', view: result.value, failure: null }),
      })
    } catch (error) {
      const failure = transportFailure(error)
      this.publish({ eureka: Object.freeze({ status: 'error', view: null, failure }) })
    }
  }

  /** Load the eureka view once, on the ledger view's first open. */
  ensureEureka(): void {
    if (this.view.eureka.status === 'ready' || this.eurekaPromise !== null) return
    this.eurekaPromise = this.loadEureka().finally(() => { this.eurekaPromise = null })
  }

  /** Re-fetch the foraging layer (the card's refresh button). */
  refreshForaging(): void {
    if (this.foragingPromise !== null) return
    this.foragingPromise = this.loadForaging().finally(() => { this.foragingPromise = null })
  }

  /** Refresh the foraging layer behind an in-flight guard (write paths). */
  private requeueForaging(): void {
    if (this.foragingPromise !== null) return
    this.foragingPromise = this.loadForaging().finally(() => { this.foragingPromise = null })
  }

  /** Load the worktree once, on the ledger view's first open. */
  ensureWorktree(): void {
    if (this.view.worktree.status === 'ready' || this.worktreePromise !== null) return
    this.worktreePromise = this.loadWorktree().finally(() => { this.worktreePromise = null })
  }

  /** Re-fetch the worktree (after a structural write, or the refresh button). */
  refreshWorktree(): void {
    if (this.worktreePromise !== null) return
    this.worktreePromise = this.loadWorktree().finally(() => { this.worktreePromise = null })
  }

  /** Refresh the worktree behind an in-flight guard, used by the write verbs. */
  private requeueWorktree(): void {
    if (this.worktreePromise !== null) return
    this.worktreePromise = this.loadWorktree().finally(() => { this.worktreePromise = null })
  }

  /**
   * Move the mainline ref (one explicit user declaration; the system never
   * ranks lines into it). A success toasts once and refreshes the tree so
   * the new ref renders immediately.
   * @param lineId - the lane to declare (idea id or `project:<id>`).
   * @returns null on success, the settled failure view otherwise.
   */
  async setMainline(lineId: string): Promise<ResearchFailureView | null> {
    const request = lineId.startsWith('project:')
      ? { projectId: lineId.slice('project:'.length) }
      : { ideaId: lineId }
    try {
      const carried = await this.remote.setMainline(request)
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.notify('success', 'worktree.mainline.ready')
      this.requeueWorktree()
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Declare (or clear, with null) one derivation edge — a branch point in
   * the surveyor's own words; never inferred. A success toasts once and
   * refreshes the tree.
   * @param ideaId - the child idea lane.
   * @param parentIdeaId - the parent idea lane, or null to clear.
   * @returns null on success, the settled failure view otherwise.
   */
  async setIdeaParent(ideaId: string, parentIdeaId: string | null): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.setIdeaParent({ ideaId, parentIdeaId })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.notify('success', 'worktree.parent.ready')
      this.requeueWorktree()
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Close one idea lane as a dead end — a documented No: the reason is
   * required, capped at {@link WORKTREE_REASON_MAX_CHARS} characters, and
   * re-validated server-side. A success toasts once and refreshes the tree;
   * the caller refreshes the ledger timeline so the event lands there too.
   * @param ideaId - the idea lane to close.
   * @param reason - the one-line lesson (what this No taught).
   * @returns null on success, the settled failure view otherwise.
   */
  async closeIdea(ideaId: string, reason: string): Promise<ResearchFailureView | null> {
    if (reason.trim() === '') return failureOf('invalid-input', 'close reason must not be empty')
    if (reason.length > WORKTREE_REASON_MAX_CHARS) {
      return failureOf('invalid-input', `close reason is capped at ${WORKTREE_REASON_MAX_CHARS} characters`)
    }
    try {
      const carried = await this.remote.closeIdea({ ideaId, reason })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.notify('success', 'worktree.closed')
      this.requeueWorktree()
      // A documented close is a new GUT sample — the baseline refreshes too.
      this.requeueForaging()
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Declare the merge: one idea line adopted (✓). A merge refreshes the
   * worktree; it is NOT a GUT departure, so the foraging baseline stays
   * put (giving-up time is measured on documented closes only).
   */
  async adoptIdea(ideaId: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.adoptIdea({ ideaId })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.notify('success', 'worktree.adopted')
      this.requeueWorktree()
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /** Load the literature list once, on the papers view's first open. */
  ensurePapers(): void {
    if (this.view.papers.status === 'ready' || this.papersPromise !== null) return
    this.papersPromise = this.loadPapers().finally(() => { this.papersPromise = null })
  }

  /**
   * Re-fetch the literature list without flipping the view to loading (the
   * papers view's poll after handing a scoring request to the agent).
   */
  refreshPapers(): void {
    void this.loadPapers(true)
  }

  /**
   * Load the arXiv subscription list once, on the papers view's first open;
   * once the list settles, a stale subscription (never checked, or checked
   * over the auto-check gap ago) triggers one open-time check — the host's
   * scheduled daily check is the steady-state path, this only freshens.
   */
  ensureSubscriptions(): void {
    if (this.view.arxivSubscriptions.status === 'ready' || this.subscriptionsPromise !== null) return
    this.subscriptionsPromise = this.loadSubscriptions()
      .then(() => {
        const { list, checking } = this.view.arxivSubscriptions
        if (!checking && anySubscriptionDue(list, Date.now())) void this.checkArxivSubscriptions()
      })
      .finally(() => { this.subscriptionsPromise = null })
  }

  /**
   * Add one arXiv subscription, then refresh the list. The failure view of a
   * rejected save (empty or duplicate query) is returned so the bar surfaces it.
   * @param query - the free-text query.
   * @returns null on success, the settled failure otherwise.
   */
  async saveArxivSubscription(query: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.saveArxivSubscription({ query })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      await this.loadSubscriptions()
      this.notify('success', 'toast.subscriptionSaved', result.value.subscription.query)
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Delete one arXiv subscription, then refresh the list.
   * @param id - the subscription id.
   * @returns null on success, the settled failure otherwise.
   */
  async deleteArxivSubscription(id: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.deleteArxivSubscription({ id })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      await this.loadSubscriptions()
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Check every subscription for new papers (the bar's manual button and the
   * open-triggered refresh). The run republishes the list with each checked
   * subscription's post-check view; per-subscription fetch failures land in
   * `checkErrors`, a whole-call failure returns as the failure view.
   * @returns null on success, the settled failure otherwise.
   */
  async checkArxivSubscriptions(): Promise<ResearchFailureView | null> {
    const current = this.view.arxivSubscriptions
    if (current.checking) return null
    this.publish({
      arxivSubscriptions: Object.freeze({ ...current, checking: true, checkErrors: Object.freeze({}) }),
    })
    try {
      const carried = await this.remote.checkArxivSubscriptions({})
      if (this.disposed) return null
      if (!carried.ok) {
        this.publish({
          arxivSubscriptions: Object.freeze({ ...this.view.arxivSubscriptions, checking: false }),
        })
        return failureOf(carried.error.code, carried.error.message)
      }
      const result = carried.value
      if (!result.ok) {
        this.publish({
          arxivSubscriptions: Object.freeze({ ...this.view.arxivSubscriptions, checking: false }),
        })
        return businessFailure(result.error)
      }
      // Checked subscriptions take their post-check view; unchecked ones (none
      // today — the panel always checks all) carry over.
      const checked = new Map(result.value.checks.map(check => [check.subscription.id, check]))
      const checkErrors: Record<string, string> = {}
      for (const check of result.value.checks) {
        if (check.error !== null) checkErrors[check.subscription.id] = check.error
      }
      const list = this.view.arxivSubscriptions.list
        .map(subscription => checked.get(subscription.id)?.subscription ?? subscription)
      this.publish({
        arxivSubscriptions: Object.freeze({
          ...this.view.arxivSubscriptions,
          status: 'ready',
          list: Object.freeze(list),
          checking: false,
          failure: null,
          checkErrors: Object.freeze(checkErrors),
        }),
      })
      const added = result.value.checks.reduce((sum, check) => sum + check.added.length, 0)
      if (added > 0) this.notify('success', 'toast.subscriptionNewPapers', `× ${added}`)
      return null
    } catch (error) {
      if (!this.disposed) {
        this.publish({
          arxivSubscriptions: Object.freeze({ ...this.view.arxivSubscriptions, checking: false }),
        })
      }
      return transportFailure(error)
    }
  }

  /** Fetch the arXiv subscription list and publish it. */
  private async loadSubscriptions(): Promise<void> {
    const current = this.view.arxivSubscriptions
    this.publish({
      arxivSubscriptions: Object.freeze({ ...current, status: 'loading', failure: null }),
    })
    try {
      const carried = await this.remote.listArxivSubscriptions()
      if (this.disposed) return
      if (!carried.ok) {
        this.publish({
          arxivSubscriptions: Object.freeze({
            ...this.view.arxivSubscriptions,
            status: 'error',
            failure: failureOf(carried.error.code, carried.error.message),
          }),
        })
        return
      }
      const result = carried.value
      if (!result.ok) {
        this.publish({
          arxivSubscriptions: Object.freeze({
            ...this.view.arxivSubscriptions,
            status: 'error',
            failure: businessFailure(result.error),
          }),
        })
        return
      }
      this.publish({
        arxivSubscriptions: Object.freeze({
          ...this.view.arxivSubscriptions,
          status: 'ready',
          list: result.value.subscriptions,
          failure: null,
        }),
      })
    } catch (error) {
      if (this.disposed) return
      this.publish({
        arxivSubscriptions: Object.freeze({
          ...this.view.arxivSubscriptions,
          status: 'error',
          failure: transportFailure(error),
        }),
      })
    }
  }

  /**
   * Load one whitelisted markdown artifact for the artifact viewer. Skips a
   * refetch of an already-ready same project+name unless forced.
   * @param projectId - wiki project id.
   * @param name - a whitelisted artifact name (e.g. `EXPERIMENT_LOG.md`).
   * @param force - bypass the fresh-view skip.
   */
  loadArtifact(projectId: string, name: string, force = false): void {
    const current = this.view.artifact
    if (!force && current !== null && current.projectId === projectId
      && current.name === name && current.status === 'ready') return
    this.artifactGeneration += 1
    const generation = this.artifactGeneration
    this.publish({
      artifact: Object.freeze({ projectId, name, status: 'loading', content: '', mtimeMs: null, failure: null }),
    })
    void (async (): Promise<void> => {
      const publishArtifact = (view: ResearchArtifactView): void => {
        if (this.disposed || generation !== this.artifactGeneration) return
        this.publish({ artifact: Object.freeze(view) })
      }
      try {
        const carried = await this.remote.readArtifact({ projectId, name })
        if (!carried.ok) {
          publishArtifact({
            projectId, name, status: 'error', content: '', mtimeMs: null,
            failure: failureOf(carried.error.code, carried.error.message),
          })
          return
        }
        const result = carried.value
        if (!result.ok) {
          publishArtifact({
            projectId, name, status: 'error', content: '', mtimeMs: null,
            failure: businessFailure(result.error),
          })
          return
        }
        publishArtifact({
          projectId, name, status: 'ready', content: result.value.content,
          mtimeMs: result.value.mtimeMs, failure: null,
        })
      } catch (error) {
        publishArtifact({
          projectId, name, status: 'error', content: '', mtimeMs: null,
          failure: transportFailure(error),
        })
      }
    })()
  }

  /**
   * Scan one project's paper directory for figures. Skips a rescan of an
   * already-ready same project unless forced (the refresh button forces).
   * @param projectId - wiki project id.
   * @param force - bypass the fresh-view skip.
   */
  loadFigures(projectId: string, force = false, quiet = false): void {
    const current = this.view.figures
    if (this.figuresInFlight) {
      // Queue the newest request — forced or not — behind the in-flight one:
      // dropping a plain load here would leave the target project's slice
      // stuck on the previous project (or on nothing at all).
      this.figuresRefreshPending = { projectId, quiet }
      return
    }
    if (!force && current !== null && current.projectId === projectId && current.status === 'ready') return
    this.figuresGeneration += 1
    const generation = this.figuresGeneration
    this.figuresInFlight = true
    if (!quiet || current === null || current.status !== 'ready') {
      this.publish({
        figures: Object.freeze({ projectId, status: 'loading', list: Object.freeze([]), failure: null }),
      })
    }
    void (async (): Promise<void> => {
      const publishFigures = (view: ResearchProjectSlice<readonly FigureEntry[]>): void => {
        if (this.disposed || generation !== this.figuresGeneration) return
        this.publish({ figures: Object.freeze(view) })
      }
      try {
        const carried = await this.remote.listFigures({ projectId, dir: this.dirOf(projectId) })
        if (!carried.ok) {
          publishFigures({ projectId, status: 'error', list: [], failure: failureOf(carried.error.code, carried.error.message) })
          return
        }
        const result = carried.value
        if (!result.ok) {
          publishFigures({ projectId, status: 'error', list: [], failure: businessFailure(result.error) })
          return
        }
        publishFigures({ projectId, status: 'ready', list: result.value.figures, failure: null })
      } catch (error) {
        publishFigures({ projectId, status: 'error', list: [], failure: transportFailure(error) })
      } finally {
        this.figuresInFlight = false
        const pending = this.figuresRefreshPending
        this.figuresRefreshPending = null
        if (pending !== null && !this.disposed) this.loadFigures(pending.projectId, true, pending.quiet)
      }
    })()
  }

  /**
   * Rename one figure file of one project and force a rescan. The host moves
   * the wiki metadata row along and rewrites the paper's `.tex` references;
   * when any reference was rewritten and the editor draft is clean, the paper
   * view re-reads the file (a dirty draft is left alone — its next save takes
   * the conflict path). Failures surface as the returned failure view.
   * @param projectId - wiki project id.
   * @param relPath - figure path relative to the paper directory.
   * @param newName - the new bare file name (same extension).
   * @returns null on success, the settled failure otherwise.
   */
  async renameFigure(projectId: string, relPath: string, newName: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.renameFigure({ projectId, relPath, newName, dir: this.dirOf(projectId) })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.loadFigures(projectId, true)
      // A project switch during the rename makes the re-read stale: it would
      // load the old project's paper over the new one's view.
      if (result.value.references > 0 && this.view.source?.projectId === projectId
        && this.view.source?.saveState === 'clean') this.refreshPaper(projectId)
      this.notify(
        'success',
        'toast.figureRenamed',
        result.value.references > 0 ? `${newName} · ${result.value.references}` : newName,
      )
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Replace one figure's wiki-recorded caption, then quietly rescan so the
   * card repaints without a loading flash. Failures surface as the returned
   * failure view.
   * @param projectId - wiki project id.
   * @param relPath - figure path relative to the paper directory.
   * @param caption - the replacement caption.
   * @returns null on success, the settled failure otherwise.
   */
  async updateFigure(projectId: string, relPath: string, caption: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.updateFigure({ projectId, relPath, caption })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.loadFigures(projectId, true, true)
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Delete one figure of one project and force a rescan. The failure view of
   * a rejected delete is returned so the card can surface it; a successful
   * delete republishes the figures slice.
   * @param projectId - wiki project id.
   * @param relPath - figure path relative to the paper directory.
   * @returns null on success, the settled failure otherwise.
   */
  async deleteFigure(projectId: string, relPath: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.deleteFigure({ projectId, relPath, dir: this.dirOf(projectId) })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.loadFigures(projectId, true)
      this.notify('success', 'toast.deleted')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * List one project's generated meeting decks. Skips a reload of an
   * already-ready same project unless forced (generation and deletion force).
   * @param projectId - wiki project id.
   * @param force - bypass the fresh-view skip.
   */
  loadMeetings(projectId: string, force = false): void {
    const current = this.view.meetings
    if (this.meetingsInFlight) {
      if (force) this.meetingsRefreshProject = projectId
      return
    }
    if (!force && current !== null && current.projectId === projectId && current.status === 'ready') return
    this.meetingsGeneration += 1
    const generation = this.meetingsGeneration
    this.meetingsInFlight = true
    this.publish({
      meetings: Object.freeze({ projectId, status: 'loading', list: Object.freeze([]), failure: null }),
    })
    void (async (): Promise<void> => {
      const publishMeetings = (view: ResearchProjectSlice<readonly MeetingDeckView[]>): void => {
        if (this.disposed || generation !== this.meetingsGeneration) return
        this.publish({ meetings: Object.freeze(view) })
      }
      try {
        const carried = await this.remote.listMeetingDecks({ projectId })
        if (!carried.ok) {
          publishMeetings({ projectId, status: 'error', list: [], failure: failureOf(carried.error.code, carried.error.message) })
          return
        }
        const result = carried.value
        if (!result.ok) {
          publishMeetings({ projectId, status: 'error', list: [], failure: businessFailure(result.error) })
          return
        }
        publishMeetings({ projectId, status: 'ready', list: result.value.decks, failure: null })
      } catch (error) {
        publishMeetings({ projectId, status: 'error', list: [], failure: transportFailure(error) })
      } finally {
        this.meetingsInFlight = false
        const pendingProject = this.meetingsRefreshProject
        this.meetingsRefreshProject = null
        if (pendingProject !== null && !this.disposed) this.loadMeetings(pendingProject, true)
      }
    })()
  }

  /**
   * Generate one project's meeting deck, then force a deck-list reload.
   * Failures surface as the returned failure view; success toasts the slide
   * count.
   * @param projectId - wiki project id.
   * @param request - the deck options (title/presenter/date/selections).
   * @returns null on success, the settled failure otherwise.
   */
  async generateMeetingDeck(
    projectId: string,
    request: {
      title?: string | undefined
      presenter?: string | undefined
      date?: string | undefined
      paperIds?: readonly string[] | undefined
      figureRelPaths?: readonly string[] | undefined
      include?: Partial<MeetingInclude> | undefined
      aiIllustrations?: boolean | undefined
    },
  ): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.generateMeetingDeck({ projectId, ...request })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.loadMeetings(projectId, true)
      this.notify('success', 'meetings.generated', String(result.value.slides))
      if (result.value.illustrations > 0) {
        this.notify('success', 'meetings.illustrations', String(result.value.illustrations))
      }
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Delete one generated deck and force a deck-list reload.
   * @param projectId - wiki project id.
   * @param file - the deck file name within the project's meetings directory.
   * @returns null on success, the settled failure otherwise.
   */
  async deleteMeetingDeck(projectId: string, file: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.deleteMeetingDeck({ projectId, file })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.loadMeetings(projectId, true)
      this.notify('success', 'toast.deleted')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Fetch the image-generation config (the masked panel view) once; a ready
   * slice or an in-flight load is left alone. Saving publishes the fresh view
   * directly, so this stays a cold-start warm-up.
   */
  getImageGenConfig(): void {
    if (this.imageGenInFlight) return
    if (this.view.imageGen.status === 'ready') return
    void this.loadImageGenConfig()
  }

  /** Fetch the masked image-gen config and publish it. */
  private async loadImageGenConfig(): Promise<void> {
    this.imageGenInFlight = true
    this.publish({ imageGen: Object.freeze({ ...this.view.imageGen, status: 'loading', failure: null }) })
    try {
      const carried = await this.remote.getImageGenConfig()
      if (this.disposed) return
      if (!carried.ok) {
        this.publish({ imageGen: Object.freeze({ ...this.view.imageGen, status: 'error', failure: failureOf(carried.error.code, carried.error.message) }) })
        return
      }
      const result = carried.value
      if (!result.ok) {
        this.publish({ imageGen: Object.freeze({ ...this.view.imageGen, status: 'error', failure: businessFailure(result.error) }) })
        return
      }
      this.publish({ imageGen: Object.freeze({ status: 'ready', ...result.value, failure: null }) })
    } catch (error) {
      if (this.disposed) return
      this.publish({ imageGen: Object.freeze({ ...this.view.imageGen, status: 'error', failure: transportFailure(error) }) })
    } finally {
      this.imageGenInFlight = false
    }
  }

  /**
   * Save the image-generation config, then publish the returned fresh masked
   * view. An omitted `apiKey` keeps the stored key; '' clears it.
   * @param input - the editable fields (empty strings are dropped host-side).
   * @returns null on success, the settled failure otherwise.
   */
  async saveImageGenConfig(input: {
    baseUrl?: string | undefined
    apiKey?: string | undefined
    model?: string | undefined
    size?: string | undefined
  }): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.setImageGenConfig(input)
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.publish({ imageGen: Object.freeze({ status: 'ready', ...result.value, failure: null }) })
      this.notify('success', 'meetings.imageGenSaved')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  getSxngConfig(): void {
    if (this.sxngConfigInFlight || this.view.sxngConfig.status === 'ready') return
    void this.loadSxngConfig()
  }

  private async loadSxngConfig(): Promise<void> {
    this.sxngConfigInFlight = true
    this.publish({ sxngConfig: Object.freeze({ ...this.view.sxngConfig, status: 'loading', failure: null }) })
    try {
      const carried = await this.remote.getSxngConfig()
      if (this.disposed) return
      if (!carried.ok) {
        this.publish({ sxngConfig: Object.freeze({ ...this.view.sxngConfig, status: 'error', failure: failureOf(carried.error.code, carried.error.message) }) })
        return
      }
      const result = carried.value
      if (!result.ok) {
        this.publish({ sxngConfig: Object.freeze({ ...this.view.sxngConfig, status: 'error', failure: businessFailure(result.error) }) })
        return
      }
      this.publish({ sxngConfig: Object.freeze({ status: 'ready', ...result.value, failure: null }) })
    } catch (error) {
      if (!this.disposed) this.publish({ sxngConfig: Object.freeze({ ...this.view.sxngConfig, status: 'error', failure: transportFailure(error) }) })
    } finally {
      this.sxngConfigInFlight = false
    }
  }

  async saveSxngConfig(input: {
    baseUrl?: string | undefined
    defaultEngine?: string | undefined
    allowedEngines?: readonly string[] | undefined
    defaultLimit?: number | undefined
    defaultFormat?: 'md' | 'json' | undefined
    useProxy?: boolean | undefined
    proxyUrl?: string | undefined
    timeout?: number | undefined
    ollamaApiKey?: string | undefined
    redundancyThreshold?: number | undefined
    redundancyBigramThreshold?: number | undefined
  }): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.setSxngConfig(input)
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.publish({ sxngConfig: Object.freeze({ status: 'ready', ...result.value, failure: null }) })
      this.notify('success', 'papers.sxngConfigSaved')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Load the venue picker's built-in registry, once and lazily: a ready (or
   * in-flight) registry is left alone.
   */
  ensureVenueTemplates(): void {
    if (this.venueTemplatesInFlight) return
    if (this.view.venueTemplates.status === 'ready') return
    void this.loadVenueTemplates()
  }

  /** Fetch the venue registry and publish it. */
  private async loadVenueTemplates(): Promise<void> {
    this.venueTemplatesInFlight = true
    this.publish({ venueTemplates: Object.freeze({ ...this.view.venueTemplates, status: 'loading', failure: null }) })
    try {
      const carried = await this.remote.listVenueTemplates()
      if (this.disposed) return
      if (!carried.ok) {
        this.publish({ venueTemplates: Object.freeze({ ...this.view.venueTemplates, status: 'error', failure: failureOf(carried.error.code, carried.error.message) }) })
        return
      }
      const result = carried.value
      if (!result.ok) {
        this.publish({ venueTemplates: Object.freeze({ ...this.view.venueTemplates, status: 'error', failure: businessFailure(result.error) }) })
        return
      }
      this.publish({ venueTemplates: Object.freeze({ status: 'ready', list: result.value.templates, failure: null }) })
    } catch (error) {
      if (this.disposed) return
      this.publish({ venueTemplates: Object.freeze({ ...this.view.venueTemplates, status: 'error', failure: transportFailure(error) }) })
    } finally {
      this.venueTemplatesInFlight = false
    }
  }

  /**
   * Apply one venue (built-in `templateId` or uploaded-kit `customName`) to
   * one project and refresh the project list so the header chip updates.
   * @param projectId - wiki project id.
   * @param options - built-in template id, or a custom kit display name.
   * @returns null on success, the settled failure otherwise.
   */
  async applyVenueTemplate(
    projectId: string,
    options: { templateId?: string | undefined; customName?: string | undefined },
  ): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.applyVenueTemplate({
        projectId,
        dir: this.dirOf(projectId),
        ...(options.templateId === undefined ? {} : { templateId: options.templateId }),
        ...(options.customName === undefined ? {} : { customName: options.customName }),
      })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.notify('success', 'toast.venueApplied', result.value.venue.name)
      void this.loadProjects()
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Clear one project's target venue and refresh the project list.
   * @param projectId - wiki project id.
   * @returns null on success, the settled failure otherwise.
   */
  async clearVenueTemplate(projectId: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.clearVenueTemplate({ projectId })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.notify('success', 'toast.venueCleared')
      void this.loadProjects()
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Load the venue catalog once and lazily: a ready catalog is left alone,
   * but a watch list loaded for a DIFFERENT project refetches (the watched
   * flags ride the catalog read).
   * @param projectId - the project whose watch list rides along, or null.
   */
  ensureVenues(projectId: string | null): void {
    if (this.venuesInFlight) {
      // Queue the newest request behind the in-flight one and stale-mark that
      // one's reply: publishing it would flash another project's watch list.
      this.venuesGeneration += 1
      this.venuesPending = { projectId, quiet: false }
      return
    }
    const current = this.view.venues
    if (current.status === 'ready' && current.watchedProjectId === projectId) return
    void this.loadVenueDeadlines(projectId, false)
  }

  /**
   * Re-fetch the catalog read (the view's retry); no loading flash when a
   * previous list is on screen.
   * @param projectId - the project whose watch list rides along, or null.
   */
  refreshVenues(projectId: string | null): void {
    if (this.venuesInFlight) {
      this.venuesGeneration += 1
      this.venuesPending = { projectId, quiet: true }
      return
    }
    void this.loadVenueDeadlines(projectId, true)
  }

  /**
   * Ask the host to fetch the upstream catalog NOW, then reload the view. A
   * failure toasts and keeps the last good snapshot (the host never drops it).
   * @param projectId - the project whose watch list rides the reload, or null.
   */
  async refreshVenueCatalog(projectId: string | null): Promise<void> {
    try {
      const carried = await this.remote.refreshVenueDeadlines()
      if (this.disposed) return
      if (!carried.ok) { this.notify('error', 'toast.venueRefreshFailed'); return }
      const result = carried.value
      if (!result.ok) { this.notify('error', 'toast.venueRefreshFailed'); return }
      this.notify('success', 'toast.venueRefreshed')
      this.refreshVenues(projectId)
    } catch {
      if (!this.disposed) this.notify('error', 'toast.venueRefreshFailed')
    }
  }

  /** Fetch the catalog plus one project's watch list and publish the slice. */
  private async loadVenueDeadlines(projectId: string | null, quiet: boolean): Promise<void> {
    this.venuesGeneration += 1
    const generation = this.venuesGeneration
    this.venuesInFlight = true
    if (!quiet || this.view.venues.status !== 'ready') {
      this.publish({ venues: Object.freeze({ ...this.view.venues, status: 'loading', failure: null }) })
    }
    try {
      const carried = await this.remote.listVenueDeadlines(projectId === null ? {} : { projectId })
      if (this.disposed || generation !== this.venuesGeneration) return
      if (!carried.ok) {
        this.publish({ venues: Object.freeze({ ...this.view.venues, status: 'error', failure: failureOf(carried.error.code, carried.error.message) }) })
        return
      }
      const result = carried.value
      if (!result.ok) {
        this.publish({ venues: Object.freeze({ ...this.view.venues, status: 'error', failure: businessFailure(result.error) }) })
        return
      }
      this.publish({
        venues: Object.freeze({
          status: 'ready',
          list: result.value.venues,
          journals: result.value.journals,
          watched: result.value.watched,
          watchedProjectId: projectId,
          fetchedAt: result.value.fetchedAt,
          failure: null,
        }),
      })
    } catch (error) {
      if (this.disposed || generation !== this.venuesGeneration) return
      this.publish({ venues: Object.freeze({ ...this.view.venues, status: 'error', failure: transportFailure(error) }) })
    } finally {
      this.venuesInFlight = false
      const pending = this.venuesPending
      this.venuesPending = null
      if (pending !== null && !this.disposed) void this.loadVenueDeadlines(pending.projectId, pending.quiet)
    }
  }

  /**
   * Flip one series in the selected project's watch list. Optimistic: the
   * star toggles immediately; a settled failure rolls the flag back and
   * toasts.
   * @param seriesKey - the ccfddl series key (lowercased title).
   */
  async toggleVenueWatch(seriesKey: string): Promise<void> {
    const projectId = this.view.venues.watchedProjectId
    if (projectId === null) return
    const before = this.view.venues.watched
    const watched = before.includes(seriesKey)
    const optimistic = watched
      ? before.filter(key => key !== seriesKey)
      : [...before, seriesKey]
    this.publish({ venues: Object.freeze({ ...this.view.venues, watched: Object.freeze(optimistic) }) })
    try {
      const carried = await this.remote.setVenueWatch({ projectId, series: seriesKey, watched: !watched })
      if (this.disposed) return
      if (!carried.ok || !carried.value.ok) throw new Error('watch rejected')
    } catch {
      if (this.disposed) return
      // Roll back only this flip, by key, against the CURRENT list: a blanket
      // restore of `before` would undo other toggles settled during the
      // flight, and a project switch makes any rollback meaningless.
      if (this.view.venues.watchedProjectId !== projectId) {
        this.notify('error', 'toast.venueWatchFailed')
        return
      }
      const current = this.view.venues.watched
      const rolled = watched
        ? (current.includes(seriesKey) ? current : Object.freeze([...current, seriesKey]))
        : Object.freeze(current.filter(key => key !== seriesKey))
      this.publish({ venues: Object.freeze({ ...this.view.venues, watched: rolled }) })
      this.notify('error', 'toast.venueWatchFailed')
    }
  }

  /**
   * List one project's paper snapshots (the snapshots panel's open and its
   * refresh). Skips a refetch of an already-ready same project unless forced;
   * a list load already in flight is left alone.
   * @param projectId - wiki project id.
   * @param force - bypass the fresh-view skip.
   */
  loadSnapshots(projectId: string, force = false): void {
    if (this.snapshotsInFlight) return
    const current = this.view.snapshots
    if (!force && current !== null && current.projectId === projectId && current.status === 'ready') return
    this.snapshotsGeneration += 1
    const generation = this.snapshotsGeneration
    this.snapshotsInFlight = true
    this.publish({
      snapshots: Object.freeze({ projectId, status: 'loading', list: Object.freeze([]), failure: null }),
    })
    void (async (): Promise<void> => {
      const publishSnapshots = (view: ResearchProjectSlice<readonly PaperSnapshotView[]>): void => {
        if (this.disposed || generation !== this.snapshotsGeneration) return
        this.publish({ snapshots: Object.freeze(view) })
      }
      try {
        const carried = await this.remote.listPaperSnapshots({ projectId })
        if (!carried.ok) {
          publishSnapshots({ projectId, status: 'error', list: [], failure: failureOf(carried.error.code, carried.error.message) })
          return
        }
        const result = carried.value
        if (!result.ok) {
          publishSnapshots({ projectId, status: 'error', list: [], failure: businessFailure(result.error) })
          return
        }
        publishSnapshots({ projectId, status: 'ready', list: result.value.snapshots, failure: null })
      } catch (error) {
        publishSnapshots({ projectId, status: 'error', list: [], failure: transportFailure(error) })
      } finally {
        this.snapshotsInFlight = false
      }
    })()
  }

  /**
   * Fetch one snapshot's files for the panel's diff view. A newer open
   * supersedes an in-flight older read, whose late reply is discarded by
   * generation.
   * @param projectId - wiki project id.
   * @param id - the snapshot id.
   */
  loadSnapshotDetail(projectId: string, id: string): void {
    this.snapshotDetailGeneration += 1
    const generation = this.snapshotDetailGeneration
    this.publish({
      snapshotDetail: Object.freeze({ projectId, id, status: 'loading', files: Object.freeze([]), failure: null }),
    })
    void (async (): Promise<void> => {
      const publishDetail = (view: ResearchSnapshotDetailView): void => {
        if (this.disposed || generation !== this.snapshotDetailGeneration) return
        this.publish({ snapshotDetail: Object.freeze(view) })
      }
      try {
        const carried = await this.remote.getPaperSnapshot({ projectId, id })
        if (!carried.ok) {
          publishDetail({ projectId, id, status: 'error', files: [], failure: failureOf(carried.error.code, carried.error.message) })
          return
        }
        const result = carried.value
        if (!result.ok) {
          publishDetail({ projectId, id, status: 'error', files: [], failure: businessFailure(result.error) })
          return
        }
        publishDetail({ projectId, id, status: 'ready', files: result.value.files, failure: null })
      } catch (error) {
        publishDetail({ projectId, id, status: 'error', files: [], failure: transportFailure(error) })
      }
    })()
  }

  /** Close the snapshots panel's diff view (superseding any in-flight read). */
  closeSnapshotDetail(): void {
    this.snapshotDetailGeneration += 1
    if (this.view.snapshotDetail !== null) this.publish({ snapshotDetail: null })
  }

  /**
   * Revert the paper to one snapshot: the snapshot's files land on disk under
   * the same optimistic concurrency as `savePaperSource` (the base is the
   * current draft's mtime). Both a success and a conflict re-read the outline
   * and the source from the Host, because the file on disk is newer than
   * either view; a success also re-reads the snapshot list.
   * @param projectId - wiki project id.
   * @param id - the snapshot id.
   * @returns null on success, the settled failure otherwise.
   */
  async revertSnapshot(projectId: string, id: string): Promise<ResearchFailureView | null> {
    const source = this.view.source
    if (source === null || source.projectId !== projectId
      || source.status !== 'ready' || source.mtimeMs === null) {
      return failureOf('source-not-ready', 'paper source is not loaded')
    }
    try {
      const carried = await this.remote.revertPaperSnapshot({
        projectId, id, baseMtimeMs: source.mtimeMs, dir: this.dirOf(projectId),
      })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) {
        // A project switch during the revert makes the re-read stale.
        if (result.error.code === 'conflict' && this.view.source?.projectId === projectId) this.refreshPaper(projectId)
        return businessFailure(result.error)
      }
      if (this.view.source?.projectId === projectId) this.refreshPaper(projectId)
      this.snapshotsInFlight = false
      this.loadSnapshots(projectId, true)
      this.notify('success', 'toast.snapshotReverted')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Insert one figure's standard LaTeX block into the selected project's
   * `main.tex` (the figures view's "insert into paper" button). The figure
   * file already lives in the paper directory — the figures view lists exactly
   * those files — so the insert only edits the source: the block lands right
   * before `\end{document}` and rides the normal draft/autosave path, so an
   * unsaved draft survives and the optimistic-concurrency save still guards
   * the write. A figure the draft already references is never inserted twice:
   * the existing `\includegraphics` line becomes the jump target instead. An
   * SVG figure is converted on the host first (`convertFigure` — vector PDF
   * preferred, raster PNG as the fallback) and the block references the
   * product; a machine with no usable converter keeps the failure toast with
   * the reason attached. Either way the paper view jumps to the block.
   * @param projectId - wiki project id.
   * @param entry - the figure card's entry.
   * @returns the 1-based target line for the paper view to jump to, or null
   * when the insert failed (a toast already carries the reason).
   */
  async insertFigureIntoPaper(projectId: string, entry: FigureEntry): Promise<number | null> {
    const source = await this.ensureSourceReady(projectId)
    if (source === null || this.disposed) return null
    if (source.saveState === 'conflict') {
      this.notify('error', 'toast.figureInsertConflict')
      return null
    }
    // The duplicate guard covers the SVG's converted products too: an
    // already-inserted `foo.pdf` reads as "foo.svg is already inserted".
    for (const candidate of [entry.relPath, ...svgConvertedRelPaths(entry.relPath)]) {
      const existing = findFigureReferenceLine(source.content, candidate)
      if (existing !== null) {
        this.jumpPaper(projectId, existing)
        this.notify('info', 'toast.figureAlreadyInserted', entry.name)
        return existing
      }
    }
    let relPath = entry.relPath
    let convertedName: string | null = null
    if (isSvgFigure(entry.name)) {
      try {
        const carried = await this.remote.convertFigure({ projectId, relPath: entry.relPath, dir: this.dirOf(projectId) })
        if (!carried.ok) {
          this.notify('error', 'toast.figureSvgConvertFailed', carried.error.message)
          return null
        }
        const result = carried.value
        if (!result.ok) {
          this.notify('error', 'toast.figureSvgConvertFailed', businessFailure(result.error).message)
          return null
        }
        relPath = result.value.relPath
        convertedName = `${entry.name} → ${relPath.split('/').pop() ?? relPath}`
      } catch (error) {
        this.notify('error', 'toast.figureSvgConvertFailed', transportFailure(error).message)
        return null
      }
    }
    // The conversion round-trip is long relative to the draft. Re-anchor on the
    // CURRENT view rather than the pre-conversion `source` snapshot: a user who
    // kept typing while the host converted must keep that text — splicing the
    // block into the stale snapshot would overwrite their continued draft. A
    // project switch or dispose mid-flight still writes nothing, and a draft
    // that went into conflict (the agent landed a version mid-conversion) is
    // reported instead of silently skipping the insert.
    const live = this.view.source
    if (this.disposed || live === null || live.projectId !== projectId || live.status !== 'ready') return null
    if (live.saveState === 'conflict') {
      this.notify('error', 'toast.figureInsertConflict')
      return null
    }
    const block = figureBlockOf(relPath, entry.caption ?? '')
    const inserted = insertFigureBlock(live.content, block)
    this.edit(inserted.content)
    this.jumpPaper(projectId, inserted.line)
    this.notify('success', convertedName === null ? 'toast.figureInserted' : 'toast.figureConvertedSvg', convertedName ?? entry.name)
    if (convertedName !== null) {
      // A conversion wrote a new product file into the paper directory; the
      // figures view's cached scan does not know about it yet.
      this.loadFigures(projectId, true)
    }
    return inserted.line
  }

  /**
   * Generate one metric's comparison chart as a paper figure (the experiments
   * view's per-chart button): render the rows as a standalone SVG document,
   * save it through the host (`saveFigure` — writes `figures/metric-<key>.svg`,
   * registers the caption in the wiki's figures table, and runs the SVG
   * conversion pipeline), then insert the figure block exactly like the
   * figures view's insert button (the SVG branch of `insertFigureIntoPaper`
   * reuses the just-converted product, references it, jumps, and toasts). A
   * rejected save toasts the reason and touches nothing.
   * @param projectId - wiki project id.
   * @param metricKey - the metric the chart compares.
   * @param rows - the chart's rows (runs carrying a finite value, oldest first).
   * @returns the 1-based target line for the paper view to jump to, or null
   * when the save or insert failed (a toast already carries the reason).
   */
  async generateMetricFigure(projectId: string, metricKey: string, rows: readonly MetricChartRow[]): Promise<number | null> {
    if (rows.length === 0) return null
    const name = metricFigureFileName(metricKey)
    const caption = metricFigureCaption(metricKey, rows)
    const content = metricFigureSvg(metricKey, rows)
    let saved: { relPath: string; caption: string }
    try {
      const carried = await this.remote.saveFigure({ projectId, name, content, caption, dir: this.dirOf(projectId) })
      if (!carried.ok) {
        this.notify('error', 'toast.metricFigureFailed', carried.error.message)
        return null
      }
      const result = carried.value
      if (!result.ok) {
        this.notify('error', 'toast.metricFigureFailed', businessFailure(result.error).message)
        return null
      }
      saved = result.value
    } catch (error) {
      this.notify('error', 'toast.metricFigureFailed', transportFailure(error).message)
      return null
    }
    if (this.disposed) return null
    // The figures view's cached scan does not know the new file yet.
    this.figuresInFlight = false
    this.loadFigures(projectId, true)
    return this.insertFigureIntoPaper(projectId, {
      name: saved.relPath.split('/').pop() ?? name,
      relPath: saved.relPath,
      sizeBytes: content.length,
      mtimeMs: Date.now(),
      caption: saved.caption,
    })
  }

  /** Clear the consumed paper-editor jump ticket (the paper view's callback). */
  consumePaperJump(): void {
    if (this.view.paperJump !== null) this.publish({ paperJump: null })
  }

  /** Publish the paper view's next jump target. */
  private jumpPaper(projectId: string, line: number): void {
    this.paperJumpSeq += 1
    this.publish({ paperJump: Object.freeze({ projectId, line, seq: this.paperJumpSeq }) })
  }

  /**
   * Guarantee a ready source draft for one project, loading it from the Host
   * when the current slice is absent, stale, or another project's. A failed
   * load publishes the error slice, toasts the insert failure, and reads as
   * null.
   * @param projectId - wiki project id.
   * @returns the ready source view, or null.
   */
  private async ensureSourceReady(projectId: string): Promise<ResearchSourceView | null> {
    const current = this.view.source
    if (current !== null && current.projectId === projectId && current.status === 'ready') return current
    this.sourceGeneration += 1
    const generation = this.sourceGeneration
    this.publish({
      source: Object.freeze({ projectId, status: 'loading', content: '', mtimeMs: null, saveState: 'clean', failure: null }),
    })
    const fail = (failure: ResearchFailureView): null => {
      if (this.disposed || generation !== this.sourceGeneration) return null
      this.publish({
        source: Object.freeze({ projectId, status: 'error', content: '', mtimeMs: null, saveState: 'clean', failure }),
      })
      this.notify('error', 'toast.figureInsertFailed', failure.message)
      return null
    }
    try {
      const carried = await this.remote.getPaperSource({ projectId, dir: this.dirOf(projectId) })
      if (this.disposed || generation !== this.sourceGeneration) return null
      if (!carried.ok) return fail(failureOf(carried.error.code, carried.error.message))
      const result = carried.value
      if (!result.ok) return fail(businessFailure(result.error))
      const view: ResearchSourceView = Object.freeze({
        projectId, status: 'ready', content: result.value.content,
        mtimeMs: result.value.mtimeMs, saveState: 'clean', failure: null,
      })
      this.publish({ source: view })
      return view
    } catch (error) {
      return fail(transportFailure(error))
    }
  }


  /**
   * Reorder the top-level sections of one project's `main.tex`. The failure
   * view of a rejected reorder is returned so the outline rail can surface it;
   * both a success and a conflict re-read the outline and the source from the
   * Host, because the file on disk is newer than either view.
   * @param projectId - wiki project id.
   * @param moves - the drops, applied in order.
   * @param baseOutline - the top-level titles the drag started from.
   * @returns null on success, the settled failure otherwise.
   */
  async reorderPaperSections(
    projectId: string,
    moves: readonly SectionMove[],
    baseOutline: readonly string[],
  ): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.reorderPaperSections({
        projectId, moves: [...moves], baseOutline: [...baseOutline], dir: this.dirOf(projectId),
      })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) {
        // A project switch during the reorder makes the re-read stale.
        if (result.error.code === 'conflict' && this.view.source?.projectId === projectId) this.refreshPaper(projectId)
        return businessFailure(result.error)
      }
      if (this.view.source?.projectId === projectId) this.refreshPaper(projectId)
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Reorder the subsections of one project's `main.tex`, inside their own
   * section or across sections. Same settlement contract as
   * {@link ResearchController.reorderPaperSections}: the failure view is
   * returned for the rail, and both a success and a conflict re-read the
   * outline and the source from the Host.
   * @param projectId - wiki project id.
   * @param moves - the drops, applied in order.
   * @param baseOutline - the section/subsection title tree the drag started from.
   * @returns null on success, the settled failure otherwise.
   */
  async reorderPaperSubsections(
    projectId: string,
    moves: readonly SubsectionMove[],
    baseOutline: readonly SectionOutlineTitles[],
  ): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.reorderPaperSubsections({
        projectId,
        moves: [...moves],
        baseOutline: baseOutline.map(section => ({ title: section.title, subsections: [...section.subsections] })),
        dir: this.dirOf(projectId),
      })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) {
        // A project switch during the reorder makes the re-read stale.
        if (result.error.code === 'conflict' && this.view.source?.projectId === projectId) this.refreshPaper(projectId)
        return businessFailure(result.error)
      }
      if (this.view.source?.projectId === projectId) this.refreshPaper(projectId)
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Search arXiv for one query and publish the outcome to the papers view.
   * A newer search supersedes an in-flight one, whose late reply is discarded
   * by generation; an empty query never leaves the client.
   * @param query - the free-text query.
   */
  searchArxiv(query: string): void {
    const trimmed = query.trim()
    if (trimmed === '') return
    this.arxivGeneration += 1
    const generation = this.arxivGeneration
    this.publish({
      arxivSearch: Object.freeze({ query: trimmed, status: 'loading', list: Object.freeze([]), failure: null }),
    })
    void (async (): Promise<void> => {
      const publishSearch = (view: ResearchArxivSearchView): void => {
        if (this.disposed || generation !== this.arxivGeneration) return
        this.publish({ arxivSearch: Object.freeze(view) })
      }
      try {
        const carried = await this.remote.searchArxiv({ query: trimmed })
        if (!carried.ok) {
          publishSearch({ query: trimmed, status: 'error', list: [], failure: failureOf(carried.error.code, carried.error.message) })
          return
        }
        const result = carried.value
        if (!result.ok) {
          publishSearch({ query: trimmed, status: 'error', list: [], failure: businessFailure(result.error) })
          return
        }
        publishSearch({ query: trimmed, status: 'ready', list: result.value.results, failure: null })
      } catch (error) {
        publishSearch({ query: trimmed, status: 'error', list: [], failure: transportFailure(error) })
      }
    })()
  }

  /**
   * Search the web (SearXNG through the sxng CLI) for one query and publish
   * the outcome to the papers view. Mirrors {@link searchArxiv}'s supersede
   * semantics: a newer search discards an in-flight one's late reply, and an
   * empty query never leaves the client.
   * @param query - the free-text query.
   */
  searchWeb(query: string): void {
    const trimmed = query.trim()
    if (trimmed === '') return
    this.webGeneration += 1
    const generation = this.webGeneration
    this.publish({
      webSearch: Object.freeze({ query: trimmed, status: 'loading', list: Object.freeze([]), failure: null }),
    })
    void (async (): Promise<void> => {
      const publishSearch = (view: ResearchWebSearchView): void => {
        if (this.disposed || generation !== this.webGeneration) return
        this.publish({ webSearch: Object.freeze(view) })
      }
      try {
        const carried = await this.remote.searchWeb({ query: trimmed })
        if (!carried.ok) {
          publishSearch({ query: trimmed, status: 'error', list: [], failure: failureOf(carried.error.code, carried.error.message) })
          return
        }
        const result = carried.value
        if (!result.ok) {
          publishSearch({ query: trimmed, status: 'error', list: [], failure: businessFailure(result.error) })
          return
        }
        publishSearch({ query: trimmed, status: 'ready', list: result.value.results, failure: null })
      } catch (error) {
        publishSearch({ query: trimmed, status: 'error', list: [], failure: transportFailure(error) })
      }
    })()
  }

  /**
   * Import one arXiv entry into the wiki, then refresh the literature list so
   * both the library grid and the result card's imported state repaint. The
   * selected project rides along as the paper's initial project link, so each
   * project's literature view fills up on its own. The failure view of a
   * rejected import is returned so the card can surface it.
   * @param entry - the parsed arXiv entry.
   * @param projectId - the selected project to link, when any.
   * @returns null on success, the settled failure otherwise.
   */
  async importPaper(entry: ArxivEntry, projectId?: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.importPaper(projectId === undefined ? { entry } : { entry, projectId })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      await this.loadPapers()
      this.notify('success', 'toast.paperImported')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Import one existing local LaTeX project into the workspace (the sidebar's
   * "import existing project" dialog): the host copies the tree into
   * `imported/<slug>/` and registers the project. On success the project list
   * refreshes BEFORE the summary resolves, so the caller can select the new
   * project against an up-to-date list.
   * @param path - absolute or `~`-prefixed source directory.
   * @param title - the optional explicit title.
   * @returns the import summary on success, the settled failure otherwise.
   */
  async importProject(path: string, title?: string): Promise<ResearchImportedProject | ResearchFailureView> {
    try {
      const carried = await this.remote.importProject(title === undefined ? { path } : { path, title })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      await this.loadProjects()
      this.notify('success', 'toast.projectImported', result.value.title)
      return result.value
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Remove one remembered paper, then refresh the literature list so the
   * library grid and any matching search result repaint.
   * @param arxivId - the bare arXiv id.
   * @returns null on success, the settled failure otherwise.
   */
  async removePaper(arxivId: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.removePaper({ arxivId })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      await this.loadPapers()
      this.notify('success', 'toast.deleted')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Partially update one paper's organization fields (tags, project links,
   * notes), then refresh the literature list so the grid, the filter bar,
   * and any matching search result repaint.
   * @param arxivId - the bare arXiv id.
   * @param patch - the fields to replace; omitted fields stay untouched.
   * @returns null on success, the settled failure otherwise.
   */
  async updatePaper(
    arxivId: string,
    patch: { tags?: string[]; projectIds?: string[]; notes?: string },
  ): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.updatePaper({ arxivId, ...patch })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      await this.loadPapers()
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Download one remembered paper's arXiv PDF into the workspace, then refresh
   * the literature list so the card's read/fetch buttons repaint. The failure
   * view of a rejected fetch is returned so the card can surface it.
   * @param arxivId - the bare arXiv id.
   * @returns null on success, the settled failure otherwise.
   */
  async fetchPaperPdf(arxivId: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.fetchPaperPdf({ arxivId })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      await this.loadPapers()
      this.notify('success', 'toast.pdfFetched')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Probe the Zotero connection once, on the papers view's first open; a
   * successful probe also loads the collection list. A failed or unconfigured
   * probe stays retryable through {@link recheckZotero}.
   */
  ensureZotero(): void {
    if (this.view.zotero.status === 'ready' || this.zoteroPromise !== null) return
    this.zoteroPromise = this.loadZotero().finally(() => { this.zoteroPromise = null })
  }

  /** Re-probe the Zotero connection (the section's retry entry). */
  recheckZotero(): void {
    this.zoteroPromise ??= this.loadZotero().finally(() => { this.zoteroPromise = null })
  }

  /** Run the connection probe; on `ok` follow it with the collection list. */
  private async loadZotero(): Promise<void> {
    const publishZotero = (view: ResearchZoteroView): void => {
      if (this.disposed) return
      this.publish({ zotero: Object.freeze(view) })
    }
    publishZotero({ status: 'loading', state: null, message: null, collections: [], failure: null })
    try {
      const carried = await this.remote.checkZotero()
      if (!carried.ok) {
        publishZotero({
          status: 'error', state: null, message: null, collections: [],
          failure: failureOf(carried.error.code, carried.error.message),
        })
        return
      }
      const probe = carried.value
      if (!probe.ok) {
        publishZotero({
          status: 'error', state: null, message: null, collections: [],
          failure: businessFailure(probe.error),
        })
        return
      }
      const status = probe.value
      if (status.state !== 'ok') {
        publishZotero({
          status: 'ready', state: status.state, message: status.message ?? null,
          collections: [], failure: null,
        })
        return
      }
      const listed = await this.remote.listZoteroCollections()
      if (!listed.ok) {
        publishZotero({
          status: 'error', state: null, message: null, collections: [],
          failure: failureOf(listed.error.code, listed.error.message),
        })
        return
      }
      if (!listed.value.ok) {
        publishZotero({
          status: 'error', state: null, message: null, collections: [],
          failure: businessFailure(listed.value.error),
        })
        return
      }
      publishZotero({ status: 'ready', state: 'ok', message: null, collections: listed.value.value.collections, failure: null })
    } catch (error) {
      publishZotero({ status: 'error', state: null, message: null, collections: [], failure: transportFailure(error) })
    }
  }

  /**
   * Search the configured Zotero library from the papers view; the outcome
   * lands in the view's `zoteroSearch` slice. A superseded query never
   * publishes.
   * @param query - the free-text query; an empty one never leaves the client.
   */
  searchZotero(query: string): void {
    const trimmed = query.trim()
    if (trimmed === '') return
    this.zoteroGeneration += 1
    const generation = this.zoteroGeneration
    this.publish({
      zoteroSearch: Object.freeze({ query: trimmed, status: 'loading', list: Object.freeze([]), failure: null }),
    })
    void (async (): Promise<void> => {
      const publishSearch = (view: ResearchZoteroSearchView): void => {
        if (this.disposed || generation !== this.zoteroGeneration) return
        this.publish({ zoteroSearch: Object.freeze(view) })
      }
      try {
        const carried = await this.remote.searchZotero({ query: trimmed })
        if (!carried.ok) {
          publishSearch({ query: trimmed, status: 'error', list: [], failure: failureOf(carried.error.code, carried.error.message) })
          return
        }
        const result = carried.value
        if (!result.ok) {
          publishSearch({ query: trimmed, status: 'error', list: [], failure: businessFailure(result.error) })
          return
        }
        publishSearch({ query: trimmed, status: 'ready', list: result.value.results, failure: null })
      } catch (error) {
        publishSearch({ query: trimmed, status: 'error', list: [], failure: transportFailure(error) })
      }
    })()
  }

  /**
   * Import one Zotero item into the wiki, then refresh the literature list so
   * the library grid and the item's imported state repaint. The selected
   * project rides along as the paper's initial project link, matching the
   * arXiv import. The failure view of a rejected import is returned so the
   * row can surface it.
   * @param key - the Zotero item key.
   * @param projectId - the selected project to link, when any.
   * @returns null on success, the settled failure otherwise.
   */
  async importZoteroItem(key: string, projectId?: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.importZoteroItem(projectId === undefined ? { key } : { key, projectId })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      await this.loadPapers()
      this.notify('success', 'toast.paperImported')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Export one Zotero collection into one project's `references.bib`, then
   * repaint the open bib panel from the Host's authoritative file. The
   * settled counts are returned so the invoking button shows its own feedback.
   * @param projectId - wiki project id.
   * @param collectionKey - the Zotero collection to export.
   * @returns the settled counts on success, the failure view otherwise.
   */
  async exportZoteroCollectionToBib(
    projectId: string,
    collectionKey: string,
  ): Promise<ResearchFailureView | ResearchImportCounts> {
    try {
      const carried = await this.remote.exportZoteroCollectionToBib({
        projectId, collectionKey, dir: this.dirOf(projectId),
      })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      const counts = Object.freeze({ added: result.value.added, skipped: result.value.skipped })
      if (this.disposed) return counts
      this.notify('success', 'toast.bibImported', `× ${counts.added}`)
      const bib = this.view.bib
      if (bib !== null && bib.projectId === projectId && bib.status !== 'loading') {
        this.publish({ bib: Object.freeze({ ...bib, lastImport: counts }) })
        this.reloadBibliography()
      }
      return counts
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Load one project's `references.bib` on the bib panel's first open. A
   * ready (or in-flight) view of the same project is kept; a project switch
   * or an error view reloads.
   * @param projectId - wiki project id.
   */
  ensureBibliography(projectId: string): void {
    const current = this.view.bib
    if (current !== null && current.projectId === projectId
      && (current.status === 'ready' || current.status === 'loading')) return
    this.bibGeneration += 1
    const generation = this.bibGeneration
    const lastImport = current !== null && current.projectId === projectId ? current.lastImport : null
    this.publish({
      bib: Object.freeze({
        projectId, status: 'loading', entries: Object.freeze([]), mtimeMs: null,
        saveState: 'clean', failure: null, lastImport,
      }),
    })
    void this.loadBibliography(projectId, generation)
  }

  /** Re-read the open bibliography from the Host (the conflict recovery path). */
  reloadBibliography(): void {
    const current = this.view.bib
    if (current === null) return
    this.bibGeneration += 1
    const generation = this.bibGeneration
    this.publish({
      bib: Object.freeze({ ...current, status: 'loading', saveState: 'clean', failure: null }),
    })
    void this.loadBibliography(current.projectId, generation)
  }

  /**
   * Delete one entry from the open bibliography and commit the file under
   * optimistic concurrency. The failure view of a rejected save is returned
   * so the row can surface it; a conflict freezes the panel until reloaded.
   * @param key - the citation key to drop.
   * @returns null on success, the settled failure otherwise.
   */
  async deleteBibEntry(key: string): Promise<ResearchFailureView | null> {
    const bib = this.view.bib
    if (bib === null || bib.status !== 'ready' || bib.saveState === 'saving') {
      return failureOf('bib-not-ready', 'bibliography is not loaded')
    }
    return this.commitBibEntries(bib.entries.filter(entry => entry.key !== key), 'toast.deleted')
  }

  /**
   * Replace one entry of the open bibliography (the field editor's save) and
   * commit the file under the same optimistic concurrency as the delete. The
   * edited entry keeps its list position; a rename to another entry's key is
   * rejected client-side (`invalid-input`), as are an empty key or type and
   * an edit addressed to a key no longer listed. The failure view is returned
   * so the editor stays open with the rejection surfaced.
   * @param originalKey - the citation key the editor opened on.
   * @param entry - the edited entry (its key may differ from `originalKey`).
   * @returns null on success, the settled failure otherwise.
   */
  async updateBibEntry(originalKey: string, entry: BibEntry): Promise<ResearchFailureView | null> {
    const bib = this.view.bib
    if (bib === null || bib.status !== 'ready' || bib.saveState === 'saving') {
      return failureOf('bib-not-ready', 'bibliography is not loaded')
    }
    if (entry.key === '' || entry.type === '') {
      return failureOf('invalid-input', 'citation key and entry type must be non-empty')
    }
    if (!bib.entries.some(existing => existing.key === originalKey)) {
      return failureOf('invalid-input', `entry not found: ${originalKey}`)
    }
    if (bib.entries.some(existing => existing.key !== originalKey && existing.key === entry.key)) {
      return failureOf('invalid-input', `citation key already exists: ${entry.key}`)
    }
    return this.commitBibEntries(
      bib.entries.map(existing => (existing.key === originalKey ? entry : existing)),
      'toast.bibSaved',
    )
  }

  /**
   * Commit one next entry list of the open bibliography through
   * `saveBibliography`'s optimistic concurrency: publish `saving`, land the
   * new mtime and entries on success, freeze the panel on a conflict. Shared
   * by the entry delete and the field editor's save.
   * @param entries - the complete next entry list.
   * @param toast - the success toast's copy key.
   * @returns null on success, the settled failure otherwise.
   */
  private async commitBibEntries(
    entries: readonly BibEntry[],
    toast: 'toast.deleted' | 'toast.bibSaved',
  ): Promise<ResearchFailureView | null> {
    const bib = this.view.bib
    if (bib === null || bib.status !== 'ready') {
      return failureOf('bib-not-ready', 'bibliography is not loaded')
    }
    const generation = this.bibGeneration
    this.publish({ bib: Object.freeze({ ...bib, saveState: 'saving', failure: null }) })
    try {
      const carried = await this.remote.saveBibliography({
        projectId: bib.projectId, entries: [...entries], baseMtimeMs: bib.mtimeMs, dir: this.dirOf(bib.projectId),
      })
      if (this.disposed || generation !== this.bibGeneration) return null
      const current = this.view.bib
      if (current === null || current.projectId !== bib.projectId || current.status !== 'ready') return null
      if (!carried.ok) {
        const failure = failureOf(carried.error.code, carried.error.message)
        this.publish({ bib: Object.freeze({ ...current, saveState: 'save-error', failure }) })
        return failure
      }
      const result = carried.value
      if (!result.ok) {
        const failure = businessFailure(result.error)
        this.publish({
          bib: Object.freeze({
            ...current,
            saveState: result.error.code === 'conflict' ? 'conflict' : 'save-error',
            failure: result.error.code === 'conflict' ? null : failure,
          }),
        })
        return failure
      }
      this.publish({
        bib: Object.freeze({
          ...current, entries: Object.freeze(entries), mtimeMs: result.value.mtimeMs,
          saveState: 'saved', failure: null,
        }),
      })
      this.notify('success', toast)
      return null
    } catch (error) {
      const failure = transportFailure(error)
      if (!this.disposed && generation === this.bibGeneration) {
        const current = this.view.bib
        if (current !== null && current.projectId === bib.projectId) {
          this.publish({ bib: Object.freeze({ ...current, saveState: 'save-error', failure }) })
        }
      }
      return failure
    }
  }

  /**
   * Append library papers to one project's `references.bib`, then repaint the
   * open bib panel from the Host's authoritative file. The settled counts are
   * returned so the invoking button shows its own feedback.
   * @param projectId - wiki project id.
   * @param arxivIds - the papers to append.
   * @returns the settled counts on success, the failure view otherwise.
   */
  async importPapersToBib(
    projectId: string,
    arxivIds: string[],
  ): Promise<ResearchFailureView | ResearchImportCounts> {
    try {
      const carried = await this.remote.importPapersToBib({ projectId, arxivIds, dir: this.dirOf(projectId) })
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      const counts = Object.freeze({ added: result.value.added, skipped: result.value.skipped })
      if (this.disposed) return counts
      this.notify('success', 'toast.bibImported', `× ${counts.added}`)
      const bib = this.view.bib
      if (bib !== null && bib.projectId === projectId && bib.status !== 'loading') {
        this.publish({ bib: Object.freeze({ ...bib, lastImport: counts }) })
        this.reloadBibliography()
      }
      return counts
    } catch (error) {
      return transportFailure(error)
    }
  }

  /** Fetch one project's `references.bib`; a superseded generation never publishes. */
  private async loadBibliography(projectId: string, generation: number): Promise<void> {
    const publishBib = (view: ResearchBibView): void => {
      if (this.disposed || generation !== this.bibGeneration) return
      this.publish({ bib: Object.freeze(view) })
    }
    const lastImport = this.view.bib !== null && this.view.bib.projectId === projectId
      ? this.view.bib.lastImport
      : null
    try {
      const carried = await this.remote.getBibliography({ projectId, dir: this.dirOf(projectId) })
      if (!carried.ok) {
        publishBib({
          projectId, status: 'error', entries: [], mtimeMs: null,
          saveState: 'clean', failure: failureOf(carried.error.code, carried.error.message), lastImport,
        })
        return
      }
      const result = carried.value
      if (!result.ok) {
        publishBib({
          projectId, status: 'error', entries: [], mtimeMs: null,
          saveState: 'clean', failure: businessFailure(result.error), lastImport,
        })
        return
      }
      publishBib({
        projectId, status: 'ready', entries: result.value.entries,
        mtimeMs: result.value.mtimeMs, saveState: 'clean', failure: null, lastImport,
      })
    } catch (error) {
      publishBib({
        projectId, status: 'error', entries: [], mtimeMs: null,
        saveState: 'clean', failure: transportFailure(error), lastImport,
      })
    }
  }

  /**
   * Delete one experiment record and drop it from the loaded slice (the Host
   * already removed its record, so a local filter repaints without a refetch).
   * The failure view of a rejected delete is returned so the row surfaces it.
   * @param id - experiment record id.
   * @returns null on success, the settled failure otherwise.
   */
  async deleteExperiment(id: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.deleteExperiment({ id })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      const current = this.view.experiments
      if (current !== null) {
        this.publish({
          experiments: Object.freeze({
            ...current,
            list: Object.freeze(current.list.filter(record => record.id !== id)),
          }),
        })
      }
      this.notify('success', 'toast.deleted')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Relink one experiment to a server (null clears the link) and patch the
   * loaded experiments slice with the returned record. The failure view of a
   * rejected update is returned so the view can surface it.
   * @param id - experiment record id.
   * @param serverId - the server to link, or null to clear.
   * @returns null on success, the settled failure otherwise.
   */
  async updateExperiment(id: string, serverId: string | null): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.updateExperiment({ id, serverId })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      const current = this.view.experiments
      if (current !== null) {
        this.publish({
          experiments: Object.freeze({
            ...current,
            list: Object.freeze(current.list.map(record =>
              record.id === id ? result.value.experiment : record)),
          }),
        })
      }
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Create or update one experiment (the inline form's save), patch the
   * loaded experiments slice with the returned record (replace when the id
   * was already listed, append otherwise), and toast the success. The
   * failure view of a rejected save is returned so the form surfaces it.
   * @param experiment - the full-field upsert payload; `id` present updates.
   * @returns null on success, the settled failure otherwise.
   */
  async saveExperiment(experiment: ExperimentInput): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.saveExperiment({ experiment })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      const saved = result.value.experiment
      const current = this.view.experiments
      if (current !== null) {
        const listed = current.list.some(record => record.id === saved.id)
        this.publish({
          experiments: Object.freeze({
            ...current,
            list: Object.freeze(listed
              ? current.list.map(record => record.id === saved.id ? saved : record)
              : [...current.list, saved]),
          }),
        })
      }
      this.notify('success', 'toast.experimentSaved')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /** Load the server list once, on the servers view's first open. */
  ensureServers(): void {
    if (this.view.servers.status === 'ready' || this.serversPromise !== null) return
    this.serversPromise = this.loadServers().finally(() => { this.serversPromise = null })
  }

  /**
   * Create or update one server, then refresh the list.
   * @param server - the upsert payload; `id` present updates, absent creates.
   * @returns null on success, the settled failure otherwise.
   */
  async saveServer(server: ServerInput): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.saveServer({ server })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      await this.loadServers()
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Delete one server, drop its probe state, and refresh the list.
   * @param id - server record id.
   * @returns null on success, the settled failure otherwise.
   */
  async deleteServer(id: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.deleteServer({ id })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      const checks = { ...this.view.serverChecks }
      delete checks[id]
      this.publish({ serverChecks: Object.freeze(checks) })
      await this.loadServers()
      this.notify('success', 'toast.deleted')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Probe one server: publish `checking`, then the settled view. A probe
   * already in flight for the same server is left alone.
   * @param id - server record id.
   */
  async checkServer(id: string): Promise<void> {
    if (this.view.serverChecks[id] === 'checking') return
    this.publish({ serverChecks: Object.freeze({ ...this.view.serverChecks, [id]: 'checking' }) })
    const settled = await this.runServerCheck(id)
    if (this.disposed) return
    // A delete during the probe already dropped this id's slot.
    if (!(id in this.view.serverChecks)) return
    this.publish({ serverChecks: Object.freeze({ ...this.view.serverChecks, [id]: settled }) })
  }

  /**
   * Probe every listed server that is not already being probed, then toast
   * when the batch settles (a user-initiated, potentially slow operation).
   */
  async checkAllServers(): Promise<void> {
    const pending = this.view.servers.list
      .filter(server => this.view.serverChecks[server.id] !== 'checking')
      .map(server => this.checkServer(server.id))
    if (pending.length === 0) return
    await Promise.all(pending)
    this.notify('info', 'toast.serversChecked', `× ${pending.length}`)
  }

  /** Run one probe, translating every failure mode into a settled offline view. */
  private async runServerCheck(id: string): Promise<ServerStatusView> {
    const offline = (message: string): ServerStatusView => Object.freeze({
      state: 'offline', latencyMs: null, gpus: Object.freeze([]),
      checkedAt: new Date().toISOString(), message,
    })
    try {
      const carried = await this.remote.checkServer({ id })
      if (!carried.ok) return offline(carried.error.message)
      const result = carried.value
      if (!result.ok) return offline(businessFailure(result.error).message)
      return result.value
    } catch (error) {
      return offline(error instanceof Error ? error.message : 'server probe failed')
    }
  }

  /** Fetch the server list and publish it. */
  private async loadServers(): Promise<void> {
    this.publish({ servers: Object.freeze({ ...this.view.servers, status: 'loading', failure: null }) })
    try {
      const carried = await this.remote.listServers()
      if (this.disposed) return
      if (!carried.ok) {
        this.publish({
          servers: Object.freeze({ ...this.view.servers, status: 'error', failure: failureOf(carried.error.code, carried.error.message) }),
        })
        return
      }
      const result = carried.value
      if (!result.ok) {
        this.publish({
          servers: Object.freeze({ ...this.view.servers, status: 'error', failure: businessFailure(result.error) }),
        })
        return
      }
      this.publish({
        servers: Object.freeze({ status: 'ready', list: result.value.servers, failure: null }),
      })
    } catch (error) {
      if (this.disposed) return
      this.publish({
        servers: Object.freeze({ ...this.view.servers, status: 'error', failure: transportFailure(error) }),
      })
    }
  }

  /** Load the job list once, on the servers view's jobs section first open. */
  ensureJobs(): void {
    if (this.view.jobs.status === 'ready' || this.jobsPromise !== null) return
    this.jobsPromise = this.loadJobs().finally(() => { this.jobsPromise = null })
  }

  /**
   * Re-poll the job list (the jobs section's interval while any job is
   * active, and the post-submit repaint). A poll already in flight is left
   * alone; a ready list stays ready while the refresh runs.
   */
  refreshJobs(): void {
    if (this.jobsPromise !== null) return
    this.jobsPromise = this.loadJobs().finally(() => { this.jobsPromise = null })
  }

  /**
   * Submit one remote command to a server, then repaint the job list. The
   * failure view of a rejected submit is returned so the form can surface it.
   * @param serverId - the target server record id.
   * @param command - the remote command line.
   * @param experimentId - the experiment to link, when given.
   * @returns null on success, the settled failure otherwise.
   */
  async submitJob(serverId: string, command: string, experimentId?: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.submitJob({ serverId, command, experimentId })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      this.refreshJobs()
      this.notify('success', 'toast.jobSubmitted')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /**
   * Delete one job record, dropping it from the loaded list.
   * @param id - job record id.
   * @returns null on success, the settled failure otherwise.
   */
  async deleteJob(id: string): Promise<ResearchFailureView | null> {
    try {
      const carried = await this.remote.deleteJob({ id })
      if (this.disposed) return null
      if (!carried.ok) return failureOf(carried.error.code, carried.error.message)
      const result = carried.value
      if (!result.ok) return businessFailure(result.error)
      const current = this.view.jobs
      this.publish({
        jobs: Object.freeze({
          ...current,
          list: Object.freeze(current.list.filter(record => record.id !== id)),
        }),
      })
      this.notify('success', 'toast.deleted')
      return null
    } catch (error) {
      return transportFailure(error)
    }
  }

  /** Fetch the job list and publish it, toasting terminal flips observed between polls. */
  private async loadJobs(): Promise<void> {
    if (this.view.jobs.status === 'cold') {
      this.publish({ jobs: Object.freeze({ ...this.view.jobs, status: 'loading', failure: null }) })
    }
    try {
      const carried = await this.remote.listJobs({})
      if (this.disposed) return
      if (!carried.ok) {
        this.publish({
          jobs: Object.freeze({ ...this.view.jobs, status: 'error', failure: failureOf(carried.error.code, carried.error.message) }),
        })
        return
      }
      const result = carried.value
      if (!result.ok) {
        this.publish({
          jobs: Object.freeze({ ...this.view.jobs, status: 'error', failure: businessFailure(result.error) }),
        })
        return
      }
      this.notifyJobTransitions(this.view.jobs.list, result.value.jobs)
      this.publish({
        jobs: Object.freeze({ status: 'ready', list: result.value.jobs, failure: null }),
      })
    } catch (error) {
      if (this.disposed) return
      this.publish({
        jobs: Object.freeze({ ...this.view.jobs, status: 'error', failure: transportFailure(error) }),
      })
    }
  }

  /**
   * Toast each job whose poll-observed status newly flipped terminal, then
   * refresh the loaded experiments slice when a LINKED job settled: the
   * Host's write-back flipped that experiment's status and recorded the
   * outcome as `lastJob`, and the row should show both without a reselect.
   */
  private notifyJobTransitions(prev: readonly JobRecord[], next: readonly JobRecord[]): void {
    const before = new Map(prev.map(job => [job.id, job.status]))
    let linkedSettled = false
    for (const job of next) {
      const prior = before.get(job.id)
      if (prior === undefined || prior === job.status) continue
      const detail = job.command.length > 60 ? `${job.command.slice(0, 59)}…` : job.command
      if (job.status === 'succeeded') this.notify('success', 'toast.jobSucceeded', detail)
      else if (job.status === 'failed') this.notify('error', 'toast.jobFailed', detail)
      if ((job.status === 'succeeded' || job.status === 'failed') && job.experimentId !== undefined) {
        linkedSettled = true
      }
    }
    const experiments = this.view.experiments
    if (linkedSettled && experiments !== null && experiments.status === 'ready') {
      void this.loadExperiments(experiments.projectId, this.experimentsGeneration)
    }
  }

  /**
   * Select one project: load its paper outline, last compile status, and
   * source. A newer selection supersedes in-flight older reads, whose late
   * replies are discarded by generation; pending autosave/auto-compile timers
   * of the previous selection are cancelled.
   * @param projectId - wiki project id.
   */
  select(projectId: string): void {
    // Flush a dirty draft of the project being left BEFORE the sweep below:
    // the generation bump stale-marks any later save reply and clearTimers()
    // kills the debounce, so a draft not flushed now is lost for good.
    const leaving = this.view.source
    if (leaving !== null && leaving.saveState === 'dirty' && leaving.status === 'ready' && leaving.mtimeMs !== null) {
      if (this.saveInFlight) {
        // A save already flies with an OLDER snapshot of this draft. The
        // flags must stay untouched (clearing them orphaned the in-flight
        // save and let its finally clobber the next save's lane); the draft
        // tail is snapshotted instead and chained off the in-flight settle,
        // so the keystrokes after its snapshot are not lost either.
        this.pendingTrailingSave = {
          projectId: leaving.projectId, content: leaving.content, mtimeMs: leaving.mtimeMs,
        }
        this.saveAgain = false
      } else {
        // The flush's synchronous prefix captures the draft and starts the
        // request before the loading slice replaces the view.
        void this.flushSave()
      }
    }
    this.outlineGeneration += 1
    const outlineGeneration = this.outlineGeneration
    this.sourceGeneration += 1
    const sourceGeneration = this.sourceGeneration
    this.experimentsGeneration += 1
    const experimentsGeneration = this.experimentsGeneration
    this.compileGeneration += 1
    this.snapshotsGeneration += 1
    this.snapshotDetailGeneration += 1
    // Compiles queued for the project being left must not hijack the newly
    // selected project's compile lane when the in-flight run settles.
    this.compileQueued.clear()
    this.clearTimers()
    this.publish({
      outline: Object.freeze({ projectId, status: 'loading', nodes: Object.freeze([]), failure: null }),
      source: Object.freeze({
        projectId, status: 'loading', content: '', mtimeMs: null, saveState: 'clean', failure: null,
      }),
      experiments: Object.freeze({ projectId, status: 'loading', list: Object.freeze([]), failure: null }),
      compile: Object.freeze({ projectId, state: 'idle', issues: Object.freeze([]), engine: null, pdfUpdatedAt: null, observed: false }),
      snapshots: null,
      snapshotDetail: null,
    })
    void this.loadOutline(projectId, outlineGeneration)
    void this.loadCompileStatus(projectId)
    void this.loadSource(projectId, sourceGeneration)
    void this.loadExperiments(projectId, experimentsGeneration)
  }

  /**
   * Apply one keystroke batch to the draft and schedule the autosave. Only a
   * ready editor accepts edits; a conflicted or failed draft is frozen until
   * reloaded.
   * @param content - the textarea's full next value.
   */
  edit(content: string): void {
    const source = this.view.source
    if (source === null || source.status !== 'ready' || source.saveState === 'conflict') return
    this.publish({ source: Object.freeze({ ...source, content, saveState: 'dirty' }) })
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flushSave()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  /**
   * Discard the draft and re-read the file from the Host. The conflict
   * recovery path: the agent's version wins and the editor snaps back to it.
   */
  reloadSource(): void {
    const source = this.view.source
    if (source === null) return
    this.sourceGeneration += 1
    const generation = this.sourceGeneration
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    // saveInFlight/saveAgain stay untouched: the in-flight save's reply is
    // stale-marked by the generation bump above, and its finally clears the
    // lane only if no newer save took it over (the saveSeq contract).
    this.publish({
      source: Object.freeze({ ...source, status: 'loading', saveState: 'clean', failure: null }),
    })
    void this.loadSource(source.projectId, generation)
  }

  /**
   * Compile the paper for one project. A compile requested while another run
   * is in flight is queued and fired when the in-flight run settles, so an
   * autosave-triggered compile never interrupts the one already running.
   * @param projectId - wiki project id.
   */
  async compile(projectId: string): Promise<void> {
    if (this.disposed) return
    const current = this.compileProject
    if (current !== null) {
      this.compileQueued.add(projectId)
      return
    }
    const generation = this.compileGeneration
    const abort = new AbortController()
    this.compileAbort = abort
    this.compileProject = projectId
    this.publish({
      compile: Object.freeze({ projectId, state: 'running', issues: Object.freeze([]), engine: null, pdfUpdatedAt: null, observed: false }),
    })
    try {
      const carried = await this.remote.compile({ projectId, dir: this.dirOf(projectId) }, abort.signal)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
      if (this.disposed || generation !== this.compileGeneration || this.compileProject !== projectId) return
      if (!carried.ok) {
        this.publishCompileError(projectId, failureOf(carried.error.code, carried.error.message))
        return
      }
      const result = carried.value
      if (!result.ok) {
        // E.g. latexmk missing on the host: no log, only the message.
        this.publishCompileError(projectId, businessFailure(result.error))
        return
      }
      this.publish({
        compile: Object.freeze({ ...result.value, projectId }),
      })
      if (result.value.state === 'ok') {
        this.notify('success', 'toast.compileOk')
      } else if (result.value.state === 'error') {
        this.notify('error', 'toast.compileFailed')
      }
    } catch (error) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
      if (this.disposed || abort.signal.aborted || generation !== this.compileGeneration || this.compileProject !== projectId) return
      this.publishCompileError(projectId, transportFailure(error))
    } finally {
      if (this.compileAbort === abort) this.compileAbort = null
      if (this.compileProject === projectId) this.compileProject = null
      // A save landed (or a click arrived) while this run was in flight:
      // compile the newest content now, without another debounce window.
      const queued = this.compileQueued.values().next().value as string | undefined
      if (queued !== undefined) this.compileQueued.delete(queued)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
      if (queued !== undefined && !this.disposed) void this.compile(queued)
    }
  }

  /** Abort an in-flight compile, cancel pending timers, and drop subscribers. */
  dispose(): void {
    this.disposed = true
    this.compileAbort?.abort()
    this.clearTimers()
    this.disconnectWikiEvents()
    this.listeners.clear()
  }

  /**
   * Open the wiki events stream (the panel's live refresh). Idempotent; the
   * stream auto-reconnects, and every frame rides the debounced aggregation
   * into {@link applyLiveSlices}.
   * @param factory - stream opener override (tests); defaults to EventSource.
   */
  connectWikiEvents(factory: WikiEventStreamFactory = defaultWikiEventStream): void {
    if (this.disposed || this.eventStream !== null) return
    this.eventStream = factory(
      '/research/events',
      event => this.enqueueWikiChange(event),
      () => { this.resyncLiveSlices() },
    )
  }

  /**
   * Reconnect compensation: the events stream gives no replay, so writes that
   * landed while it was down are unknown. Re-read every warm slice at once —
   * one pseudo change per mappable table rides the normal aggregation path,
   * and the cold-slice gates in {@link applyLiveSlices} keep untouched views
   * untouched.
   */
  private resyncLiveSlices(): void {
    if (this.disposed) return
    for (const table of ['projects', 'papers', 'experiments', 'figures', 'servers', 'jobs', 'venue_watches', 'events', 'paper-source', 'bibliography']) {
      this.liveAggregator.push({ table, key: '', operation: 'put' })
    }
    this.liveAggregator.flushNow()
  }

  /** Close the events stream and drop any pending live refresh. */
  disconnectWikiEvents(): void {
    this.eventStream?.close()
    this.eventStream = null
    this.liveAggregator.cancel()
  }

  /** Fold one pushed wiki change into the debounced refresh. */
  enqueueWikiChange(event: ResearchWikiChangeEvent): void {
    if (this.disposed) return
    this.liveAggregator.push(event)
  }

  /** Flush pending live-refresh slices immediately (the visible-again catch-up). */
  flushWikiChanges(): void {
    this.liveAggregator.flushNow()
  }

  /**
   * Re-read exactly the slices one settled change burst dirtied. Every reload
   * goes through the slice's own loader, so the generation/pending guards of
   * the refresh paths apply unchanged; a cold slice (its view never opened)
   * is skipped. The paper slice never disturbs a draft: the outline re-read
   * is always safe, the source re-read only runs for a settled draft and
   * only publishes when the file on disk actually moved.
   */
  private applyLiveSlices(slices: ReadonlySet<LiveSlice>): void {
    if (this.disposed || slices.size === 0) return
    if (slices.has('projects') && this.view.projectsStatus !== 'cold') {
      this.loadPromise ??= this.loadProjects().finally(() => { this.loadPromise = null })
    }
    if (slices.has('papers') && this.view.papers.status !== 'cold') this.refreshPapers()
    const experiments = this.view.experiments
    if (slices.has('experiments') && experiments !== null) {
      this.experimentsGeneration += 1
      void this.loadExperiments(experiments.projectId, this.experimentsGeneration)
    }
    const figures = this.view.figures
    if (slices.has('figures') && figures !== null) this.loadFigures(figures.projectId, true, true)
    if (slices.has('servers') && this.view.servers.status !== 'cold') {
      this.serversPromise ??= this.loadServers().finally(() => { this.serversPromise = null })
    }
    if (slices.has('jobs') && this.view.jobs.status !== 'cold') this.refreshJobs()
    if (slices.has('venues') && this.view.venues.status !== 'cold') {
      this.refreshVenues(this.view.venues.watchedProjectId)
    }
    if (slices.has('ledger') && this.view.ledger.status !== 'cold' && this.ledgerFilter !== null) {
      this.loadLedger(this.ledgerFilter)
    }
    if (slices.has('bibliography') && this.view.bib !== null
      && (this.view.bib.saveState === 'clean' || this.view.bib.saveState === 'saved')) {
      // A dirty bib edit is the user's draft: skip the reload, the next save
      // takes the conflict path if the file moved meanwhile. 'saved' is just
      // a settled clean state — it must not freeze the live refresh.
      this.reloadBibliography()
    }
    const source = this.view.source
    if (slices.has('paper') && source !== null) {
      this.outlineGeneration += 1
      void this.loadOutline(source.projectId, this.outlineGeneration)
      if (source.status === 'ready' && (source.saveState === 'clean' || source.saveState === 'saved')) {
        void this.reloadSourceIfChanged(source.projectId)
      }
    }
  }

  /**
   * Re-read one project's `main.tex` for the live refresh and publish ONLY
   * when the file moved: a same-content same-mtime reply (the echo of the
   * panel's own save) keeps the current view untouched. No generation bump —
   * the publish re-checks the view identity so a draft started mid-flight is
   * never overwritten.
   */
  private async reloadSourceIfChanged(projectId: string): Promise<void> {
    const seq = ++this.liveSourceReadSeq
    try {
      const carried = await this.remote.getPaperSource({ projectId, dir: this.dirOf(projectId) })
      // A newer re-read started while this one flew: discard the stale reply.
      if (seq !== this.liveSourceReadSeq) return
      if (this.disposed || !carried.ok || !carried.value.ok) return
      const current = this.view.source
      if (current === null || current.projectId !== projectId || current.status !== 'ready') return
      if (current.saveState !== 'clean' && current.saveState !== 'saved') return
      const { content, mtimeMs } = carried.value.value
      if (content === current.content && mtimeMs === current.mtimeMs) return
      this.publish({
        source: Object.freeze({
          projectId, status: 'ready', content, mtimeMs, saveState: 'clean', failure: null,
        }),
      })
    } catch {
      // Live refresh is best-effort: the next change (or a manual reload) retries.
    }
  }

  /** Publish a compile failure as an error state carrying the message as one synthetic issue. */
  private publishCompileError(projectId: string, failure: ResearchFailureView): void {
    this.publish({
      compile: Object.freeze({
        projectId,
        state: 'error',
        issues: Object.freeze([{ severity: 'error' as const, message: failure.message }]),
        engine: this.view.compile.engine,
        pdfUpdatedAt: this.view.compile.pdfUpdatedAt,
        observed: true,
      }),
    })
    this.notify('error', 'toast.compileFailed', failure.message)
  }

  /** Fetch the project list and publish it. */
  private async loadProjects(): Promise<void> {
    this.publish({ projectsStatus: 'loading', projectsFailure: null })
    try {
      const carried = await this.remote.listProjects()
      if (this.disposed) return
      if (!carried.ok) {
        this.publish({ projectsStatus: 'error', projectsFailure: failureOf(carried.error.code, carried.error.message) })
        return
      }
      const result = carried.value
      if (!result.ok) {
        this.publish({ projectsStatus: 'error', projectsFailure: businessFailure(result.error) })
        return
      }
      this.publish({ projects: result.value.projects, projectsStatus: 'ready', projectsFailure: null })
    } catch (error) {
      if (this.disposed) return
      this.publish({ projectsStatus: 'error', projectsFailure: transportFailure(error) })
    }
  }

  /** Fetch the literature list and publish it. A quiet poll keeps a ready list on screen. */
  private async loadPapers(quiet = false): Promise<void> {
    if (!quiet || this.view.papers.status !== 'ready') {
      this.publish({ papers: Object.freeze({ ...this.view.papers, status: 'loading', failure: null }) })
    }
    try {
      const carried = await this.remote.listPapers()
      if (this.disposed) return
      if (!carried.ok) {
        this.publish({
          papers: Object.freeze({ ...this.view.papers, status: 'error', failure: failureOf(carried.error.code, carried.error.message) }),
        })
        return
      }
      const result = carried.value
      if (!result.ok) {
        this.publish({
          papers: Object.freeze({ ...this.view.papers, status: 'error', failure: businessFailure(result.error) }),
        })
        return
      }
      this.publish({
        papers: Object.freeze({ status: 'ready', list: result.value.papers, failure: null }),
      })
    } catch (error) {
      if (this.disposed) return
      this.publish({
        papers: Object.freeze({ ...this.view.papers, status: 'error', failure: transportFailure(error) }),
      })
    }
  }

  /** Fetch one project's experiment runs; a superseded generation never publishes. */
  private async loadExperiments(projectId: string, generation: number): Promise<void> {
    const publishExperiments = (view: ResearchProjectSlice<readonly ExperimentRecord[]>): void => {
      if (this.disposed || generation !== this.experimentsGeneration) return
      this.publish({ experiments: Object.freeze(view) })
    }
    try {
      const carried = await this.remote.listExperiments({ projectId })
      if (!carried.ok) {
        publishExperiments({ projectId, status: 'error', list: [], failure: failureOf(carried.error.code, carried.error.message) })
        return
      }
      const result = carried.value
      if (!result.ok) {
        publishExperiments({ projectId, status: 'error', list: [], failure: businessFailure(result.error) })
        return
      }
      publishExperiments({ projectId, status: 'ready', list: result.value.experiments, failure: null })
    } catch (error) {
      publishExperiments({ projectId, status: 'error', list: [], failure: transportFailure(error) })
    }
  }

  /** The selected project's paper directory override, from the loaded list row. */
  private dirOf(projectId: string): string | undefined {
    return this.view.projects.find(project => project.id === projectId)?.paperDir
  }

  /**
   * Re-read one project's outline and source after the file changed on disk
   * (a section reorder, or the conflict that rejected one).
   */
  private refreshPaper(projectId: string): void {
    this.outlineGeneration += 1
    const outlineGeneration = this.outlineGeneration
    this.sourceGeneration += 1
    const sourceGeneration = this.sourceGeneration
    void this.loadOutline(projectId, outlineGeneration)
    void this.loadSource(projectId, sourceGeneration)
  }

  /** Fetch one project's outline; a superseded generation never publishes. */
  private async loadOutline(projectId: string, generation: number): Promise<void> {
    const publishOutline = (view: ResearchOutlineView): void => {
      if (this.disposed || generation !== this.outlineGeneration) return
      this.publish({ outline: Object.freeze(view) })
    }
    try {
      const carried = await this.remote.getPaperOutline({ projectId, dir: this.dirOf(projectId) })
      if (!carried.ok) {
        publishOutline({ projectId, status: 'error', nodes: [], failure: failureOf(carried.error.code, carried.error.message) })
        return
      }
      const result = carried.value
      if (!result.ok) {
        publishOutline({ projectId, status: 'error', nodes: [], failure: businessFailure(result.error) })
        return
      }
      publishOutline({ projectId, status: 'ready', nodes: result.value.nodes, failure: null })
    } catch (error) {
      publishOutline({ projectId, status: 'error', nodes: [], failure: transportFailure(error) })
    }
  }

  /** Fetch one project's last compile status without touching an in-flight run. */
  private async loadCompileStatus(projectId: string): Promise<void> {
    const generation = this.compileGeneration
    try {
      const carried = await this.remote.getCompileStatus({ projectId })
      // A compile started meanwhile owns the compile view; do not overwrite it
      // with a pre-run snapshot.
      if (this.disposed || generation !== this.compileGeneration || this.compileProject !== null || this.view.compile.projectId !== projectId) return
      if (!carried.ok || !carried.value.ok) return
      this.publish({
        compile: Object.freeze({ ...carried.value.value, projectId }),
      })
    } catch {
      // A status probe failure leaves the previous view in place; the compile
      // button still reaches the Host, which is the authoritative path.
    }
  }

  /** Fetch one project's `main.tex`; a superseded generation never publishes. */
  private async loadSource(projectId: string, generation: number): Promise<void> {
    const publishSource = (view: ResearchSourceView): void => {
      if (this.disposed || generation !== this.sourceGeneration) return
      this.publish({ source: Object.freeze(view) })
    }
    try {
      const carried = await this.remote.getPaperSource({ projectId, dir: this.dirOf(projectId) })
      if (!carried.ok) {
        publishSource({
          projectId, status: 'error', content: '', mtimeMs: null,
          saveState: 'clean', failure: failureOf(carried.error.code, carried.error.message),
        })
        return
      }
      const result = carried.value
      if (!result.ok) {
        publishSource({
          projectId, status: 'error', content: '', mtimeMs: null,
          saveState: 'clean', failure: businessFailure(result.error),
        })
        return
      }
      publishSource({
        projectId, status: 'ready', content: result.value.content,
        mtimeMs: result.value.mtimeMs, saveState: 'clean', failure: null,
      })
    } catch (error) {
      publishSource({
        projectId, status: 'error', content: '', mtimeMs: null,
        saveState: 'clean', failure: transportFailure(error),
      })
    }
  }

  /**
   * Save the current draft under optimistic concurrency. Only one save is in
   * flight at a time; an edit landing mid-flight re-runs the save after it
   * settles. A successful save of an untouched draft schedules the auto-compile.
   */
  private async flushSave(): Promise<void> {
    if (this.saveInFlight) {
      this.saveAgain = true
      return
    }
    const source = this.view.source
    if (source === null || source.status !== 'ready' || source.mtimeMs === null) return
    if (source.saveState !== 'dirty') return
    const { projectId, content, mtimeMs } = source
    const generation = this.sourceGeneration
    const mine = ++this.saveSeq
    this.saveInFlight = true
    this.publish({ source: Object.freeze({ ...source, saveState: 'saving' }) })
    // The mtime this save landed under, for a trailing draft save chained off
    // it (saving the tail with the pre-save base would conflict against this
    // very save's own write).
    let settledMtimeMs: number | null = null
    try {
      const carried = await this.remote.savePaperSource({
        projectId, content, baseMtimeMs: mtimeMs, dir: this.dirOf(projectId),
      })
      if (carried.ok && carried.value.ok) settledMtimeMs = carried.value.value.mtimeMs
      // A reselection or reload superseded this draft; its reply is stale.
      if (this.disposed || generation !== this.sourceGeneration) return
      const current = this.view.source
      if (current === null || current.projectId !== projectId || current.status !== 'ready') return
      if (!carried.ok) {
        this.publish({
          source: Object.freeze({ ...current, saveState: 'save-error', failure: failureOf(carried.error.code, carried.error.message) }),
        })
        return
      }
      const result = carried.value
      if (!result.ok) {
        if (result.error.code === 'conflict') {
          // The agent landed a newer version: keep the draft, freeze editing,
          // and let the panel offer the reload.
          this.publish({ source: Object.freeze({ ...current, saveState: 'conflict' }) })
        } else {
          this.publish({
            source: Object.freeze({ ...current, saveState: 'save-error', failure: businessFailure(result.error) }),
          })
        }
        return
      }
      const settled = Object.freeze({ ...current, mtimeMs: result.value.mtimeMs, failure: null })
      if (current.content === content) {
        this.publish({ source: Object.freeze({ ...settled, saveState: 'saved' }) })
        this.scheduleCompile(projectId)
      } else {
        // Edited again while the save was in flight: stay dirty; the trailing
        // save below (or the next debounce) carries the newer draft.
        this.publish({ source: Object.freeze({ ...settled, saveState: 'dirty' }) })
      }
    } catch (error) {
      if (this.disposed || generation !== this.sourceGeneration) return
      const current = this.view.source
      if (current === null || current.projectId !== projectId) return
      this.publish({
        source: Object.freeze({ ...current, saveState: 'save-error', failure: transportFailure(error) }),
      })
    } finally {
      // Clear the lane only if no newer save took it over: a stale save
      // settling after a reselection must not clobber the new project's
      // in-flight flag (that produced phantom same-base writes and conflicts).
      if (mine === this.saveSeq) this.saveInFlight = false
      const trailing = this.pendingTrailingSave
      if (trailing !== null && trailing.projectId === projectId) {
        // The user navigated away mid-save: persist the draft tail snapshotted
        // by select(), chained off this settle so it builds on this save's
        // mtime instead of conflicting with it.
        this.pendingTrailingSave = null
        void this.saveTrailingDraft(trailing, settledMtimeMs ?? trailing.mtimeMs)
      }
      if (this.saveAgain) {
        this.saveAgain = false
        void this.flushSave()
      }
    }
  }

  /**
   * Persist the draft tail of a project the user navigated away from mid-save.
   * Deliberately outside the view state machine — the loading slice of the new
   * selection already replaced the view, so only the file side effect matters.
   * A conflict is fine and silent (a concurrent agent/host write won; selecting
   * the project back re-reads the file).
   * @param draft - the snapshot select() took of the dirty view.
   * @param baseMtimeMs - the mtime to build on: the in-flight save's landed
   *   mtime when it succeeded, else the snapshot's original base.
   */
  private async saveTrailingDraft(
    draft: { readonly projectId: string; readonly content: string; readonly mtimeMs: number },
    baseMtimeMs: number,
  ): Promise<void> {
    try {
      await this.remote.savePaperSource({
        projectId: draft.projectId, content: draft.content, baseMtimeMs, dir: this.dirOf(draft.projectId),
      })
    } catch {
      // Best-effort: the user is elsewhere; the next select() re-reads.
    }
  }

  /** Debounce the auto-compile that follows a successful save. */
  private scheduleCompile(projectId: string): void {
    if (this.compileTimer !== null) clearTimeout(this.compileTimer)
    this.compileTimer = setTimeout(() => {
      this.compileTimer = null
      void this.compile(projectId)
    }, COMPILE_DEBOUNCE_MS)
  }

  /** Cancel pending autosave and auto-compile timers. */
  private clearTimers(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.compileTimer !== null) {
      clearTimeout(this.compileTimer)
      this.compileTimer = null
    }
  }

  /** Replace part of the view and contain subscriber failures at the boundary. */
  private publish(patch: Partial<ResearchView>): void {
    this.view = Object.freeze({ ...this.view, ...patch })
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[ui-mimir] subscriber threw:', error)
      }
    }
  }
}
