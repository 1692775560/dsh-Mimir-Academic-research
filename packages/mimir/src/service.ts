/**
 * The `research` Remote namespace: the host half of the web research panel.
 * This file is a thin facade — it keeps the class, the `super(ctx,
 * 'research')` registration, the config type, the Context augmentation, and
 * all 64 `@Remote` signatures intact, and forwards every method body to a
 * pure-function domain module under `./services`. It owns no domain logic:
 * the mutable instance state (`compileStatus` map, `jobSeq` counter) rides a
 * single {@link ServiceState} object created here, so every
 * `new ResearchService` gets its own copy.
 * @module dsh-mimir/src/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { ResearchWikiDomain } from './store.ts'
import type { SvgConversionDeps } from './svg-convert.ts'
import type { LatexToolOptions } from './tools/latex.ts'
import type {
  ArxivEntry,
  BibEntry,
  ExperimentInput,
  ResearchArtifactResult,
  ResearchAddJournalEntryResult,
  ResearchArxivSubscriptionsResult,
  ResearchCloseIdeaResult,
  ResearchAdoptIdeaResult,
  ResearchGetEvidenceProfileResult,
  ResearchGetForagingResult,
  ResearchGetHabitsResult,
  ResearchGetLibraryThemesResult,
  ResearchGenerateJournalDraftResult,
  ResearchGetWorktreeResult,
  ResearchSetIdeaParentResult,
  ResearchSetMainlineResult,
  ResearchSetEurekaResult,
  ResearchPinMomentResult,
  ResearchGetMomentIndexResult,
  ResearchGetEurekaViewResult,
  ResearchGenerateDigestResult,
  ResearchBibliographyResult,
  ResearchCheckArxivSubscriptionsResult,
  ResearchCheckServerResult,
  ResearchCompileResult,
  ResearchCompileStatusResult,
  ResearchConvertFigureResult,
  ResearchDeleteExperimentResult,
  ResearchDeleteArxivSubscriptionResult,
  ResearchDeleteFigureResult,
  ResearchDeleteJobResult,
  ResearchDeleteServerResult,
  ResearchExperimentsResult,
  ResearchExportWikiResult,
  ResearchFetchPaperPdfResult,
  ResearchFiguresResult,
  ResearchGenerateBriefResult,
  ResearchImportBibResult,
  ResearchImportPaperResult,
  ResearchImportProjectRequest,
  ResearchImportProjectResult,
  ResearchImportWikiMode,
  ResearchImportWikiResult,
  ResearchListBackupsResult,
  ResearchListEventsResult,
  ResearchListJobsResult,
  ResearchListProjectsResult,
  ResearchListServersResult,
  ResearchOutlineResult,
  ResearchPaperSnapshotResult,
  ResearchPaperSnapshotsResult,
  ResearchPaperSourceResult,
  ResearchPapersResult,
  ResearchProgressReportResult,
  ResearchRemovePaperResult,
  ResearchRenameFigureResult,
  ResearchRevertPaperSnapshotResult,
  ResearchSaveBibliographyResult,
  ResearchSaveExperimentResult,
  ResearchSaveFigureResult,
  ResearchSavePaperSourceResult,
  ResearchSaveArxivSubscriptionResult,
  ResearchSaveServerResult,
  ResearchSearchArxivResult,
  ResearchSearchWebResult,
  ResearchSubmitJobResult,
  ResearchUpdateExperimentResult,
  ResearchUpdateFigureResult,
  ResearchUpdatePaperResult,
  ResearchVenueTemplatesResult,
  ResearchApplyVenueResult,
  ResearchClearVenueResult,
  ResearchVenueDeadlinesResult,
  ResearchSetVenueWatchResult,
  ResearchRefreshVenueDeadlinesResult,
  ResearchDeleteMeetingDeckResult,
  ResearchGenerateMeetingResult,
  ResearchGetImageGenConfigResult,
  ResearchGetSxngConfigResult,
  ResearchMeetingDecksResult,
  ResearchSetImageGenConfigResult,
  ResearchSetSxngConfigResult,
  MeetingInclude,
  ResearchWikiSnapshot,
  ResearchCheckZoteroResult,
  ResearchZoteroCollectionsResult,
  ResearchZoteroExportResult,
  ResearchZoteroImportResult,
  ResearchZoteroSearchResult,
  SectionMove,
  SectionOutlineTitles,
  ServerInput,
  SubsectionMove,
  ResearchWikiChangeEvent,
  AddEvidenceEdgeRequest,
  RetractEvidenceEdgeRequest,
  ResearchGetEvidenceGraphResult,
  ResearchAddEvidenceEdgeResult,
  ResearchRetractEvidenceEdgeResult,
} from './types.ts'
import * as paper from './services/paper.ts'
import * as paperSnapshots from './services/paper-snapshots.ts'
import * as library from './services/library.ts'
import * as zotero from './services/zotero.ts'
import * as subscriptions from './services/subscriptions.ts'
import * as experiment from './services/experiment.ts'
import * as server from './services/server.ts'
import * as wikiAdmin from './services/wiki-admin.ts'
import * as importProject from './services/import-project.ts'
import * as venue from './services/venue.ts'
import * as venueDeadlines from './services/venue-deadlines.ts'
import * as meeting from './services/meeting.ts'
import * as ledger from './services/ledger.ts'
import * as evidence from './services/evidence.ts'
import type { MeetingDeps } from './services/meeting.ts'
import * as imagegen from './services/image-gen.ts'
import * as sxngConfig from './services/sxng-config.ts'
import type { ServiceState } from './services/common.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The research panel's host service (the `research` Remote namespace). */
    research: ResearchService
  }
}

