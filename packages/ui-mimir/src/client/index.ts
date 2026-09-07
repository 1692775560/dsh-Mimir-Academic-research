/**
 * Research panel plugin, browser half: a sidebar-footer toggle and the
 * frame-level overlay it opens. One ResearchController per client runtime
 * backs the panel; one store handle is shared by both registrations so the
 * toggle and the panel read the same open/selection state. Both target seats
 * are declared by other packages (ui-sidebar, ui-layout), so both
 * registrations go through `slots.inject` and wait on the declaration.
 * @module dsh-client-ui-mimir/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Client assembly's ctx.remote merge (TypertClientRemote).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Runtime + types: the generated research Remote contribution. The panel
// mounts the namespace itself (see apply): the published dsh-api-remotes
// assembly does not carry it, and the bundle preset inlines generated
// `/remote` modules, so no module-table row is needed.
import researchRemote from 'dsh-mimir/remote'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the theme plugin's Context merge (ctx.theme).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: pulls the renderer-owned SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ResearchController } from './controller.ts'
import { ResearchPanel } from './ResearchPanel.tsx'
import { ResearchToggle } from './ResearchToggle.tsx'
import type { ResearchPanelInjected } from './slots.ts'
import { nextColorScheme, nextLocale, type WorkbenchChrome } from './shortcuts.ts'
import { createResearchPanelStore } from './store.ts'
import { en, zh, type ResearchKey } from './locales.ts'

export type {
  ResearchArtifactView, ResearchBibView, ResearchCompileView, ResearchFailureView,
  ResearchImportCounts, ResearchJobsView, ResearchLedgerView, ResearchLoadStatus,
  ResearchOutlineView, ResearchPapersView, ResearchProjectSlice, ResearchRemote,
  ResearchReportView, ResearchSaveState, ResearchSnapshotDetailView, ResearchSourceView,
  ResearchSubscriptionsView, ResearchView, ResearchZoteroSearchView, ResearchZoteroView,
} from './controller.ts'
export type {
  ResearchPanelInjected, ResearchPanelProps, ResearchPanelStore, ResearchToggleProps,
} from './slots.ts'
export type { ResearchPanelState, ResearchTab } from './store.ts'
export { createResearchPanelStore } from './store.ts'
export type { WorkbenchChrome } from './shortcuts.ts'
export type { ResearchKey } from './locales.ts'
export {
  ACTOR_KEYS, LEDGER_LIST_LIMIT, LEDGER_WINDOWS,
  ledgerIsDestructive, ledgerPayloadLine, ledgerTimeParts, ledgerWindowFilter,
  reportFileName, reportWindowOptions,
  type LedgerTimeParts, type LedgerWindow,
} from './ledger-view.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'research'

/** Required services: the slot registry, the Remote carrier, the sessions domain, the copy, and the theme preference. `remote.research` is NOT listed: this module mounts that namespace itself, and an inject entry would make the loader wait for a service that only this module can create. */
export const inject = ['slots', 'remote', 'sessions', 'locale', 'theme']

/**
 * Upload one figure file through the host's upload route. The route answers
 * JSON on success; anything else throws with the response's own text.
 * @param projectId - wiki project id.
 * @param dir - the project's paper directory override, when any.
 * @param file - the picked file.
 * @returns resolution after the file is stored.
 */
async function uploadOneFigure(projectId: string, dir: string | undefined, file: File): Promise<void> {
  const query = `?project=${encodeURIComponent(projectId)}&name=${encodeURIComponent(file.name)}`
    + (dir === undefined ? '' : `&dir=${encodeURIComponent(dir)}`)
  const response = await fetch(`/research/figure-upload${query}`, { method: 'POST', body: file })
  if (!response.ok) {
    const detail = (await response.text()).trim()
    throw new Error(detail === '' ? `upload failed (${String(response.status)})` : detail)
  }
}

