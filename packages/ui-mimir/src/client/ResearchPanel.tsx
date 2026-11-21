/**
 * The research workbench, now a full page rather than a dialog: a left rail
 * (the nine view tabs plus the project picker at the bottom) and a content
 * area that
 * renders the active view — the project overview card, the Overleaf-style
 * paper editor, the literature library, the experiment records with the
 * experiment log, the paper-figure grid, the group-meeting deck builder,
 * the compute-server board, the ledger (the transparent growth record:
 * timeline + progress report), and the venues view (the ccfddl conference
 * catalog with its per-project watch list plus the CCF-A journal directory). All
 * data arrives through the four props shares — the shared store carries the
 * selection and active tab, the `useResearch` hook carries the remote view,
 * and the inject face carries the verbs. The component owns no subscription
 * machinery.
 * @module dsh-client-ui-mimir/client/ResearchPanel
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { ResearchTab } from './store.ts'
import type { ResearchKey } from './locales.ts'
import { arrowTab } from './focus.ts'
import { cleanProjectTitle, nextSelectionAfterDelete } from './project-form.ts'
import { failureCopy } from './view-common.ts'
import type { ResearchCapabilitySet, ResearchFailureView } from './controller.ts'
import { readSidebarFolded, SIDEBAR_FOLD_STORAGE_KEY, sidebarFoldStorageValue } from './sidebar-fold.ts'
import { readStorageFlag, readStorageValue, storageFlagValue, writeStorageValue } from './storage.ts'
import { countUpcomingDeadlines } from './venues-view.ts'
import { LOAD_MATRIX, SLICES_BY_TAB } from './slice-policy.ts'
import type { ResearchPanelProps } from './slots.ts'
import type { ResearchCapability } from 'dsh-mimir/types'
import { OverviewView } from './OverviewView.tsx'
import { PaperView } from './PaperView.tsx'
import { PapersView } from './PapersView.tsx'
import { ExperimentsView } from './ExperimentsView.tsx'
import { FiguresView } from './FiguresView.tsx'
import { MeetingsView } from './MeetingsView.tsx'
import { ServersView } from './ServersView.tsx'
import { LedgerView } from './LedgerView.tsx'
import { VenuesView } from './VenuesView.tsx'
import { ToastHost } from './ToastHost.tsx'
import { ImportProjectDialog } from './ImportProjectDialog.tsx'
import css from './ResearchPanel.module.css'

/** Locale key of one tab label. */
/** One rail tab; shared by the main path and the "More" list (#243). */
function NavTab({ tab, activeTab, count, setTab, t }: {
  readonly tab: ResearchTab
  readonly activeTab: ResearchTab
  readonly count: number | null | undefined
  readonly setTab: (tab: ResearchTab) => void
  readonly t: (key: ResearchKey) => string
}): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      className={css.navItem}
      data-active={tab === activeTab || undefined}
      aria-selected={tab === activeTab}
      title={t(TAB_KEYS[tab])}
      onClick={() => { setTab(tab) }}
    >
      <span className={css.navIcon} aria-hidden>{TAB_ICONS[tab]}</span>
      <span className={css.navLabel}>{t(TAB_KEYS[tab])}</span>
      {count !== undefined && count !== null && (
        <span className={css.navCount} aria-label={String(count)}>{count}</span>
      )}
    </button>
  )
}

/**
 * The rail in two tiers (#243): the research main path stays on the first
 * level, the low-frequency tools sit behind one "More" affordance.
 *
 * The split is by capability layer — `core` and `presentation` are the path a
 * paper actually travels (read, write, look at, present); `automation`,
 * `compute` and `insights` are instruments reached for occasionally. Tying
 * the fold to the layer keeps it honest: a view added to a core layer lands on
 * the main path without anyone editing a list here.
 */
const PRIMARY_CAPABILITIES: ReadonlySet<ResearchCapability> = new Set<ResearchCapability>(['core', 'presentation'])

/** A capability-gated rail split into two tiers. */
export interface RailTiers {
  /** Tabs on the first level, in rail order. */
  readonly primary: readonly ResearchTab[]
  /** Tabs behind the "More" affordance, in rail order. */
  readonly secondary: readonly ResearchTab[]
}

/**
 * Split a capability-gated rail into its two tiers.
 * @param capabilities - the enabled layers; null means "not known yet".
 * @returns both tiers, each in rail order, partitioning `visibleTabs`.
 */
export function railTiers(capabilities: ResearchCapabilitySet): RailTiers {
  const primary: ResearchTab[] = []
  const secondary: ResearchTab[] = []
  for (const tab of visibleTabs(capabilities)) {
    const target = PRIMARY_CAPABILITIES.has(TAB_CAPABILITY[tab]) ? primary : secondary
    target.push(tab)
  }
  return { primary: Object.freeze(primary), secondary: Object.freeze(secondary) }
}