/** Everything the service needs from the plugin's apply scope. */
export interface ResearchServiceConfig {
  /** Absolute research workspace root (already resolved by the plugin). */
  readonly workspaceDir: string
  /** Open research-wiki domain handle owned by the plugin. */
  readonly domain: ResearchWikiDomain
  /** Resolved LaTeX deployment knobs. */
  readonly latex: LatexToolOptions
  /**
   * Resolved scheduled-backup knobs (`dir` already absolute); absent in
   * tests and direct constructions — `listBackups` then reports disabled.
   */
  readonly backup?: {
    readonly enabled: boolean
    readonly intervalMinutes: number
    readonly keep: number
    readonly dir: string
  }
  /**
   * Resolved web-search knobs (the sxng CLI command and timeout); absent
   * when no command is configured — `searchWeb` then reports unavailable.
   */
  readonly search?: {
    readonly command: string
    readonly timeoutMs: number
    /** Test hook replacing the real child process. */
    readonly run?: (command: string, args: readonly string[], timeoutMs: number) => Promise<string>
  }
  /**
   * Probe/run overrides for the SVG conversion behind `convertFigure` /
   * `saveFigure`; absent outside tests, where the real PATH probe and
   * process runner apply.
   */
  readonly svg?: SvgConversionDeps
  /**
   * Resolved Zotero Web API credentials; absent (or empty) disables the
   * integration — every Zotero Remote method then rejects `invalid-input`
   * (`checkZotero` reports `unconfigured`). The key is a secret: it only
   * ever reaches the API as a header.
   */
  readonly zotero?: {
    readonly apiKey: string
    readonly userId: string
  }
  /**
   * Meeting-deck seams (PDF warm-up override); absent outside tests, where
   * the real arXiv fetch applies.
   */
  readonly meetings?: MeetingDeps
  /**
   * Live-refresh push hook: invoked after a successful file-side wiki write
   * (`main.tex`, `bibliography.bib`) so the plugin can broadcast it to open
   * panels; domain-table writes reach panels through `domain/changed`
   * instead. Absent in tests and direct constructions.
   */
  readonly notifyWikiChange?: ((event: ResearchWikiChangeEvent) => void) | undefined
}

/**
 * Host service behind the web research panel. Thin facade: keeps the
 * `research` Remote namespace and all 64 `@Remote` signatures; every method
 * body forwards to a domain module under `./services`. Owns no domain logic.
 */