/**
 * Upload one venue-kit file through the host's template upload route. The
 * route answers JSON on success; anything else throws with the response's
 * own text.
 * @param projectId - wiki project id.
 * @param dir - the project's paper directory override, when any.
 * @param file - the picked file.
 * @returns resolution after the file is stored.
 */
async function uploadOneTemplateFile(projectId: string, dir: string | undefined, file: File): Promise<void> {
  const query = `?project=${encodeURIComponent(projectId)}&name=${encodeURIComponent(file.name)}`
    + (dir === undefined ? '' : `&dir=${encodeURIComponent(dir)}`)
  const response = await fetch(`/research/template-upload${query}`, { method: 'POST', body: file })
  if (!response.ok) {
    const detail = (await response.text()).trim()
    throw new Error(detail === '' ? `upload failed (${String(response.status)})` : detail)
  }
}

/**
 * Client plugin body: mounts the research Remote namespace, then loads the
 * panel as a nested plugin that injects it. Stock dsh distributions do not
 * carry the research namespace in their Remote assembly, so the panel must
 * mount it itself; cordis only hands a service to fibers that inject it, and
 * an inject entry on THIS module would deadlock (the loader would wait for a
 * service only this module creates). The nested plugin is created after the
 * mount settles, so its inject resolves immediately.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  void (async () => {
    const unmountResearch = await ctx.remote.$mount(researchRemote)
    ctx.effect(() => unmountResearch, 'ui-mimir: research remote')
    ctx.plugin({
      name: 'dsh-client-ui-mimir/panel',
      inject: ['slots', 'remote.research', 'sessions', 'locale', 'theme'],
      apply: panelApply,
    })
  })().catch((error: unknown) => {
    console.error('[dsh-mimir] failed to mount the research remote:', error)
  })
}

/**
 * The research panel proper: the toggle, the overlay, and the shared object
 * layer. Runs in the nested fiber where `remote.research` is injected.
 * @param ctx - nested plugin context with the research namespace injected.
 */