const TAB_KEYS: Record<ResearchTab, ResearchKey> = {
  overview: 'tab.overview',
  paper: 'tab.paper',
  papers: 'tab.papers',
  experiments: 'tab.experiments',
  figures: 'tab.figures',
  meetings: 'tab.meetings',
  servers: 'tab.servers',
  ledger: 'tab.ledger',
  venues: 'tab.venues',
}

/**
 * Which capability layer each view belongs to (#242). A view whose layer the
 * host disabled is absent from the rail: the audit's complaint was that
 * switched-off product domains still occupy the main path, and a greyed-out
 * tab occupies it just the same.
 *
 * `insights` covers the views that read the growth record rather than the
 * paper: the ledger and the briefing surfaces inside Overview. It maps to the
 * bundled-skills switch because insights are what that layer contributes —
 * writing the panel's views into a layer of their own would add a sixth switch
 * nobody asked for.
 */
const TAB_CAPABILITY: Record<ResearchTab, ResearchCapability> = {
  overview: 'core',
  paper: 'core',
  papers: 'core',
  experiments: 'core',
  figures: 'presentation',
  meetings: 'presentation',
  venues: 'automation',
  servers: 'compute',
  ledger: 'insights',
}

/** The rail order: main-path views first, then the capability-gated ones. */
const TAB_ORDER: readonly ResearchTab[] = Object.freeze([
  'overview', 'paper', 'papers', 'experiments', 'figures', 'meetings', 'venues', 'servers', 'ledger',
])

/**
 * The views this panel may render, given the host's enabled layers.
 *
 * `capabilities` is null until `getCapabilities` answers; the full rail is the
 * right answer then, because hiding a view on a request that has not failed is
 * worse than showing one that a later answer removes.
 * @param capabilities - enabled layers, or null while unknown.
 * @returns the visible tabs in rail order.
 */
export function visibleTabs(capabilities: ResearchCapabilitySet): readonly ResearchTab[] {
  if (capabilities === null) return TAB_ORDER
  return TAB_ORDER.filter(tab => capabilities.has(TAB_CAPABILITY[tab]))
}

/** One 16×16 stroke icon per tab, painted in the nav item's currentColor. */
const TAB_ICONS: Record<ResearchTab, ReactNode> = {
  overview: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  ),
  paper: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3" />
      <path d="M6 8.5h4M6 11h4" />
    </svg>
  ),
  papers: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 2h6a1 1 0 0 1 1 1v11l-4-2.6L4 14V3a1 1 0 0 1 1-1z" />
    </svg>
  ),
  experiments: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 1.5h3" />
      <path d="M7 1.5v4L3.6 12a1.5 1.5 0 0 0 1.3 2.2h6.2a1.5 1.5 0 0 0 1.3-2.2L9 5.5v-4" />
      <path d="M5 10.5h6" />
    </svg>
  ),
  figures: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="5.5" cy="6.5" r="1" />
      <path d="M2 11.5 5.5 8l2.5 2.5L10.5 8 14 11.5" />
    </svg>
  ),
  meetings: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2" width="13" height="9" rx="1.5" />
      <path d="M8 11v2.5M5.5 14.5h5" />
      <path d="M4.5 8.5l2-2 2 1.5 3-3" />
    </svg>
  ),
  servers: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
      <path d="M5 4.75h.01M5 11.25h.01" />
    </svg>
  ),
  ledger: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="1.5" width="11" height="13" rx="1.5" />
      <path d="M5.5 5h5M5.5 8h5M5.5 11h3" />
    </svg>
  ),
  venues: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" />
      <path d="M1.5 6h13M5 1.5v2M11 1.5v2" />
      <path d="M4.5 9h3M4.5 11.5h5" />
    </svg>
  ),
}

/** localStorage key the sidebar project-list fold persists under. */
const PROJECTS_COLLAPSED_STORAGE_KEY = 'mimir.sideProjects.collapsed'

/** 10×10 disclosure chevron, rotated by the consumer's data attribute. */
const CHEVRON_ICON = (
  <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 3.5 5 6l2.5-2.5" />
  </svg>
)

/** 16×16 double chevron pointing at the rail fold direction (rotated while folded). */
const FOLD_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 3.5 6 8l3.5 4.5" />
    <path d="M12.5 3.5 9 8l3.5 4.5" />
  </svg>
)

/**
 * The research workbench page. The host mounts it only while its sidebar row is
 * selected, so it renders whenever it is mounted: no open/close flag, no
 * backdrop, no focus trap, and no keydown of its own.
 * @param props - the shared panel store, the injected research face, and copy.
 * @returns the workbench.
 */