export class ResearchService extends TypertRemoteService {
  /** Read-only injection (workspaceDir/domain/latex/backup from the config). */
  private readonly deps: ResearchServiceConfig
  /** The only mutable instance state (compileStatus / jobSeq). */
  private readonly state: ServiceState

  /**
   * @param ctx - Host context the service registers on (`ctx.research`).
   * @param config - Workspace root, open wiki domain, and LaTeX knobs.
   */
  constructor(ctx: Context, config: ResearchServiceConfig) {
    super(ctx, 'research')
    if (config.workspaceDir.trim().length === 0) {
      throw new TypeError('research: workspaceDir must be a non-empty absolute path')
    }
    this.deps = {
      workspaceDir: config.workspaceDir,
      domain: config.domain,
      latex: config.latex,
      ...(config.backup === undefined ? {} : { backup: config.backup }),
      ...(config.search === undefined ? {} : { search: config.search }),
      ...(config.svg === undefined ? {} : { svg: config.svg }),
      ...(config.zotero === undefined ? {} : { zotero: config.zotero }),
      ...(config.meetings === undefined ? {} : { meetings: config.meetings }),
      ...(config.notifyWikiChange === undefined ? {} : { notifyWikiChange: config.notifyWikiChange }),
    }
    this.state = {
      compileStatus: new Map(),
      jobSeq: 0,
      jobAborts: new Map(),
    }
  }

  /** Broadcast a file-side wiki write to subscribed panels (a no-op unwired). */
  private wikiFileChanged(table: 'paper-source' | 'bibliography', projectId: string): void {
    this.deps.notifyWikiChange?.({ table, key: projectId, operation: 'put' })
  }

  // wiki-admin domain
  @Remote('listProjects')
  listProjects(): Promise<ResearchListProjectsResult> {
    return wikiAdmin.listProjects(this.deps)
  }

  // import-project domain
  @Remote('importProject')
  importProject(request: ResearchImportProjectRequest): Promise<ResearchImportProjectResult> {
    return importProject.importProject(this.deps, request)
  }

  // paper domain: outline / source / bibliography / compile
  @Remote('getPaperOutline')
  getPaperOutline(request: { projectId: string; dir?: string | undefined }): Promise<ResearchOutlineResult> {
    return paper.getPaperOutline(this.deps, request)
  }

  // library domain
  @Remote('listPapers')
  listPapers(): Promise<ResearchPapersResult> {
    return library.listPapers(this.deps)
  }

  @Remote('searchArxiv')
  searchArxiv(request: { query: string; maxResults?: number }): Promise<ResearchSearchArxivResult> {
    return library.searchArxiv(this.deps, request)
  }

  @Remote('searchWeb')
  searchWeb(request: {
    query: string
    maxResults?: number
    categories?: string | undefined
    lang?: string | undefined
  }): Promise<ResearchSearchWebResult> {
    return library.searchWeb(this.deps, request)
  }

  @Remote('importPaper')
  importPaper(request: { entry: ArxivEntry; projectId?: string | undefined }): Promise<ResearchImportPaperResult> {
    return library.importPaper(this.deps, request)
  }

  @Remote('removePaper')
  removePaper(request: { arxivId: string }): Promise<ResearchRemovePaperResult> {
    return library.removePaper(this.deps, request)
  }

  @Remote('updatePaper')
  updatePaper(request: {
    arxivId: string
    tags?: string[] | undefined
    projectIds?: string[] | undefined
    notes?: string | undefined
    relevance?: { projectId: string; score: number; reason: string } | undefined
  }): Promise<ResearchUpdatePaperResult> {
    return library.updatePaper(this.deps, request)
  }

  @Remote('fetchPaperPdf')
  fetchPaperPdf(request: { arxivId: string }): Promise<ResearchFetchPaperPdfResult> {
    return library.fetchPaperPdf(this.deps, request)
  }

  // zotero domain: read-only bridge to a configured Zotero user library
  @Remote('checkZotero')
  checkZotero(): Promise<ResearchCheckZoteroResult> {
    return zotero.checkZotero(this.deps)
  }

