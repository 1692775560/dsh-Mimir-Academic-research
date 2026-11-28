/**
 * The dsh-better-sidebar tab: the research workbench's glanceable half, mounted
 * in the host's right pane instead of the main column.
 *
 * Why a summary rather than the whole workbench: the panel's viewing state
 * lives in a slot-scoped store (`createResearchPanelStore`), and the store
 * package builds a fresh instance on every `create()` call — a tab registered
 * on a service outside the slot registry has no way to reach the instance the
 * `main` panel uses, so mounting the full panel there would give two
 * divergent seats. What IS shared is the controller (one instance, one
 * observable), so the tab renders the same view object the page does and hands
 * the editing surface over with one button. Every number here is the number the
 * page shows.
 * @module dsh-client-ui-mimir/client/sidebar-tab
 */

import { useEffect, useSyncExternalStore, type ReactElement } from 'react'
import type { ResearchController, ResearchView } from './controller.ts'
import type { WorkbenchChrome } from './shortcuts.ts'
import type { ResearchKey } from './locales.ts'
import { en, zh } from './locales.ts'
import { ResearchMark } from './mark.tsx'
import css from './ResearchSidebarTab.module.css'

/**
 * The slice of dsh-better-sidebar's client service this plugin calls. Declared
 * structurally (not imported) because the sidebar is an optional peer: the
 * plugin must load with and without it installed.
 */
export interface BetterSidebarTabService {
  /**
   * Add one tab to the host's right pane.
   * @param descriptor - id, title, icon, order and the tab body.
   * @returns the disposer that removes the tab again.
   */
  registerTab: (descriptor: {
    readonly id: string
    readonly title: string | (() => string)
    readonly description?: string
    readonly icon?: ReactElement | ((size: number) => ReactElement)
    readonly order?: number
    readonly single?: boolean
    readonly component: (props: { readonly visible: boolean }) => ReactElement
  }) => () => void
}

/** The tab id registered with dsh-better-sidebar. */
export const SIDEBAR_TAB_ID = 'dsh-mimir:research'

/** The tab's row icon: the plugin mark at the host's requested size. */
export function sidebarTabIcon(size: number): ReactElement {
  return <ResearchMark size={size} />
}

/**
 * One counter cell of the glance grid.
 * @param props - the label and its value.
 * @returns the cell.
 */
function GlanceCell({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className={css.cell}>
      <span className={css.cellValue}>{value}</span>
      <span className={css.cellLabel}>{label}</span>
    </div>
  )
}

/** Which projects slice entry the tab is showing. */
export function glanceProjectOf(view: ResearchView): ResearchView['projects'][number] | undefined {
  return view.projects.find(project => project.id === view.outline?.projectId) ?? view.projects[0]
}

/** The four counters the glance grid shows, in the order it shows them. */
export interface GlanceCounts {
  readonly papers: number
  readonly experiments: number
  readonly figures: number
  readonly running: number
}

/**
 * Count what the page would count. Read off the same view object, so the tab
 * cannot drift from the workbench (the whole point of sharing the controller).
 * @param view - the controller snapshot.
 * @returns the four counters.
 */
export function glanceCountsOf(view: ResearchView): GlanceCounts {
  return {
    papers: view.papers.list.length,
    experiments: view.experiments?.list.length ?? 0,
    figures: view.figures?.list.length ?? 0,
    running: view.jobs.list.filter(job => job.status === 'running' || job.status === 'queued').length,
  }
}

/**
 * Which copy line describes the current compile state.
 * @param compile - the compile slice of the view.
 * @returns the locale key to print.
 */
export function compileLineKeyOf(compile: ResearchView['compile']): ResearchKey {
  if (compile.state === 'error') return 'compile.error'
  if (compile.state === 'running') return 'compile.running'
  if (compile.state === 'ok') return compile.observed ? 'compile.ok' : 'compile.okUnobserved'
  return 'compile.idle'
}

/**
 * The tab body. Reads the shared controller, so it agrees with the page.
 * @param props - the controller, the chrome snapshot, and the page opener.
 * @returns the glance card.
 */
export function ResearchSidebarTab({
  controller, chrome, openPanel,
}: {
  readonly controller: ResearchController
  readonly chrome: { getSnapshot: () => WorkbenchChrome; subscribe: (listener: () => void) => () => void }
  readonly openPanel: () => void
}): ReactElement {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const { locale } = useSyncExternalStore(chrome.subscribe, chrome.getSnapshot)
  const copy = locale === 'en' ? en : zh
  const t = (key: ResearchKey): string => copy[key]

  // Cold until something asks: the tab is often the first surface the user
  // meets in a session, so it warms the slices it counts.
  useEffect(() => {
    controller.ensure()
    controller.ensurePapers()
    controller.ensureJobs()
  }, [controller])

  const project = glanceProjectOf(view)
  const counts = glanceCountsOf(view)
  const compile = view.compile
  const compileCopy = t(compileLineKeyOf(compile))

  return (
    <div className={css.tab}>
      <header className={css.head}>
        <h2 className={css.heading}>{project?.title ?? t('sidebar.glance')}</h2>
        {project !== undefined && <span className={css.stage}>{project.stage}</span>}
      </header>
      {project === undefined ? (
        <p className={css.empty}>{t('overview.noProject')}</p>
      ) : (
        <div className={css.grid}>
          <GlanceCell label={t('overview.statPapers')} value={String(counts.papers)} />
          <GlanceCell label={t('overview.statExperiments')} value={String(counts.experiments)} />
          <GlanceCell label={t('overview.statFigures')} value={String(counts.figures)} />
          <GlanceCell label={t('sidebar.running')} value={String(counts.running)} />
        </div>
      )}
      <p className={css.status} data-state={compile.state}>{compileCopy}</p>
      <button type="button" className={css.open} onClick={openPanel}>{t('sidebar.openWorkbench')}</button>
    </div>
  )
}

/**
 * The full dsh-better-sidebar descriptor for the research tab: icon, localized
 * title and the body wired to the shared controller.
 * @param options - the controller, the chrome snapshot, and the page opener.
 * @returns the descriptor to hand to `registerTab`.
 */
export function researchSidebarTab(options: {
  readonly controller: ResearchController
  readonly chrome: { getSnapshot: () => WorkbenchChrome; subscribe: (listener: () => void) => () => void }
  readonly copy: () => 'zh' | 'en'
  readonly openPanel: () => void
}): Parameters<BetterSidebarTabService['registerTab']>[0] {
  return {
    id: SIDEBAR_TAB_ID,
    title: () => (options.copy() === 'en' ? en : zh)['sidebar.glance'],
    icon: sidebarTabIcon,
    order: 60,
    single: true,
    component: () => (
      <ResearchSidebarTab
        controller={options.controller}
        chrome={options.chrome}
        openPanel={options.openPanel}
      />
    ),
  }
}