export function ResearchPanel({
  useStore, actions, useResearch, useChrome, useSessionList,
  ensure, loadSlice, setSelectedProjectId, selectProject, importProject, createProject, renameProject, deleteProject,
  selectSession, compile, editSource, reloadSource, requestCompileFix,
  requestRelatedWork, requestPaperScore, requestFigureOrganize,
  ensurePapers, refreshPapers, searchArxiv, searchWeb, importPaper, removePaper, updatePaper, fetchPaperPdf, loadFigures, uploadFigures, deleteFigure,
  renameFigure, updateFigure,
  saveArxivSubscription, deleteArxivSubscription, checkArxivSubscriptions,
  recheckZotero, searchZotero, importZoteroItem, exportZoteroCollectionToBib,
  insertFigure, consumePaperJump, generateMetricFigure,
  deleteExperiment, updateExperiment, saveExperiment, ensureServers, saveServer, deleteServer, checkServer, checkAllServers,
  ensureJobs, refreshJobs, submitJob, deleteJob,
  ensureBibliography, reloadBibliography, deleteBibEntry, updateBibEntry, importPapersToBib, reorderPaperSections, reorderPaperSubsections,
  loadSnapshots, loadSnapshotDetail, closeSnapshotDetail, revertSnapshot,
  ensureVenueTemplates, applyVenueTemplate, clearVenueTemplate, uploadTemplateFiles, requestVenueFormat,
  refreshVenues, refreshVenueCatalog, toggleVenueWatch,
  loadMeetings, generateMeetingDeck, deleteMeetingDeck, getImageGenConfig, saveImageGenConfig,
  loadLedger, generateReport, generateBrief, addJournal,
  ensureWorktree, refreshWorktree, setMainline, setIdeaParent, adoptIdea, closeIdea,
  ensureForaging, refreshForaging,
  ensureMoments, refreshMoments, declineMoment,
  loadEvidenceGraph, refreshEvidenceGraph, retractEvidence,
  ensureEureka, ensureDigest, refreshDigest, generateDigest, setEureka, pinMoment,
  getDigdigConfig, saveDigdigConfig,
  exportWiki, importWiki, dismissToast, pruneToasts,
  t,
}: ResearchPanelProps) {
  const selectedProjectId = useStore(state => state.selectedProjectId)
  const activeTab = useStore(state => state.activeTab)
  // The host's language still reaches the ledger's digest link (#142 replaced
  // the in-panel language button with the host one, but the digest it opens
  // must match the UI language).
  const locale = useChrome(chrome => chrome.locale)
  const capabilities = useResearch(view => view.capabilities)
  const rail = visibleTabs(capabilities)
  const tiers = railTiers(capabilities)
  const paperFullscreen = useStore(state => state.paperFullscreen)
  const projects = useResearch(view => view.projects)
  const projectsStatus = useResearch(view => view.projectsStatus)
  const outline = useResearch(view => view.outline)
  const compileView = useResearch(view => view.compile)
  const source = useResearch(view => view.source)
  const papers = useResearch(view => view.papers)
  const arxivSearch = useResearch(view => view.arxivSearch)
  const webSearch = useResearch(view => view.webSearch)
  const arxivSubscriptions = useResearch(view => view.arxivSubscriptions)
  const zotero = useResearch(view => view.zotero)
  const zoteroSearch = useResearch(view => view.zoteroSearch)
  const experiments = useResearch(view => view.experiments)
  const artifact = useResearch(view => view.artifact)
  const figures = useResearch(view => view.figures)
  const meetings = useResearch(view => view.meetings)
  const imageGen = useResearch(view => view.imageGen)
  const digdigConfig = useResearch(view => view.digdigConfig)
  const servers = useResearch(view => view.servers)
  const serverChecks = useResearch(view => view.serverChecks)
  const jobs = useResearch(view => view.jobs)
  const protocol = useResearch(view => view.protocol)
  const bib = useResearch(view => view.bib)
  const snapshots = useResearch(view => view.snapshots)
  const venueTemplates = useResearch(view => view.venueTemplates)
  const venues = useResearch(view => view.venues)
  const snapshotDetail = useResearch(view => view.snapshotDetail)
  const ledger = useResearch(view => view.ledger)
  const report = useResearch(view => view.report)
  const brief = useResearch(view => view.brief)
  const worktree = useResearch(view => view.worktree)
  const foraging = useResearch(view => view.foraging)
  const moments = useResearch(view => view.moments)
  const evidence = useResearch(view => view.evidence)
  const eureka = useResearch(view => view.eureka)
  const digest = useResearch(view => view.digest)
  const toasts = useResearch(view => view.toasts)
  const backup = useResearch(view => view.backup)
  const taskHealth = useResearch(view => view.taskHealth)
  const paperJump = useResearch(view => view.paperJump)
  const sessionList = useSessionList(view => view.list)
  const currentSessionId = useSessionList(view => view.current)

  // Sidebar project list fold; persists across panel opens like the paper
  // pane layout does. Collapsed still shows the selected project's name.
  const [projectsCollapsed, setProjectsCollapsed] = useState(
    () => readStorageFlag(PROJECTS_COLLAPSED_STORAGE_KEY, false),
  )
  // The "import existing project" dialog of the sidebar project list.
  const [importOpen, setImportOpen] = useState(false)
  // The sidebar's project management: the inline create form, the row being
  // renamed (with its draft), a mutation in flight (guards double submits),
  // and the last mutation failure (shown as one line under the list).
  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectError, setProjectError] = useState<ResearchFailureView | null>(null)
  // The async delete hand-off must decide against the LATEST selection and
  // list; a handler closure would freeze the click-time values.
  const selectionRef = useRef({ selectedProjectId, projects })
  selectionRef.current = { selectedProjectId, projects }
  useEffect(() => {
    writeStorageValue(PROJECTS_COLLAPSED_STORAGE_KEY, storageFlagValue(projectsCollapsed))
  }, [projectsCollapsed])

  // The rail fold (narrow icons-only rail); persists across panel opens. The
  // fold control hides in top-bar mode (≤700px) — see sidebar-fold.ts.
  const [sidebarFolded, setSidebarFolded] = useState(
    () => readSidebarFolded(readStorageValue),
  )
  useEffect(() => {
    writeStorageValue(SIDEBAR_FOLD_STORAGE_KEY, sidebarFoldStorageValue(sidebarFolded))
  }, [sidebarFolded])

  // Every read is fired on mount: the page is only mounted while it is the
  // selected panel, so mounting IS the user opening it.
  useEffect(() => {
    ensure()
  }, [ensure])
  // Never leave the workbench blank: once the list settles, select the first
  // project so the overview has content on first open.
  useEffect(() => {
    if (projectsStatus === 'ready' && selectedProjectId === null && projects.length > 0) {
      selectProject(projects[0]?.id ?? '')
    }
  }, [projectsStatus, selectedProjectId, projects, selectProject])
  // Mirror the selection onto the controller so a slice loader that needs the
  // project id (venues, figures, the experiment artifact) can be driven by
  // loadSlice alone. Runs before the trigger effect below so the id is current
  // when a project switch fires.
  useEffect(() => {
    setSelectedProjectId(selectedProjectId)
  }, [selectedProjectId, setSelectedProjectId])
  // One trigger, one question (#222): "which slices does this tab want?" The
  // freshness policy (fresh / failed / in flight) lives in loadSlice's matrix,
  // not here — these effects only declare intent, so a failed slice retries on
  // the next visit instead of waiting for its own button, and the reconnect
  // and project-switch paths reach the same table. The panel is a page now, not
  // a dialog, so there is no `open` gate to consult (#142 shell redesign).
  useEffect(() => {
    for (const slice of SLICES_BY_TAB[activeTab] ?? []) loadSlice(slice, 'first-open')
  }, [activeTab, loadSlice])
  // A project switch re-reads the project-scoped slices: their content is a
  // different project's, so the settled view is stale rather than fresh.
  const previousProjectId = useRef(selectedProjectId)
  useEffect(() => {
    const previous = previousProjectId.current
    previousProjectId.current = selectedProjectId
    if (previous === selectedProjectId) return
    for (const slice of LOAD_MATRIX['project-switch']) loadSlice(slice, 'project-switch')
  }, [selectedProjectId, loadSlice])

  // The sidebar's create form: an invalid title is rejected client-side (the
  // host re-checks); a success closes the form (the inject mapping has
  // already selected the new project), a failure shows under the list.
  const submitCreateProject = async (): Promise<void> => {
    const title = cleanProjectTitle(createTitle)
    if (title === null || projectBusy) return
    setProjectBusy(true)
    setProjectError(null)
    const outcome = await createProject(title)
    setProjectBusy(false)
    if ('code' in outcome) {
      setProjectError(outcome)
      return
    }
    setCreateTitle('')
    setCreateOpen(false)
  }

  // The row's inline rename: same title rule as create.
  const submitRenameProject = async (projectId: string): Promise<void> => {
    const title = cleanProjectTitle(renameTitle)
    if (title === null || projectBusy) return
    setProjectBusy(true)
    setProjectError(null)
    const outcome = await renameProject(projectId, title)
    setProjectBusy(false)
    if ('code' in outcome) {
      setProjectError(outcome)
      return
    }
    setRenameId(null)
  }

  // The row's delete: confirmed in place (the cascade is irreversible). The
  // confirm copy says whether the source directory goes too (only a paper
  // directory under `imported/` is removed; the user's own tree stays). The
  // selection hand-off after a successful delete reads the LATEST list and
  // selection through the ref — never this render's closure.
  const confirmDeleteProject = async (project: { id: string; title: string; paperDir?: string | undefined }): Promise<void> => {
    if (projectBusy) return
    const copyKey: ResearchKey = project.paperDir?.startsWith('imported/') === true
      ? 'projects.confirmDeleteImported'
      : 'projects.confirmDelete'
    if (!window.confirm(t(copyKey, { title: project.title }))) return
    setProjectBusy(true)
    setProjectError(null)
    const failure = await deleteProject(project.id)
    setProjectBusy(false)
    if (failure !== null) {
      setProjectError(failure)
      return
    }
    const latest = selectionRef.current
    const next = nextSelectionAfterDelete(latest.projects, project.id, latest.selectedProjectId)
    if (next !== undefined) selectProject(next)
  }

  const selectedProject = selectedProjectId === null
    ? undefined
    : projects.find(project => project.id === selectedProjectId)

  // The overview's stat chips read whatever the other views already fetched;
  // a view not yet loaded (or belonging to another project) shows a dash.
  const overviewStats = {
    papers: papers.status === 'ready' ? papers.list.length : null,
    experiments: experiments !== null && experiments.projectId === selectedProjectId && experiments.status === 'ready'
      ? experiments.list.length
      : null,
    figures: figures !== null && figures.projectId === selectedProjectId && figures.status === 'ready'
      ? figures.list.length
      : null,
    servers: servers.status === 'ready' ? servers.list.length : null,
    venues: venues.status === 'ready' ? countUpcomingDeadlines(venues.list, 30, Date.now()) : null,
  }
  const navCounts: Partial<Record<ResearchTab, number | null>> = {
    papers: overviewStats.papers,
    experiments: overviewStats.experiments,
    figures: overviewStats.figures,
    servers: overviewStats.servers,
  }

  return (
    <section className={css.workbench} role="region" aria-label={t('panel.title')}>
      {/* Fixed full-viewport dimmer; painted behind the window's own content
          (negative z-index inside the workbench stacking context). */}
      {protocol.status === 'incompatible' && (
        <p className={css.protocolBanner} role="alert">
          {t('protocol.banner', {
            detail: protocol.hostVersion === null
              ? t('protocol.hostUnknown')
              : t('protocol.versions', { client: protocol.clientVersion, host: protocol.hostVersion }),
            action: t(protocol.verdict === 'host-ahead' ? 'protocol.upgradeClient' : 'protocol.upgradeHost'),
          })}
        </p>
      )}
      <aside className={css.side} data-folded={sidebarFolded || undefined}>
        <div className={css.sideHead}>
          <div className={css.brand}>
            <span className={css.brandMark} aria-hidden>M</span>
            <span className={css.brandCopy}>
              <span className={css.title}>{t('panel.title')}</span>
              <span className={css.brandSubtitle}>{t('panel.subtitle')}</span>
            </span>
          </div>
        </div>
        {/* Two tiers, one tablist (#243): the research main path on the first
            level, the low-frequency instruments behind "More". The rail order
            is still the shortcut order, so `n` stays one number per view; a
            view behind More still lights its own More button, so the rail
            never claims nothing is selected. Arrow keys walk the whole rail
            across both tiers. */}
        <nav
          className={css.nav}
          role="tablist"
          aria-label={t('panel.views')}
          onKeyDown={(event) => {
            const next = arrowTab(activeTab, event.key, rail)
            if (next === null) return
            event.preventDefault()
            actions.setTab(next)
            const tabs = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
            tabs[rail.indexOf(next)]?.focus()
          }}
        >
          {tiers.primary.map(tab => (
            <NavTab key={tab} tab={tab} activeTab={activeTab} count={navCounts[tab]} setTab={actions.setTab} t={t} />
          ))}
          {tiers.secondary.length > 0 && (
            <details className={css.navMore} data-lit={tiers.secondary.includes(activeTab) || undefined}>
              <summary
                className={css.navItem}
                role="tab"
                aria-selected={tiers.secondary.includes(activeTab)}
                aria-label={t('nav.more')}
                title={t('nav.more')}
              >
                <span className={css.navIcon} aria-hidden>⋯</span>
                <span className={css.navLabel}>{t('nav.more')}</span>
              </summary>
              <div className={css.navMoreList}>
                {tiers.secondary.map(tab => (
                  <NavTab key={tab} tab={tab} activeTab={activeTab} count={navCounts[tab]} setTab={actions.setTab} t={t} />
                ))}
              </div>
            </details>
          )}
        </nav>
        {/* The rail fold toggle (narrow icons-only rail); hides in top-bar
            mode via CSS. */}
        <button
          type="button"
          className={css.sideFold}
          aria-expanded={!sidebarFolded}
          aria-label={t(sidebarFolded ? 'sidebar.expand' : 'sidebar.fold')}
          title={t(sidebarFolded ? 'sidebar.expand' : 'sidebar.fold')}
          onClick={() => { setSidebarFolded(prev => !prev) }}
        >
          {FOLD_ICON}
        </button>
        <div className={css.sideProjects} data-collapsed={projectsCollapsed || undefined}>
          <button
            type="button"
            className={css.sideProjectsToggle}
            aria-expanded={!projectsCollapsed}
            aria-label={t(projectsCollapsed ? 'projects.expand' : 'projects.collapse')}
            onClick={() => { setProjectsCollapsed(prev => !prev) }}
          >
            <span className={css.collapseChevron} data-up={projectsCollapsed || undefined} aria-hidden>{CHEVRON_ICON}</span>
            <span className={css.sectionTitle}>{t('projects.title')}</span>
            {projectsCollapsed && selectedProject !== undefined && (
              <span className={css.sideProjectsCurrent} title={selectedProject.title}>
                {selectedProject.title}
              </span>
            )}
          </button>
          {!projectsCollapsed && (projectsStatus === 'cold' || projectsStatus === 'loading') && (
            <p className={css.hint}>{t('projects.loading')}</p>
          )}
          {!projectsCollapsed && projectsStatus === 'error' && (
            <p className={css.failure} role="status">
              {t('error.projects')}
              <button type="button" className={css.retry} onClick={ensure}>
                {t('projects.retry')}
              </button>
            </p>
          )}
          {!projectsCollapsed && projectsStatus === 'ready' && projects.length === 0 && (
            <p className={css.hint}>{t('projects.empty')}</p>
          )}
          {!projectsCollapsed && projectsStatus === 'ready' && projects.length > 0 && (
            <div className={css.projectList}>
              {projects.map(project => (
                renameId === project.id ? (
                  <div key={project.id} className={css.projectEditRow}>
                    <input
                      className={css.projectInput}
                      value={renameTitle}
                      aria-label={t('projects.rename')}
                      disabled={projectBusy}
                      onChange={(event) => { setRenameTitle(event.target.value) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void submitRenameProject(project.id)
                        if (event.key === 'Escape') setRenameId(null)
                      }}
                      ref={(element) => { element?.focus() }}
                    />
                    <button
                      type="button"
                      className={css.projectAction}
                      title={t('projects.renameSave')}
                      aria-label={t('projects.renameSave')}
                      disabled={projectBusy || cleanProjectTitle(renameTitle) === null}
                      onClick={() => { void submitRenameProject(project.id) }}
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      className={css.projectAction}
                      title={t('projects.cancel')}
                      aria-label={t('projects.cancel')}
                      disabled={projectBusy}
                      onClick={() => { setRenameId(null) }}
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <div
                    key={project.id}
                    className={css.projectRow}
                    data-selected={project.id === selectedProjectId || undefined}
                  >
                    <button
                      type="button"
                      className={css.projectSelect}
                      title={project.title}
                      disabled={projectBusy}
                      onClick={() => { selectProject(project.id) }}
                    >
                      <span className={css.projectTitle}>{project.title}</span>
                    </button>
                    <span className={css.projectActions}>
                      <button
                        type="button"
                        className={css.projectAction}
                        title={t('projects.rename')}
                        aria-label={t('projects.rename')}
                        onClick={() => { setRenameId(project.id); setRenameTitle(project.title); setProjectError(null) }}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className={css.projectAction}
                        data-danger
                        title={t('projects.delete')}
                        aria-label={t('projects.delete')}
                        disabled={projectBusy}
                        onClick={() => { void confirmDeleteProject(project) }}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                )
              ))}
            </div>
          )}
          {!projectsCollapsed && projectError !== null && (
            <p className={css.failure} role="status">{failureCopy(t, projectError)}</p>
          )}
          {!projectsCollapsed && projectsStatus === 'ready' && createOpen && (
            <div className={css.projectEditRow}>
              <input
                className={css.projectInput}
                value={createTitle}
                placeholder={t('projects.newPlaceholder')}
                aria-label={t('projects.new')}
                disabled={projectBusy}
                onChange={(event) => { setCreateTitle(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitCreateProject()
                  if (event.key === 'Escape') setCreateOpen(false)
                }}
                ref={(element) => { element?.focus() }}
              />
              <button
                type="button"
                className={css.projectAction}
                title={t('projects.create')}
                aria-label={t('projects.create')}
                disabled={projectBusy || cleanProjectTitle(createTitle) === null}
                onClick={() => { void submitCreateProject() }}
              >
                ✓
              </button>
              <button
                type="button"
                className={css.projectAction}
                title={t('projects.cancel')}
                aria-label={t('projects.cancel')}
                disabled={projectBusy}
                onClick={() => { setCreateOpen(false) }}
              >
                ×
              </button>
            </div>
          )}
          {!projectsCollapsed && projectsStatus === 'ready' && !createOpen && (
            <div className={css.projectButtons}>
              <button type="button" className={css.btn} onClick={() => { setCreateOpen(true); setCreateTitle(''); setProjectError(null) }}>
                {t('projects.new')}
              </button>
              <button type="button" className={css.btn} onClick={() => { setImportOpen(true) }}>
                {t('projects.import')}
              </button>
            </div>
          )}
        </div>
        {/* The session switcher: picks the host-GLOBAL current session — the
            whole client follows it, and the panel's "… with AI" verbs deliver
            there. The wiki itself is shared across sessions. */}
        <div className={css.sessionBar}>
          <span className={css.sessionLabel}>{t('session.label')}</span>
          <select
            className={css.sessionSelect}
            aria-label={t('session.label')}
            value={currentSessionId ?? ''}
            disabled={sessionList.length === 0}
            onChange={(event) => { if (event.target.value !== '') selectSession(event.target.value) }}
          >
            {currentSessionId === null && <option value="">{t('session.none')}</option>}
            {sessionList.map(session => (
              <option key={session.id} value={session.id}>{session.title}</option>
            ))}
          </select>
        </div>
      </aside>
      <main className={css.content} role="tabpanel" aria-label={t(TAB_KEYS[activeTab])}>
        {activeTab === 'overview' && (
          <OverviewView project={selectedProject} stats={overviewStats} backup={backup} taskHealth={taskHealth} jobs={jobs} experiments={experiments} openLedger={() => { actions.setTab('ledger') }} exportWiki={exportWiki} importWiki={importWiki} t={t} />
        )}
        {activeTab === 'paper' && (
          <PaperView
            outline={outline}
            compileView={compileView}
            source={source}
            projectId={selectedProjectId}
            projectTitle={selectedProject?.title}
            dir={selectedProject?.paperDir}
            entryFile={selectedProject?.entryFile}
            editSource={editSource}
            reloadSource={reloadSource}
            compile={compile}
            requestCompileFix={requestCompileFix}
            bib={bib}
            papers={papers}
            ensureBibliography={ensureBibliography}
            reloadBibliography={reloadBibliography}
            deleteBibEntry={deleteBibEntry}
            updateBibEntry={updateBibEntry}
            importPapersToBib={importPapersToBib}
            ensurePapers={ensurePapers}
            reorderPaperSections={reorderPaperSections}
            reorderPaperSubsections={reorderPaperSubsections}
            paperJump={paperJump}
            consumePaperJump={consumePaperJump}
            fullscreen={paperFullscreen}
            setFullscreen={actions.setPaperFullscreen}
            snapshots={snapshots}
            snapshotDetail={snapshotDetail}
            loadSnapshots={loadSnapshots}
            loadSnapshotDetail={loadSnapshotDetail}
            closeSnapshotDetail={closeSnapshotDetail}
            revertSnapshot={revertSnapshot}
            venue={selectedProject?.venue}
            venueTemplates={venueTemplates}
            ensureVenueTemplates={ensureVenueTemplates}
            applyVenueTemplate={applyVenueTemplate}
            clearVenueTemplate={clearVenueTemplate}
            uploadTemplateFiles={uploadTemplateFiles}
            requestVenueFormat={requestVenueFormat}
            t={t}
          />
        )}
        {activeTab === 'papers' && (
          <PapersView
            papers={papers}
            arxivSearch={arxivSearch}
            webSearch={webSearch}
            digdigConfig={digdigConfig}
            arxivSubscriptions={arxivSubscriptions}
            projects={projects}
            selectedProjectId={selectedProjectId}
            ensurePapers={ensurePapers}
            saveArxivSubscription={saveArxivSubscription}
            deleteArxivSubscription={deleteArxivSubscription}
            checkArxivSubscriptions={checkArxivSubscriptions}
            searchArxiv={searchArxiv}
            searchWeb={searchWeb}
            getDigdigConfig={getDigdigConfig}
            saveDigdigConfig={saveDigdigConfig}
            importPaper={importPaper}
            updatePaper={updatePaper}
            removePaper={removePaper}
            importPapersToBib={importPapersToBib}
            fetchPaperPdf={fetchPaperPdf}
            zotero={zotero}
            zoteroSearch={zoteroSearch}
            recheckZotero={recheckZotero}
            searchZotero={searchZotero}
            importZoteroItem={importZoteroItem}
            exportZoteroCollectionToBib={exportZoteroCollectionToBib}
            refreshPapers={refreshPapers}
            requestRelatedWork={requestRelatedWork}
            requestPaperScore={requestPaperScore}
            t={t}
          />
        )}
        {activeTab === 'experiments' && (
          <ExperimentsView
            experiments={experiments}
            artifact={artifact}
            servers={servers}
            projectId={selectedProjectId}
            ensureServers={ensureServers}
            deleteExperiment={deleteExperiment}
            updateExperiment={updateExperiment}
            saveExperiment={saveExperiment}
            generateMetricFigure={(metricKey, rows, direction) =>
              selectedProjectId === null
                ? Promise.resolve()
                : generateMetricFigure(selectedProjectId, metricKey, rows, direction)
            }
            retry={() => { if (selectedProjectId !== null) selectProject(selectedProjectId) }}
            t={t}
          />
        )}
        {activeTab === 'figures' && (
          <FiguresView
            figures={figures}
            experiments={experiments}
            projectId={selectedProjectId}
            projectTitle={selectedProject?.title ?? ''}
            dir={selectedProject?.paperDir}
            loadFigures={loadFigures}
            uploadFigures={uploadFigures}
            deleteFigure={deleteFigure}
            renameFigure={renameFigure}
            updateFigure={updateFigure}
            requestFigureOrganize={requestFigureOrganize}
            insertFigure={(entry) => selectedProjectId === null ? Promise.resolve() : insertFigure(selectedProjectId, entry)}
            t={t}
          />
        )}
        {activeTab === 'meetings' && (
          <MeetingsView
            meetings={meetings}
            papers={papers}
            figures={figures}
            imageGen={imageGen}
            projectId={selectedProjectId}
            dir={selectedProject?.paperDir}
            ensurePapers={ensurePapers}
            loadFigures={loadFigures}
            loadMeetings={loadMeetings}
            generateMeetingDeck={generateMeetingDeck}
            deleteMeetingDeck={deleteMeetingDeck}
            getImageGenConfig={getImageGenConfig}
            saveImageGenConfig={saveImageGenConfig}
            t={t}
          />
        )}
        {activeTab === 'servers' && (
          <ServersView
            servers={servers}
            checks={serverChecks}
            ensureServers={ensureServers}
            saveServer={saveServer}
            deleteServer={deleteServer}
            checkServer={checkServer}
            checkAllServers={checkAllServers}
            jobs={jobs}
            experiments={experiments}
            ensureJobs={ensureJobs}
            refreshJobs={refreshJobs}
            submitJob={submitJob}
            deleteJob={deleteJob}
            t={t}
          />
        )}
        {activeTab === 'venues' && (
          <VenuesView
            venues={venues}
            hasProject={selectedProjectId !== null}
            refreshVenues={() => { refreshVenues(selectedProjectId) }}
            refreshVenueCatalog={() => refreshVenueCatalog(selectedProjectId)}
            toggleVenueWatch={toggleVenueWatch}
            t={t}
          />
        )}
        {activeTab === 'ledger' && (
          <LedgerView
            ledger={ledger}
            report={report}
            brief={brief}
            worktree={worktree}
            selectedProjectId={selectedProjectId}
            loadLedger={loadLedger}
            generateReport={generateReport}
            generateBrief={generateBrief}
            addJournal={addJournal}
            ensureWorktree={ensureWorktree}
            refreshWorktree={refreshWorktree}
            setMainline={setMainline}
            setIdeaParent={setIdeaParent}
            adoptIdea={adoptIdea}
            closeIdea={closeIdea}
            ensureForaging={ensureForaging}
            refreshForaging={refreshForaging}
            foraging={foraging}
            moments={moments}
            ensureMoments={ensureMoments}
            refreshMoments={refreshMoments}
            declineMoment={declineMoment}
            evidence={evidence}
            loadEvidenceGraph={loadEvidenceGraph}
            refreshEvidenceGraph={refreshEvidenceGraph}
            retractEvidence={retractEvidence}
            eureka={eureka}
            ensureEureka={ensureEureka}
            digest={digest}
            locale={locale}
            ensureDigest={ensureDigest}
            refreshDigest={refreshDigest}
            generateDigest={generateDigest}
            setEureka={setEureka}
            pinMoment={pinMoment}
            t={t}
          />
        )}
      </main>
      <ToastHost toasts={toasts} dismissToast={dismissToast} pruneToasts={pruneToasts} t={t} />
      {importOpen && (
        <ImportProjectDialog importProject={importProject} onClose={() => { setImportOpen(false) }} t={t} />
      )}
    </section>
  )
}