  @Remote('listZoteroCollections')
  listZoteroCollections(): Promise<ResearchZoteroCollectionsResult> {
    return zotero.listZoteroCollections(this.deps)
  }

  @Remote('searchZotero')
  searchZotero(request: { query: string; maxResults?: number }): Promise<ResearchZoteroSearchResult> {
    return zotero.searchZotero(this.deps, request)
  }

  @Remote('importZoteroItem')
  importZoteroItem(request: { key: string; projectId?: string | undefined }): Promise<ResearchZoteroImportResult> {
    return zotero.importZoteroItem(this.deps, request)
  }

  @Remote('exportZoteroCollectionToBib')
  exportZoteroCollectionToBib(request: {
    projectId: string
    collectionKey: string
    dir?: string | undefined
  }): Promise<ResearchZoteroExportResult> {
    return zotero.exportZoteroCollectionToBib(this.deps, request)
  }

  // subscription domain: arXiv new-paper checks (pure filesystem storage)
  @Remote('listArxivSubscriptions')
  listArxivSubscriptions(): Promise<ResearchArxivSubscriptionsResult> {
    return subscriptions.listArxivSubscriptions(this.deps)
  }

  @Remote('saveArxivSubscription')
  saveArxivSubscription(request: { query: string }): Promise<ResearchSaveArxivSubscriptionResult> {
    return subscriptions.saveArxivSubscription(this.deps, request)
  }

  @Remote('deleteArxivSubscription')
  deleteArxivSubscription(request: { id: string }): Promise<ResearchDeleteArxivSubscriptionResult> {
    return subscriptions.deleteArxivSubscription(this.deps, request)
  }

  @Remote('checkArxivSubscriptions')
  checkArxivSubscriptions(request: { id?: string }): Promise<ResearchCheckArxivSubscriptionsResult> {
    return subscriptions.checkArxivSubscriptions(this.deps, request)
  }

  // experiment domain
  @Remote('listExperiments')
  listExperiments(request: { projectId?: string }): Promise<ResearchExperimentsResult> {
    return experiment.listExperiments(this.deps, request)
  }

  @Remote('deleteExperiment')
  deleteExperiment(request: { id: string }): Promise<ResearchDeleteExperimentResult> {
    return experiment.deleteExperiment(this.deps, request)
  }

  @Remote('saveExperiment')
  saveExperiment(request: { experiment: ExperimentInput }): Promise<ResearchSaveExperimentResult> {
    return experiment.saveExperiment(this.deps, request)
  }

  @Remote('updateExperiment')
  updateExperiment(request: {
    id: string
    serverId?: string | null | undefined
  }): Promise<ResearchUpdateExperimentResult> {
    return experiment.updateExperiment(this.deps, request)
  }

  @Remote('readArtifact')
  readArtifact(request: { projectId: string; name: string }): Promise<ResearchArtifactResult> {
    return experiment.readArtifact(this.deps, request)
  }

  @Remote('listFigures')
  listFigures(request: { projectId: string; dir?: string | undefined }): Promise<ResearchFiguresResult> {
    return experiment.listFigures(this.deps, request)
  }

  // paper domain: source / reorder / bibliography
  @Remote('getPaperSource')
  getPaperSource(request: { projectId: string; dir?: string | undefined }): Promise<ResearchPaperSourceResult> {
    return paper.getPaperSource(this.deps, request)
  }

  @Remote('savePaperSource')
  async savePaperSource(request: {
    projectId: string
    content: string
    baseMtimeMs: number
    dir?: string | undefined
  }): Promise<ResearchSavePaperSourceResult> {
    const result = await paper.savePaperSource(this.deps, request)
    if (result.ok) this.wikiFileChanged('paper-source', request.projectId)
    return result
  }

  @Remote('reorderPaperSections')
  async reorderPaperSections(request: {
    projectId: string
    moves: SectionMove[]
    baseOutline: string[]
    dir?: string | undefined
  }): Promise<ResearchSavePaperSourceResult> {
    const result = await paper.reorderPaperSections(this.deps, request)
    if (result.ok) this.wikiFileChanged('paper-source', request.projectId)
    return result
  }

