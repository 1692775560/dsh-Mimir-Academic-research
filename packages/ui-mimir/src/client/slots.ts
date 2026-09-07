/**
 * The research panel's slot-facing contracts. Both target seats are declared
 * by other packages (`sidebar.footer.action` by ui-sidebar, `shell.overlay` by
 * ui-layout), so no SlotMap merge lives here — this module only composes the
 * four props shares for the two entries and types the panel's inject face.
 * Live data arrives through the `research` hook (the framework binds it into
 * `useResearch`); panel open-state and selection arrive through the shared
 * store declared at register.
 * @module dsh-client-ui-mimir/client/slots
 */

import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-layout SlotMap merge (the 'shell.overlay' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-sidebar SlotMap merge (the 'sidebar.footer.action' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls this package's LocaleNamespaceMap merge (the 'research' seat).
import type {} from './locales.ts'
import type {
  ArxivEntry, BibEntry, ExperimentInput, FigureEntry, MeetingInclude, ResearchEventFilter,
  ResearchGenerateBriefOptions, ResearchImportWikiMode, ResearchImportedProject, ResearchJournalQuestionRef, ResearchProgressReportOptions,
  ResearchWikiSnapshot, SectionMove, SectionOutlineTitles, ServerInput, SubsectionMove,
} from 'dsh-mimir/types'
import type { ResearchFailureView, ResearchImportCounts, ResearchView } from './controller.ts'
import type { MetricChartRow } from './view-common.ts'
import type { WorkbenchChrome } from './shortcuts.ts'
import type { createResearchPanelStore } from './store.ts'

/** Store handle type shared by both registrations. */
export type ResearchPanelStore = ReturnType<typeof createResearchPanelStore>

/** Injected business face of the research panel entry. */
export interface ResearchPanelInjected {
  hooks: {
    /** The panel's data view: projects, selected outline, compile status. */
    research: HostObservable<ResearchView>
    /** The header chrome snapshot: resolved color scheme and active locale. */
    chrome: HostObservable<WorkbenchChrome>
  }
  /** Toggle the host theme between light and dark (durable via Host settings). */
  toggleTheme: () => void
  /** Toggle the host locale between Chinese and English (durable via Host settings). */
  toggleLocale: () => void
  /** Load the project list once, on first open. */
  ensure: () => void
  /**
   * Select one project: writes the store selection AND fetches its outline
   * and compile status, so the row click is the single entry point.
   * @param projectId - wiki project id.
   */
  selectProject: (projectId: string) => void
  /**
   * Import one existing local LaTeX project into the workspace (the project
   * list's "import existing project" dialog): the host copies the tree into
   * `imported/<slug>/` and registers the project; on success the list has
   * already refreshed and the new project is selected before the summary
   * resolves.
   * @param path - absolute or `~`-prefixed source directory.
   * @param title - the optional explicit title.
   * @returns the import summary on success, the settled failure otherwise.
   */
  importProject: (path: string, title?: string) => Promise<ResearchImportedProject | ResearchFailureView>
  /**
   * Compile the paper for one project; while a run is in flight the request
   * is queued and fired when it settles.
   * @param projectId - wiki project id.
   */
  compile: (projectId: string) => void
  /**
   * Hand one assembled compile-fix prompt to the current session's agent (the
   * paper view's per-issue "fix with AI" button); the outcome lands in toasts.
   * @param prompt - the assembled fix request (issue, location, source window).
   */
  requestCompileFix: (prompt: string) => Promise<void>
  /**
   * Hand one assembled related-work prompt to the current session's agent
   * (the papers view's "draft related work" button); the outcome lands in
   * toasts.
   * @param prompt - the assembled draft request (papers, citations, verify loop).
   */
  requestRelatedWork: (prompt: string) => Promise<void>
  /**
   * Apply one editor change to the draft; autosaves after a short debounce.
   * @param content - the textarea's full next value.
   */
  editSource: (content: string) => void
  /** Discard the draft and re-read the file (the conflict recovery path). */
  reloadSource: () => void
  /** Load the literature list once, on the papers view's first open. */
  ensurePapers: () => void
  /**
   * Re-fetch the literature list without a loading flash (the papers view's
   * poll after handing a scoring request to the agent).
   */
  refreshPapers: () => void
  /**
   * Hand one assembled relevance-scoring prompt to the current session's
   * agent (the papers view's "score with AI" buttons); the outcome lands in
   * toasts, and the agent's `wiki_note` writes land in the next refresh.
   * @param prompt - the assembled scoring request (papers, project direction).
   */
  requestPaperScore: (prompt: string) => Promise<void>
  /**
   * Hand one assembled figure-organization prompt to the current session's
   * agent (the figures view's "organize with AI" button); the outcome lands
   * in toasts, and the agent's `figure_organize` writes land in the next
   * rescan.
   * @param prompt - the assembled organize request (figure, project, caption).
   */
  requestFigureOrganize: (prompt: string) => Promise<void>
  /** Load the venue picker's built-in registry once, on first open. */
  ensureVenueTemplates: () => void
  /**
   * Apply one venue (built-in or uploaded kit) to one project; the header
   * chip updates via the refreshed project list.
   * @param projectId - wiki project id.
   * @param options - built-in template id, or a custom kit display name.
   * @returns null on success, the settled failure otherwise.
   */
  applyVenueTemplate: (
    projectId: string,
    options: { templateId?: string | undefined; customName?: string | undefined },
  ) => Promise<ResearchFailureView | null>
  /**
   * Clear one project's target venue.
   * @param projectId - wiki project id.
   * @returns null on success, the settled failure otherwise.
   */
  clearVenueTemplate: (projectId: string) => Promise<ResearchFailureView | null>
  /**
   * Upload venue-kit files (.cls/.sty/...) into the project's `template/`
   * directory, one request per file.
   * @param projectId - wiki project id.
   * @param dir - the project's paper directory override, when any.
   * @param files - the picked files.
   */
  uploadTemplateFiles: (projectId: string, dir: string | undefined, files: readonly File[]) => Promise<void>
  /**
   * Hand one assembled venue-format prompt to the current session's agent
   * (the paper view's "format to venue" button); the outcome lands in toasts.
   * @param prompt - the assembled re-layout request (venue, brief path).
   */
  requestVenueFormat: (prompt: string) => Promise<void>
  /**
   * Load the venue catalog once, on the venues view's first open; a watch
   * list loaded for another project refetches (the flags ride the read).
   * @param projectId - the selected project whose watch list rides along, or null.
   */
  ensureVenues: (projectId: string | null) => void
  /**
   * Re-fetch the catalog read without a loading flash (the view's retry).
   * @param projectId - the selected project whose watch list rides along, or null.
   */
  refreshVenues: (projectId: string | null) => void
  /**
   * Ask the host to fetch the upstream ccfddl catalog now and reload; a
   * failure toasts and keeps the last good snapshot.
   * @param projectId - the selected project whose watch list rides the reload, or null.
   */
  refreshVenueCatalog: (projectId: string | null) => Promise<void>
  /**
   * Flip one conference series in the selected project's watch list
   * (optimistic; a failure rolls the star back and toasts).
   * @param seriesKey - the ccfddl series key (lowercased title).
   */
  toggleVenueWatch: (seriesKey: string) => Promise<void>
  /** Load the arXiv subscription list once (a stale list triggers one open-time check). */
  ensureSubscriptions: () => void
  /**
   * Add one arXiv subscription, then refresh the list.
   * @param query - the free-text query; an empty or duplicate one is rejected.
   * @returns null on success, the settled failure otherwise.
   */
  saveArxivSubscription: (query: string) => Promise<ResearchFailureView | null>
  /**
   * Delete one arXiv subscription, then refresh the list.
   * @param id - the subscription id.
   * @returns null on success, the settled failure otherwise.
   */
  deleteArxivSubscription: (id: string) => Promise<ResearchFailureView | null>
  /**
   * Check every subscription for new papers now (the bar's manual button).
   * @returns null on success, the settled failure otherwise.
   */
  checkArxivSubscriptions: () => Promise<ResearchFailureView | null>
  /**
   * Search arXiv from the papers view; the outcome lands in the view's
   * `arxivSearch` slice.
   * @param query - the free-text query; an empty one never leaves the client.
   */
  searchArxiv: (query: string) => void
  /**
   * Search the web from the papers view; the outcome lands in the view's
   * `webSearch` slice.
   * @param query - the free-text query; an empty one never leaves the client.
   */
  searchWeb: (query: string) => void
  /**
   * Import one arXiv entry into the wiki, then refresh the literature list.
   * @param entry - the parsed arXiv entry of one search result card.
   * @param projectId - the selected project to link, when any.
   * @returns null on success, the settled failure otherwise.
   */
  importPaper: (entry: ArxivEntry, projectId?: string) => Promise<ResearchFailureView | null>
  /**
   * Remove one remembered paper, then refresh the literature list.
   * @param arxivId - the bare arXiv id.
   * @returns null on success, the settled failure otherwise.
   */
  removePaper: (arxivId: string) => Promise<ResearchFailureView | null>
  /**
   * Load one whitelisted markdown artifact (the experiment-log viewer).
   * @param projectId - wiki project id.
   * @param name - a whitelisted artifact name.
   */
  loadArtifact: (projectId: string, name: string) => void
  /**
   * Scan one project's paper directory for figures.
   * @param projectId - wiki project id.
   * @param force - bypass the fresh-view skip (the refresh button).
   * @param quiet - keep a ready list on screen while rescanning (the poll
   * after handing an organize request to the agent).
   */
  loadFigures: (projectId: string, force?: boolean, quiet?: boolean) => void
  /**
   * Upload image files into one project's paper directory through the
   * `/research/figure-upload` route, one POST per file, then force a rescan.
   * @param projectId - wiki project id.
   * @param dir - the project's paper directory override, when any.
   * @param files - the picked files.
   * @param onProgress - called after each settled upload with (done, total).
   * @returns resolution after every file settled; per-file HTTP failures throw.
   */
  uploadFigures: (
    projectId: string,
    dir: string | undefined,
    files: readonly File[],
    onProgress?: (done: number, total: number) => void,
  ) => Promise<void>
  /**
   * Delete one figure of one project and force a rescan.
   * @param projectId - wiki project id.
   * @param relPath - figure path relative to the paper directory.
   * @returns null on success, the settled failure otherwise.
   */
  deleteFigure: (projectId: string, relPath: string) => Promise<ResearchFailureView | null>
  /**
   * List one project's generated meeting decks (the meetings view).
   * @param projectId - wiki project id.
   * @param force - bypass the fresh-view skip (post-generate/delete reloads).
   */
  loadMeetings: (projectId: string, force?: boolean) => void
  /**
   * Generate one project's meeting deck from the selected (or default)
   * papers/figures and section switches. The outcome lands in toasts.
   * @param projectId - wiki project id.
   * @param request - the deck options (title/presenter/date/selections).
   * @returns null on success, the settled failure otherwise.
   */
  generateMeetingDeck: (
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
  ) => Promise<ResearchFailureView | null>
  /**
   * Delete one generated meeting deck.
   * @param projectId - wiki project id.
   * @param file - the deck file name within the project's meetings directory.
   * @returns null on success, the settled failure otherwise.
   */
  deleteMeetingDeck: (projectId: string, file: string) => Promise<ResearchFailureView | null>
  /**
   * Fetch the image-generation config (the masked panel view) once, on the
   * meetings view's first open; a ready slice or in-flight load is left alone.
   */
  getImageGenConfig: () => void
  /**
   * Save the image-generation config; the store's masked view refreshes from
   * the response. An omitted `apiKey` keeps the stored key, '' clears it.
   * @param input - the editable fields (baseUrl/model/size/apiKey).
   * @returns null on success, the settled failure otherwise.
   */
  saveImageGenConfig: (input: {
    baseUrl?: string | undefined
    apiKey?: string | undefined
    model?: string | undefined
    size?: string | undefined
  }) => Promise<ResearchFailureView | null>
  /** Fetch and save the native sxng-cli configuration used by Web search. */
  getSxngConfig: () => void
  saveSxngConfig: (input: {
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
  }) => Promise<ResearchFailureView | null>
  /**
   * Rename one figure of one project (same extension); the host moves the
   * metadata row along and rewrites the paper's `.tex` references. The
   * outcome lands in toasts.
   * @param projectId - wiki project id.
   * @param relPath - figure path relative to the paper directory.
   * @param newName - the new bare file name.
   * @returns null on success, the settled failure otherwise.
   */
  renameFigure: (projectId: string, relPath: string, newName: string) => Promise<ResearchFailureView | null>
  /**
   * Replace one figure's wiki-recorded caption, then quietly rescan.
   * @param projectId - wiki project id.
   * @param relPath - figure path relative to the paper directory.
   * @param caption - the replacement caption.
   * @returns null on success, the settled failure otherwise.
   */
  updateFigure: (projectId: string, relPath: string, caption: string) => Promise<ResearchFailureView | null>
  /**
   * Insert one figure's standard LaTeX block into the project's `main.tex` —
   * or, when the draft already references the file, just jump there — then
   * switch the workbench to the paper view. Failures surface as toasts.
   * @param projectId - wiki project id.
   * @param entry - the figure card's entry.
   */
  insertFigure: (projectId: string, entry: FigureEntry) => Promise<void>
  /**
   * Generate one metric's comparison chart as a paper figure (the experiments
   * view's per-chart button): save the rendered SVG into the paper's
   * `figures/` directory with a registered caption, insert the LaTeX block,
   * and switch the workbench to the paper view. Failures surface as toasts.
   * @param projectId - wiki project id.
   * @param metricKey - the metric the chart compares.
   * @param rows - the chart's rows (runs carrying a finite value, oldest first).
   */
  generateMetricFigure: (projectId: string, metricKey: string, rows: readonly MetricChartRow[]) => Promise<void>
  /** Clear the paper view's consumed jump ticket. */
  consumePaperJump: () => void
  /**
   * Delete one experiment record, dropping its row from the loaded slice.
   * @param id - experiment record id.
   * @returns null on success, the settled failure otherwise.
   */
  deleteExperiment: (id: string) => Promise<ResearchFailureView | null>
  /**
   * Relink one experiment to a server (null clears the link).
   * @param id - experiment record id.
   * @param serverId - the server to link, or null to clear.
   * @returns null on success, the settled failure otherwise.
   */
  updateExperiment: (id: string, serverId: string | null) => Promise<ResearchFailureView | null>
  /**
   * Create or update one experiment from the inline form.
   * @param experiment - the full-field upsert payload; `id` present updates.
   * @returns null on success, the settled failure otherwise.
   */
  saveExperiment: (experiment: ExperimentInput) => Promise<ResearchFailureView | null>
  /**
   * Partially update one paper's tags, project links, and notes.
   * @param arxivId - the bare arXiv id.
   * @param patch - the fields to replace; omitted fields stay untouched.
   * @returns null on success, the settled failure otherwise.
   */
  updatePaper: (
    arxivId: string,
    patch: { tags?: string[]; projectIds?: string[]; notes?: string },
  ) => Promise<ResearchFailureView | null>
  /**
   * Download one paper's arXiv PDF into the workspace and link it on the
   * record, then refresh the literature list.
   * @param arxivId - the bare arXiv id.
   * @returns null on success, the settled failure otherwise.
   */
  fetchPaperPdf: (arxivId: string) => Promise<ResearchFailureView | null>
  /** Probe the Zotero connection once, on the papers view's first open. */
  ensureZotero: () => void
  /** Re-probe the Zotero connection (the section's retry entry). */
  recheckZotero: () => void
  /**
   * Search the configured Zotero library; the outcome lands in the view's
   * `zoteroSearch` slice.
   * @param query - the free-text query; an empty one never leaves the client.
   */
  searchZotero: (query: string) => void
  /**
   * Import one Zotero item into the wiki, then refresh the literature list.
   * @param key - the Zotero item key of one search result row.
   * @param projectId - the selected project to link, when any.
   * @returns null on success, the settled failure otherwise.
   */
  importZoteroItem: (key: string, projectId?: string) => Promise<ResearchFailureView | null>
  /**
   * Export one Zotero collection into one project's `references.bib`.
   * @param projectId - wiki project id.
   * @param collectionKey - the Zotero collection to export.
   * @returns the settled counts on success, the failure view otherwise.
   */
  exportZoteroCollectionToBib: (
    projectId: string,
    collectionKey: string,
  ) => Promise<ResearchFailureView | ResearchImportCounts>
  /** Load the server list once, on the servers view's first open. */
  ensureServers: () => void
  /**
   * Create or update one server, then refresh the list.
   * @param server - the upsert payload; `id` present updates, absent creates.
   * @returns null on success, the settled failure otherwise.
   */
  saveServer: (server: ServerInput) => Promise<ResearchFailureView | null>
  /**
   * Delete one server and its probe state, then refresh the list.
   * @param id - server record id.
   * @returns null on success, the settled failure otherwise.
   */
  deleteServer: (id: string) => Promise<ResearchFailureView | null>
  /**
   * Probe one server (TCP reachability plus the best-effort GPU readout).
   * @param id - server record id.
   */
  checkServer: (id: string) => Promise<void>
  /** Probe every listed server that is not already being probed. */
  checkAllServers: () => void
  /** Load the remote-job list once, on the jobs section's first open. */
  ensureJobs: () => void
  /**
   * Re-poll the remote-job list (the jobs section's interval while any job
   * is queued/running).
   */
  refreshJobs: () => void
  /**
   * Submit one remote command to a server over ssh, optionally linked to an
   * experiment record (its status follows the job's terminal state).
   * @param serverId - server record id.
   * @param command - the remote command line.
   * @param experimentId - the experiment to link, when given.
   * @returns null on success, the settled failure otherwise.
   */
  submitJob: (serverId: string, command: string, experimentId?: string) => Promise<ResearchFailureView | null>
  /**
   * Delete one job record, dropping it from the loaded list.
   * @param id - job record id.
   * @returns null on success, the settled failure otherwise.
   */
  deleteJob: (id: string) => Promise<ResearchFailureView | null>
  /**
   * Load one project's `references.bib` on the bib panel's first open.
   * @param projectId - wiki project id.
   */
  ensureBibliography: (projectId: string) => void
  /** Re-read the open bibliography from the Host (the conflict recovery path). */
  reloadBibliography: () => void
  /**
   * Delete one entry from the open bibliography and commit the file.
   * @param key - the citation key to drop.
   * @returns null on success, the settled failure otherwise.
   */
  deleteBibEntry: (key: string) => Promise<ResearchFailureView | null>
  /**
   * Replace one entry of the open bibliography (the field editor's save) and
   * commit the file.
   * @param originalKey - the citation key the editor opened on.
   * @param entry - the edited entry (its key may differ from `originalKey`).
   * @returns null on success, the settled failure otherwise.
   */
  updateBibEntry: (originalKey: string, entry: BibEntry) => Promise<ResearchFailureView | null>
  /**
   * Append library papers to one project's `references.bib`.
   * @param projectId - wiki project id.
   * @param arxivIds - the papers to append.
   * @returns the settled counts on success, the failure view otherwise.
   */
  importPapersToBib: (
    projectId: string,
    arxivIds: string[],
  ) => Promise<ResearchFailureView | ResearchImportCounts>
  /**
   * List one project's paper snapshots (the snapshots panel's open).
   * @param projectId - wiki project id.
   * @param force - bypass the fresh-view skip (the refresh path).
   */
  loadSnapshots: (projectId: string, force?: boolean) => void
  /**
   * Fetch one snapshot's files for the panel's diff view.
   * @param projectId - wiki project id.
   * @param id - the snapshot id.
   */
  loadSnapshotDetail: (projectId: string, id: string) => void
  /** Close the snapshots panel's diff view. */
  closeSnapshotDetail: () => void
  /**
   * Revert the paper to one snapshot under optimistic concurrency; the source
   * and outline re-read from the Host on success (and on a conflict).
   * @param projectId - wiki project id.
   * @param id - the snapshot id.
   * @returns null on success, the settled failure otherwise.
   */
  revertSnapshot: (projectId: string, id: string) => Promise<ResearchFailureView | null>
  /**
   * Reorder the top-level sections of one project's `main.tex`.
   * @param projectId - wiki project id.
   * @param moves - the drops, applied in order.
   * @param baseOutline - the top-level titles the drag started from.
   * @returns null on success, the settled failure otherwise.
   */
  reorderPaperSections: (
    projectId: string,
    moves: readonly SectionMove[],
    baseOutline: readonly string[],
  ) => Promise<ResearchFailureView | null>
  /**
   * Reorder the subsections of one project's `main.tex`, inside their own
   * section or across sections.
   * @param projectId - wiki project id.
   * @param moves - the drops, applied in order.
   * @param baseOutline - the section/subsection title tree the drag started from.
   * @returns null on success, the settled failure otherwise.
   */
  reorderPaperSubsections: (
    projectId: string,
    moves: readonly SubsectionMove[],
    baseOutline: readonly SectionOutlineTitles[],
  ) => Promise<ResearchFailureView | null>
  /**
   * Load one window of ledger (growth record) events for the ledger view
   * (first open, window/scope switch, refresh).
   * @param filter - the window/scope/order/limit filter the view assembled.
   */
  loadLedger: (filter: ResearchEventFilter) => void
  /**
   * Generate the progress report of one window (the ledger view's button).
   * @param options - the window/scope options the view assembled.
   * @returns null on success, the settled failure view otherwise.
   */
  generateReport: (options: ResearchProgressReportOptions) => Promise<ResearchFailureView | null>
  /**
   * Generate the cognitive brief (CBE roadbook) of one window (the brief
   * card's button): the DDM-lite map plus the user's L2 journal lines.
   * @param options - the window/scope options the view assembled.
   * @returns null on success, the settled failure view otherwise.
   */
  generateBrief: (options: ResearchGenerateBriefOptions) => Promise<ResearchFailureView | null>
  /**
   * Write one L2 journal line into the ledger (the journal box's submit) —
   * the user's own words, read back by the brief, never weighed as evidence.
   * @param text - the entry's text (non-blank, capped server-side).
   * @param projectId - the project scope, or null for an unscoped entry.
   * @param refs - optional line ref (`ideaId`, the boundary-question answer
   * path) and 1–5 self-reported `valence`/`arousal` ratings.
   * @returns null on success, the settled failure view otherwise.
   */
  addJournal: (
    text: string,
    projectId: string | null,
    refs?: { ideaId?: string | undefined; valence?: number | undefined; arousal?: number | undefined; question?: ResearchJournalQuestionRef | undefined },
  ) => Promise<ResearchFailureView | null>
  /**
   * Load the worktree (S2) once, on the ledger view's first open: the
   * research process as branches, dead ends, and the mainline ref.
   */
  ensureWorktree: () => void
  /** Re-fetch the worktree (the card's refresh button, or after a write). */
  refreshWorktree: () => void
  /**
   * Move the mainline ref — the user's explicit declaration of the current
   * mainline (the system never ranks lines into it).
   * @param lineId - idea id or `project:<id>`.
   * @returns null on success, the settled failure view otherwise.
   */
  setMainline: (lineId: string) => Promise<ResearchFailureView | null>
  /**
   * Declare (or clear, with null) one derivation edge — a branch point in
   * the surveyor's own words; never inferred.
   * @returns null on success, the settled failure view otherwise.
   */
  setIdeaParent: (ideaId: string, parentIdeaId: string | null) => Promise<ResearchFailureView | null>
  /**
   * Declare the merge — adopt one idea line (✓); only an active line can
   * be merged, and a merge is written once.
   * @returns null on success, the settled failure view otherwise.
   */
  adoptIdea: (ideaId: string) => Promise<ResearchFailureView | null>
  /**
   * Close one idea lane as a dead end — a documented No with its one-line
   * lesson; dead ends are never pruned from the tree.
   * @returns null on success, the settled failure view otherwise.
   */
  closeIdea: (ideaId: string, reason: string) => Promise<ResearchFailureView | null>
  /**
   * Load the foraging layer (S4) once, on the ledger view's first open.
   */
  ensureForaging: () => void
  /**
   * Re-fetch the foraging layer (the card's refresh button).
   */
  refreshForaging: () => void
  /**
   * Load the moments timeline (S9b) once, on the ledger view's first open.
   */
  ensureMoments: () => void
  /**
   * Re-fetch the moments timeline (the card's refresh button).
   */
  refreshMoments: () => void
  /**
   * Decline one moment candidate — seen and refused (a `pinned:false`
   * declaration on a never-canonical candidate).
   * @returns null on success, the settled failure view otherwise.
   */
  declineMoment: (targetEventId: string) => Promise<ResearchFailureView | null>
  /**
   * Load the digest (B–F) once, on the ledger view's first open (active push).
   */
  ensureDigest: () => void
  /** Re-fetch the digest at its current tier/lang (the card's refresh button). */
  refreshDigest: () => void
  /**
   * Generate the digest at one tier/language (the card's tier/lang switch).
   * @param tier - weekly / monthly / project.
   * @param lang - zh / en.
   * @returns null on success, the settled failure view otherwise.
   */
  generateDigest: (tier: 'weekly' | 'monthly' | 'project', lang: 'zh' | 'en') => Promise<ResearchFailureView | null>
  /**
   * Declare one Eureka — the researcher's own named milestone (never system
   * declared, never prompted). Exactly one ref is required.
   * @returns null on success, the settled failure view otherwise.
   */
  setEureka: (
    ideaId: string | undefined,
    projectId: string | undefined,
    title: string,
  ) => Promise<ResearchFailureView | null>
  /**
   * Pin (or unpin) one moment — the explicit bookmark of a curated instant.
   * @returns null on success, the settled failure view otherwise.
   */
  pinMoment: (targetEventId: string, note?: string | undefined) => Promise<ResearchFailureView | null>
  /**
   * Export the whole wiki as one snapshot (the download button).
   * @returns the snapshot, or the settled failure view.
   */
  exportWiki: () => Promise<ResearchWikiSnapshot | ResearchFailureView>
  /**
   * Import one parsed snapshot; a successful import re-fetches every loaded
   * slice before resolving.
   * @param snapshot - the parsed export JSON (revalidated host-side).
   * @param mode - `merge` skips existing keys; `replace` wipes first.
   * @param confirmReplace - must be true for `replace`.
   * @returns the per-table counts, or the settled failure view.
   */
  importWiki: (
    snapshot: unknown,
    mode: ResearchImportWikiMode,
    confirmReplace: boolean,
  ) => Promise<{ imported: Record<string, number>; skipped: Record<string, number> } | ResearchFailureView>
  /** Remove one toast from the corner stack (the × button). @param id - toast id. */
  dismissToast: (id: number) => void
  /** Sweep expired toasts (the toast host's expiry timer). */
  pruneToasts: () => void
}

/** Full props of the sidebar-footer research toggle. */
export type ResearchToggleProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ResearchPanelStore>
  & PropsLocale<'research'>

/** Full props of the research panel overlay entry. */
export type ResearchPanelProps =
  PropsRuntime<'shell.overlay'>
  & PropsStore<ResearchPanelStore>
  & InjectFace<ResearchPanelInjected>
  & PropsLocale<'research'>