function panelApply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mimir: dictionaries')

  // The browser `ctx.sessions` is the client runtime's ISessions, but the
  // host-side dsh-session package (pulled in by dsh-mimir's types) merges the
  // same Context key with its own SessionStore, and in this mixed program
  // that declaration wins — narrow explicitly.
  const sessions = ctx.sessions as unknown as ISessions

  const panel = createResearchPanelStore()
  const controller = new ResearchController(ctx.remote.research)

  // The header chrome snapshot adapts the host theme/locale services into one
  // HostObservable. Both services emit change events on this context's root;
  // the snapshot keeps reference identity while neither value moved, so the
  // selector hook never re-renders on an unrelated theme registry bump.
  let chromeSnapshot: WorkbenchChrome = {
    dark: ctx.theme.getTheme().active.colorScheme === 'dark',
    locale: ctx.locale.getLocale().active,
  }
  const chromeListeners = new Set<() => void>()
  const onChromeChange = (): void => {
    const next: WorkbenchChrome = {
      dark: ctx.theme.getTheme().active.colorScheme === 'dark',
      locale: ctx.locale.getLocale().active,
    }
    if (next.dark === chromeSnapshot.dark && next.locale === chromeSnapshot.locale) return
    chromeSnapshot = Object.freeze(next)
    for (const listener of [...chromeListeners]) listener()
  }
  ctx.on('theme/change', onChromeChange)
  ctx.on('locale/change', onChromeChange)
  const chrome = {
    getSnapshot: (): WorkbenchChrome => chromeSnapshot,
    subscribe: (listener: () => void): (() => void) => {
      chromeListeners.add(listener)
      return () => { chromeListeners.delete(listener) }
    },
  }

  // A reconnect can only invalidate what was already read; a cold panel stays
  // cold until the first open asks for it.
  ctx.on('connection/reset', () => { controller.resync() })
  ctx.effect(() => () => { controller.dispose() }, 'ui-mimir: controller')

  // Live refresh: the host pushes every wiki write over /research/events and
  // the controller re-reads the dirtied slices through the usual guarded
  // loaders — no more F5 after the agent edits the wiki. A hidden tab lets
  // the debounce accumulate; coming back to the foreground flushes at once.
  controller.connectWikiEvents()
  if (typeof document !== 'undefined') {
    const onVisible = (): void => {
      if (!document.hidden) controller.flushWikiChanges()
    }
    document.addEventListener('visibilitychange', onVisible)
    ctx.effect(
      () => () => document.removeEventListener('visibilitychange', onVisible),
      'ui-mimir: visibility flush',
    )
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'research',
    order: 10,
    store: panel,
    locale: NS,
  }, ResearchToggle))

  // Queue one assembled prompt as one user message in the current session.
  // Shared by the "fix with AI", "draft related work", "score relevance", and
  // "organize figure" buttons; the agent's edits land on disk or in the wiki
  // and the panel's reload/poll flow takes it from there.
  const sendPromptToCurrentSession = async (
    prompt: string,
    sentCopy: ResearchKey,
    failedCopy: ResearchKey,
  ): Promise<void> => {
    const current = sessions.list.getSnapshot().current
    const binding = current === undefined ? undefined : sessions.binding(current)
    if (binding === undefined) {
      controller.notify('error', 'toast.fixNoSession')
      return
    }
    try {
      const result = await binding.session.prompt([{ type: 'text', text: prompt }], 'queue')
      if (result.ok) controller.notify('success', sentCopy)
      else controller.notify('error', failedCopy, result.error.message)
    } catch (error) {
      controller.notify('error', failedCopy, error instanceof Error ? error.message : String(error))
    }
  }

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'research',
    order: 10,
    store: panel,
    locale: NS,
    inject: (actions): ResearchPanelInjected => ({
      hooks: { research: controller, chrome },
      toggleTheme: () => { ctx.theme.setTheme(nextColorScheme(chromeSnapshot.dark)) },
      toggleLocale: () => { ctx.locale.setLocale(nextLocale(chromeSnapshot.locale)) },
      ensure: () => { controller.ensure() },
      // The row click is the single selection entry: it writes the shared
      // store and fetches the outline + compile status in one gesture.
      selectProject: (projectId) => {
        actions.select(projectId)
        controller.select(projectId)
      },
      // The project list's import dialog: a successful import lands selected.
      importProject: async (path, title) => {
        const outcome = await controller.importProject(path, title)
        if ('code' in outcome) return outcome
        actions.select(outcome.projectId)
        controller.select(outcome.projectId)
        return outcome
      },
      compile: (projectId) => { void controller.compile(projectId) },
      // The per-issue "fix with AI" button.
      requestCompileFix: prompt => sendPromptToCurrentSession(prompt, 'toast.fixSent', 'toast.fixSendFailed'),
      // The papers view's "draft related work" button: same session channel.
      requestRelatedWork: prompt => sendPromptToCurrentSession(prompt, 'toast.relworkSent', 'toast.relworkSendFailed'),
      // The papers view's "score relevance with AI" buttons: same channel.
      requestPaperScore: prompt => sendPromptToCurrentSession(prompt, 'toast.scoreSent', 'toast.scoreSendFailed'),
      // The figures view's "organize with AI" button: same channel.
      requestFigureOrganize: prompt => sendPromptToCurrentSession(prompt, 'toast.figureOrganizeSent', 'toast.figureOrganizeSendFailed'),
      // The paper view's venue picker and "format to venue" button.
      ensureVenueTemplates: () => { controller.ensureVenueTemplates() },
      applyVenueTemplate: (projectId, options) => controller.applyVenueTemplate(projectId, options),
      clearVenueTemplate: projectId => controller.clearVenueTemplate(projectId),
      // The venues view (ccfddl catalog + the selected project's watch list).
      ensureVenues: projectId => { controller.ensureVenues(projectId) },
      refreshVenues: projectId => { controller.refreshVenues(projectId) },
      refreshVenueCatalog: projectId => controller.refreshVenueCatalog(projectId),
      toggleVenueWatch: seriesKey => controller.toggleVenueWatch(seriesKey),
      uploadTemplateFiles: async (projectId, dir, files) => {
        let done = 0
        for (const file of files) {
          await uploadOneTemplateFile(projectId, dir, file)
          done += 1
        }
        if (done > 0) controller.notify('success', 'toast.templateUploaded', `× ${done}`)
      },
      requestVenueFormat: prompt => sendPromptToCurrentSession(prompt, 'toast.venueFormatSent', 'toast.venueFormatSendFailed'),
      editSource: (content) => { controller.edit(content) },
      reloadSource: () => { controller.reloadSource() },
      ensurePapers: () => { controller.ensurePapers() },
      refreshPapers: () => { controller.refreshPapers() },
      ensureSubscriptions: () => { controller.ensureSubscriptions() },
      saveArxivSubscription: query => controller.saveArxivSubscription(query),
      deleteArxivSubscription: id => controller.deleteArxivSubscription(id),
      checkArxivSubscriptions: () => controller.checkArxivSubscriptions(),
      searchArxiv: (query) => { controller.searchArxiv(query) },
      searchWeb: (query) => { controller.searchWeb(query) },
      importPaper: (entry, projectId) => controller.importPaper(entry, projectId),
      removePaper: (arxivId) => controller.removePaper(arxivId),
      updatePaper: (arxivId, patch) => controller.updatePaper(arxivId, patch),
      fetchPaperPdf: (arxivId) => controller.fetchPaperPdf(arxivId),
      ensureZotero: () => { controller.ensureZotero() },
      recheckZotero: () => { controller.recheckZotero() },
      searchZotero: (query) => { controller.searchZotero(query) },
      importZoteroItem: (key, projectId) => controller.importZoteroItem(key, projectId),
      exportZoteroCollectionToBib: (projectId, collectionKey) =>
        controller.exportZoteroCollectionToBib(projectId, collectionKey),
      loadArtifact: (projectId, name) => { controller.loadArtifact(projectId, name) },
      loadFigures: (projectId, force, quiet) => { controller.loadFigures(projectId, force, quiet) },
      uploadFigures: async (projectId, dir, files, onProgress) => {
        let done = 0
        for (const file of files) {
          await uploadOneFigure(projectId, dir, file)
          done += 1
          onProgress?.(done, files.length)
        }
        controller.loadFigures(projectId, true)
        if (done > 0) controller.notify('success', 'toast.figuresUploaded', `× ${done}`)
      },
      deleteFigure: (projectId, relPath) => controller.deleteFigure(projectId, relPath),
      loadMeetings: (projectId, force) => { controller.loadMeetings(projectId, force) },
      generateMeetingDeck: (projectId, request) => controller.generateMeetingDeck(projectId, request),
      deleteMeetingDeck: (projectId, file) => controller.deleteMeetingDeck(projectId, file),
      getImageGenConfig: () => { controller.getImageGenConfig() },
      saveImageGenConfig: input => controller.saveImageGenConfig(input),
      getSxngConfig: () => { controller.getSxngConfig() },
      saveSxngConfig: input => controller.saveSxngConfig(input),
      renameFigure: (projectId, relPath, newName) => controller.renameFigure(projectId, relPath, newName),
      updateFigure: (projectId, relPath, caption) => controller.updateFigure(projectId, relPath, caption),
      // A successful insert (or the duplicate's jump) lands in the paper view.
      insertFigure: async (projectId, entry) => {
        const line = await controller.insertFigureIntoPaper(projectId, entry)
        if (line !== null) actions.setTab('paper')
      },
      // The metric chart's paper-figure button rides the same insert path.
      generateMetricFigure: async (projectId, metricKey, rows) => {
        const line = await controller.generateMetricFigure(projectId, metricKey, rows)
        if (line !== null) actions.setTab('paper')
      },
      consumePaperJump: () => { controller.consumePaperJump() },
      deleteExperiment: (id) => controller.deleteExperiment(id),
      updateExperiment: (id, serverId) => controller.updateExperiment(id, serverId),
      saveExperiment: experiment => controller.saveExperiment(experiment),
      ensureServers: () => { controller.ensureServers() },
      saveServer: (server) => controller.saveServer(server),
      deleteServer: (id) => controller.deleteServer(id),
      checkServer: (id) => controller.checkServer(id),
      checkAllServers: () => { void controller.checkAllServers() },
      ensureJobs: () => { controller.ensureJobs() },
      refreshJobs: () => { controller.refreshJobs() },
      submitJob: (serverId, command, experimentId) => controller.submitJob(serverId, command, experimentId),
      deleteJob: (id) => controller.deleteJob(id),
      ensureBibliography: (projectId) => { controller.ensureBibliography(projectId) },
      reloadBibliography: () => { controller.reloadBibliography() },
      deleteBibEntry: key => controller.deleteBibEntry(key),
      updateBibEntry: (originalKey, entry) => controller.updateBibEntry(originalKey, entry),
      importPapersToBib: (projectId, arxivIds) => controller.importPapersToBib(projectId, arxivIds),
      loadSnapshots: (projectId, force) => { controller.loadSnapshots(projectId, force) },
      loadSnapshotDetail: (projectId, id) => { controller.loadSnapshotDetail(projectId, id) },
      closeSnapshotDetail: () => { controller.closeSnapshotDetail() },
      revertSnapshot: (projectId, id) => controller.revertSnapshot(projectId, id),
      reorderPaperSections: (projectId, moves, baseOutline) =>
        controller.reorderPaperSections(projectId, moves, baseOutline),
      reorderPaperSubsections: (projectId, moves, baseOutline) =>
        controller.reorderPaperSubsections(projectId, moves, baseOutline),
      loadLedger: filter => { controller.loadLedger(filter) },
      generateReport: options => controller.generateReport(options),
      generateBrief: options => controller.generateBrief(options),
      addJournal: (text, projectId, refs) => controller.addJournal(text, projectId, refs),
      ensureWorktree: () => { controller.ensureWorktree() },
      refreshWorktree: () => { controller.refreshWorktree() },
      setMainline: lineId => controller.setMainline(lineId),
      setIdeaParent: (ideaId, parentIdeaId) => controller.setIdeaParent(ideaId, parentIdeaId),
      adoptIdea: ideaId => controller.adoptIdea(ideaId),
      closeIdea: (ideaId, reason) => controller.closeIdea(ideaId, reason),
      ensureForaging: () => { controller.ensureForaging() },
      refreshForaging: () => { controller.refreshForaging() },
      ensureMoments: () => { controller.ensureMoments() },
      refreshMoments: () => { void controller.refreshMoments() },
      declineMoment: targetEventId => controller.declineMoment(targetEventId),
      ensureDigest: () => { controller.ensureDigest() },
      refreshDigest: () => { controller.refreshDigest() },
      generateDigest: (tier, lang) => controller.generateDigest(tier, lang),
      setEureka: (ideaId, projectId, title) => controller.setEureka(ideaId, projectId, title),
      pinMoment: (targetEventId, note) => controller.pinMoment(targetEventId, note),
      exportWiki: () => controller.exportWiki(),
      importWiki: (snapshot, mode, confirmReplace) => controller.importWiki(snapshot, mode, confirmReplace),
      dismissToast: (id) => { controller.dismissToast(id) },
      pruneToasts: () => { controller.pruneToasts() },
    }),
  }, ResearchPanel))
}