  @Remote('reorderPaperSubsections')
  async reorderPaperSubsections(request: {
    projectId: string
    moves: SubsectionMove[]
    baseOutline: SectionOutlineTitles[]
    dir?: string | undefined
  }): Promise<ResearchSavePaperSourceResult> {
    const result = await paper.reorderPaperSubsections(this.deps, request)
    if (result.ok) this.wikiFileChanged('paper-source', request.projectId)
    return result
  }

  @Remote('getBibliography')
  getBibliography(request: { projectId: string; dir?: string | undefined }): Promise<ResearchBibliographyResult> {
    return paper.getBibliography(this.deps, request)
  }

  @Remote('saveBibliography')
  async saveBibliography(request: {
    projectId: string
    entries: BibEntry[]
    baseMtimeMs: number | null
    dir?: string | undefined
  }): Promise<ResearchSaveBibliographyResult> {
    const result = await paper.saveBibliography(this.deps, request)
    if (result.ok) this.wikiFileChanged('bibliography', request.projectId)
    return result
  }

  @Remote('importPapersToBib')
  async importPapersToBib(request: {
    projectId: string
    arxivIds: string[]
    dir?: string | undefined
  }): Promise<ResearchImportBibResult> {
    const result = await paper.importPapersToBib(this.deps, request)
    if (result.ok) this.wikiFileChanged('bibliography', request.projectId)
    return result
  }

  // paper domain: compile status flows through this.state
  @Remote('compile')
  compile(request: { projectId?: string; dir?: string | undefined }, signal: AbortSignal): Promise<ResearchCompileResult> {
    return paper.compile(this.deps, this.state, request, signal)
  }

  @Remote('getCompileStatus')
  getCompileStatus(request: { projectId?: string }): Promise<ResearchCompileStatusResult> {
    return paper.getCompileStatus(this.deps, this.state, request)
  }

  // paper domain: compile snapshots (pure filesystem storage)
  @Remote('listPaperSnapshots')
  listPaperSnapshots(request: { projectId: string }): Promise<ResearchPaperSnapshotsResult> {
    return paperSnapshots.listPaperSnapshots(this.deps, request)
  }

  @Remote('getPaperSnapshot')
  getPaperSnapshot(request: { projectId: string; id: string }): Promise<ResearchPaperSnapshotResult> {
    return paperSnapshots.getPaperSnapshot(this.deps, request)
  }

  @Remote('revertPaperSnapshot')
  async revertPaperSnapshot(request: {
    projectId: string
    id: string
    baseMtimeMs: number
    dir?: string | undefined
  }): Promise<ResearchRevertPaperSnapshotResult> {
    const result = await paperSnapshots.revertPaperSnapshot(this.deps, request)
    if (result.ok) this.wikiFileChanged('paper-source', request.projectId)
    return result
  }

  // experiment domain: figures
  @Remote('deleteFigure')
  deleteFigure(request: { projectId: string; relPath: string; dir?: string | undefined }): Promise<ResearchDeleteFigureResult> {
    return experiment.deleteFigure(this.deps, request)
  }

  @Remote('renameFigure')
  renameFigure(request: {
    projectId: string
    relPath: string
    newName: string
    dir?: string | undefined
  }): Promise<ResearchRenameFigureResult> {
    return experiment.renameFigure(this.deps, request)
  }

  @Remote('updateFigure')
  updateFigure(request: {
    projectId: string
    relPath: string
    caption: string
  }): Promise<ResearchUpdateFigureResult> {
    return experiment.updateFigure(this.deps, request)
  }

  @Remote('convertFigure')
  convertFigure(request: { projectId: string; relPath: string; dir?: string | undefined }): Promise<ResearchConvertFigureResult> {
    return experiment.convertFigure(this.deps, request)
  }

  @Remote('saveFigure')
  saveFigure(request: {
    projectId: string
    name: string
    content: string
    caption?: string | undefined
    dir?: string | undefined
  }): Promise<ResearchSaveFigureResult> {
    return experiment.saveFigure(this.deps, request)
  }

  // venue domain: target-conference templates
  @Remote('listVenueTemplates')
  listVenueTemplates(): Promise<ResearchVenueTemplatesResult> {
    return venue.listVenueTemplates()
  }  @Remote('applyVenueTemplate')
  applyVenueTemplate(request: {
    projectId: string
    dir?: string | undefined
    templateId?: string | undefined
    customName?: string | undefined
  }): Promise<ResearchApplyVenueResult> {
    return venue.applyVenueTemplate(this.deps, request)
  }

  @Remote('clearVenueTemplate')
  clearVenueTemplate(request: { projectId: string }): Promise<ResearchClearVenueResult> {
    return venue.clearVenueTemplate(this.deps, request)
  }

  // venue-deadline domain: the ccfddl catalog read + per-project watch list.
  // Reads come from the local cache only — the network lives in the refresh
  // loop, so the panel opens offline on the last good snapshot.
  @Remote('listVenueDeadlines')
  listVenueDeadlines(request: { projectId?: string | undefined }): Promise<ResearchVenueDeadlinesResult> {
    return venueDeadlines.listVenueDeadlines(this.deps, request)
  }

  @Remote('setVenueWatch')
  setVenueWatch(request: {
    projectId: string
    series: string
    watched: boolean
  }): Promise<ResearchSetVenueWatchResult> {
    return venueDeadlines.setVenueWatch(this.deps, request)
  }

  @Remote('refreshVenueDeadlines')
  refreshVenueDeadlines(): Promise<ResearchRefreshVenueDeadlinesResult> {
    return venueDeadlines.refreshVenueDeadlines(this.deps)
  }

  // meeting domain: group-meeting pptx decks
  @Remote('generateMeetingDeck')
  generateMeetingDeck(request: {
    projectId: string
    title?: string | undefined
    presenter?: string | undefined
    date?: string | undefined
    paperIds?: readonly string[] | undefined
    figureRelPaths?: readonly string[] | undefined
    include?: Partial<MeetingInclude> | undefined
    aiIllustrations?: boolean | undefined
  }): Promise<ResearchGenerateMeetingResult> {
    return meeting.generateMeetingDeck(this.deps, request)
  }

  @Remote('getImageGenConfig')
  getImageGenConfig(): Promise<ResearchGetImageGenConfigResult> {
    return imagegen.getImageGenConfig(this.deps.workspaceDir)
  }

  @Remote('setImageGenConfig')
  setImageGenConfig(request: {
    baseUrl?: string | undefined
    apiKey?: string | undefined
    model?: string | undefined
    size?: string | undefined
  }): Promise<ResearchSetImageGenConfigResult> {
    return imagegen.setImageGenConfig(this.deps.workspaceDir, request)
  }

  @Remote('getSxngConfig')
  getSxngConfig(): Promise<ResearchGetSxngConfigResult> {
    return sxngConfig.getSxngConfig()
  }

  @Remote('setSxngConfig')
  setSxngConfig(request: {
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
  }): Promise<ResearchSetSxngConfigResult> {
    return sxngConfig.setSxngConfig(request)
  }

  @Remote('listMeetingDecks')
  listMeetingDecks(request: { projectId: string }): Promise<ResearchMeetingDecksResult> {
    return meeting.listMeetingDecks(this.deps, request)
  }

  @Remote('deleteMeetingDeck')
  deleteMeetingDeck(request: { projectId: string; file: string }): Promise<ResearchDeleteMeetingDeckResult> {
    return meeting.deleteMeetingDeck(this.deps, request)
  }

  // server domain
  @Remote('listServers')
  listServers(): Promise<ResearchListServersResult> {
    return server.listServers(this.deps)
  }

  @Remote('saveServer')
  saveServer(request: { server: ServerInput }): Promise<ResearchSaveServerResult> {
    return server.saveServer(this.deps, request)
  }

  @Remote('deleteServer')
  deleteServer(request: { id: string }): Promise<ResearchDeleteServerResult> {
    return server.deleteServer(this.deps, request)
  }

  @Remote('checkServer')
  checkServer(request: { id: string }): Promise<ResearchCheckServerResult> {
    return server.checkServer(this.deps, request)
  }

  // job counter flows through this.state
  @Remote('submitJob')
  submitJob(request: {
    serverId: string
    command: string
    experimentId?: string | undefined
  }): Promise<ResearchSubmitJobResult> {
    return server.submitJob(this.deps, this.state, request)
  }

  @Remote('listJobs')
  listJobs(request: { serverId?: string }): Promise<ResearchListJobsResult> {
    return server.listJobs(this.deps, request)
  }

  @Remote('deleteJob')
  deleteJob(request: { id: string }): Promise<ResearchDeleteJobResult> {
    return server.deleteJob(this.deps, this.state, request)
  }

  // wiki-admin domain: export / import / backups
  @Remote('exportWiki')
  exportWiki(): Promise<ResearchExportWikiResult> {
    return wikiAdmin.exportWiki(this.deps)
  }

  @Remote('importWiki')
  importWiki(request: {
    snapshot: ResearchWikiSnapshot
    mode: ResearchImportWikiMode
    confirmReplace?: boolean
  }): Promise<ResearchImportWikiResult> {
    return wikiAdmin.importWiki(this.deps, request)
  }

  @Remote('listBackups')
  listBackups(): Promise<ResearchListBackupsResult> {
    return wikiAdmin.listBackups(this.deps)
  }

  // ledger domain: the append-only growth record (query + progress report)
  @Remote('listEvents')
  listEvents(request: {
    projectId?: string | undefined
    actorKind?: string | undefined
    actionPrefix?: string | undefined
    since?: string | undefined
    until?: string | undefined
    limit?: number | undefined
    order?: string | undefined
    anchor?: string | undefined
  }): Promise<ResearchListEventsResult> {
    return ledger.listEventsRemote(this.deps, request)
  }

  @Remote('generateProgressReport')
  generateProgressReport(request: {
    projectId?: string | undefined
    since?: string | undefined
    until?: string | undefined
  }): Promise<ResearchProgressReportResult> {
    return ledger.generateProgressReportRemote(this.deps, request)
  }

  @Remote('generateBrief')
  generateBrief(request: {
    projectId?: string | undefined
    since?: string | undefined
    until?: string | undefined
  }): Promise<ResearchGenerateBriefResult> {
    return ledger.generateBriefRemote(this.deps, request)
  }

  @Remote('addJournalEntry')
  addJournalEntry(request: {
    text: string
    projectId?: string | undefined
    ideaId?: string | undefined
    valence?: number | undefined
    arousal?: number | undefined
    question?: { kind: string; lineId: string } | undefined
  }): Promise<ResearchAddJournalEntryResult> {
    return ledger.addJournalEntryRemote(this.deps, request)
  }

  // library themes (S5): the shelf's own drift — no inference, no advice
  @Remote('getLibraryThemes')
  getLibraryThemes(request: {
    since?: string | undefined
    until?: string | undefined
  }): Promise<ResearchGetLibraryThemesResult> {
    return ledger.getLibraryThemesRemote(this.deps, request)
  }

  // habits (S6): the researcher's own rhythm — description only
  @Remote('getHabits')
  getHabits(request: {
    since?: string | undefined
    until?: string | undefined
  }): Promise<ResearchGetHabitsResult> {
    return ledger.getHabitsRemote(this.deps, request)
  }

  // journal draft (S7): the day already written out, not a blank page
  @Remote('generateJournalDraft')
  generateJournalDraft(request: {
    kind?: string | undefined
    lang?: string | undefined
    projectId?: string | undefined
    since?: string | undefined
    until?: string | undefined
  }): Promise<ResearchGenerateJournalDraftResult> {
    return ledger.generateJournalDraftRemote(this.deps, request)
  }

  // humanized ledger (B–F): eureka declaration, moment pins, digest report.
  // The system never declares an insight and never prompts "you are near one";
  // these verbs only record the researcher's own declarations and fold the
  // already-written record into a description.
  @Remote('setEureka')
  setEureka(request: {
    ideaId?: string | undefined
    projectId?: string | undefined
    title: string
  }): Promise<ResearchSetEurekaResult> {
    return ledger.setEurekaRemote(this.deps, request)
  }

  @Remote('pinMoment')
  pinMoment(request: {
    targetEventId: string
    note?: string | undefined
    pinned?: boolean | undefined
  }): Promise<ResearchPinMomentResult> {
    return ledger.pinMomentRemote(this.deps, request)
  }

  // moment index & eureka view (S9b/S8c): pull-only reads of the unified
  // timeline. The five sources propose; canonical status belongs solely to
  // the researcher's declarations. No ranking, no push, zero verbs.
  @Remote('getMomentIndex')
  getMomentIndex(request: {
    since?: string | undefined
    until?: string | undefined
  }): Promise<ResearchGetMomentIndexResult> {
    return ledger.getMomentIndexRemote(this.deps, request)
  }

  @Remote('getEurekaView')
  getEurekaView(): Promise<ResearchGetEurekaViewResult> {
    return ledger.getEurekaViewRemote(this.deps)
  }

  @Remote('generateDigest')
  generateDigest(request: {
    tier?: string | undefined
    since?: string | undefined
    until?: string | undefined
    lang?: string | undefined
  }): Promise<ResearchGenerateDigestResult> {
    return ledger.generateDigestRemote(this.deps, request)
  }

  // worktree domain (S2): the research process as a git-like working tree
  @Remote('getWorktree')
  getWorktree(): Promise<ResearchGetWorktreeResult> {
    return ledger.getWorktreeRemote(this.deps)
  }

  @Remote('setMainline')
  setMainline(request: {
    ideaId?: string | undefined
    projectId?: string | undefined
  }): Promise<ResearchSetMainlineResult> {
    return ledger.setMainlineRemote(this.deps, request)
  }

  @Remote('setIdeaParent')
  setIdeaParent(request: {
    ideaId: string
    parentIdeaId: string | null
  }): Promise<ResearchSetIdeaParentResult> {
    return ledger.setIdeaParentRemote(this.deps, request)
  }

  @Remote('adoptIdea')
  adoptIdea(request: {
    ideaId: string
  }): Promise<ResearchAdoptIdeaResult> {
    return ledger.adoptIdeaRemote(this.deps, request)
  }

  @Remote('closeIdea')
  closeIdea(request: {
    ideaId: string
    reason: string
  }): Promise<ResearchCloseIdeaResult> {
    return ledger.closeIdeaRemote(this.deps, request)
  }

  // evidence engine (S3): read-only E1 instrumentation, no UI until G1
  @Remote('getEvidenceProfile')
  getEvidenceProfile(): Promise<ResearchGetEvidenceProfileResult> {
    return ledger.getEvidenceProfileRemote(this.deps)
  }

  // foraging layer (S4): territory ledger + GUT baseline + cards (E0)
  @Remote('getForaging')
  getForaging(): Promise<ResearchGetForagingResult> {
    return ledger.getForagingRemote(this.deps)
  }

  // evidence graph (v1): two append-only declarations + one pure-fold read.
  // The edge is the ledger row it was declared on; retractions resolve in
  // the fold (last-declaration-wins) and are authorized here (panel: any
  // edge; agents: only their own declarations).
  @Remote('getEvidenceGraph')
  getEvidenceGraph(request: {
    projectId?: string | undefined
    since?: string | undefined
    until?: string | undefined
  }): Promise<ResearchGetEvidenceGraphResult> {
    return evidence.getEvidenceGraph(this.deps, request)
  }

  @Remote('addEvidenceEdge')
  addEvidenceEdge(request: AddEvidenceEdgeRequest): Promise<ResearchAddEvidenceEdgeResult> {
    return evidence.addEvidenceEdge(this.deps, request)
  }

  @Remote('retractEvidenceEdge')
  retractEvidenceEdge(request: RetractEvidenceEdgeRequest): Promise<ResearchRetractEvidenceEdgeResult> {
    return evidence.retractEvidenceEdge(this.deps, request)
  }
}

export default ResearchService
