/**
 * The dsh-better-sidebar tab that hosts the WHOLE research workbench in the
 * host's right pane, next to the glance card.
 *
 * Why this can exist without a second page: the panel's store seat only holds
 * what may differ between seats (`activeTab`, `paperFullscreen`), and the
 * selected project rides the controller's shared view. So the right pane takes
 * its own instance from the same store handle — its own tab, its own paper
 * focus — while the project it looks at is the project the page looks at.
 *
 * The panel itself is mounted directly here, not through a slot, so this module
 * supplies the three props the slot machinery usually binds: the store face
 * (`useStore` + the baked `actions`), the `use<Name>` selector hooks of the
 * injected face, and `t`.
 * @module dsh-client-ui-mimir/client/workbench-tab
 */

import { useSyncExternalStore, type ReactElement } from 'react'
import type { EngineStoreInstance, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { ResearchPanel } from './ResearchPanel.tsx'
import type { ResearchController, ResearchView } from './controller.ts'
import type { ResearchSessionListView } from './project-form.ts'
import type { ResearchPanelInjected, ResearchPanelSurfaceProps } from './slots.ts'
import type { ResearchPanelActions, ResearchPanelState } from './store.ts'
import type { WorkbenchChrome } from './shortcuts.ts'
import { en, zh } from './locales.ts'
import { ResearchMark } from './mark.tsx'
import type { BetterSidebarTabService } from './sidebar-tab.tsx'

/** The tab id registered with dsh-better-sidebar for the full workbench. */
export const WORKBENCH_TAB_ID = 'dsh-mimir:workbench'

/** The tab's row icon: the same plugin mark as the glance tab. */
export function workbenchTabIcon(size: number): ReactElement {
  return <ResearchMark size={size} />
}

/**
 * Fill one dictionary template the way the host locale service does (`{name}`
 * placeholders; unknown names stay verbatim). Kept local because this seat is
 * rendered outside the locale plugin's `t` seat.
 * @param template - the dictionary string.
 * @param params - the placeholder values.
 * @returns the rendered string.
 */
export function formatMessage(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    (name in params ? String(params[name]) : match))
}

/** Everything the right-pane workbench needs to mount the panel. */
export interface WorkbenchSeat {
  /** This seat's own panel store instance (tab and paper focus are local). */
  readonly panel: EngineStoreInstance<ResearchPanelState, ResearchPanelActions>
  readonly controller: ResearchController
  readonly chrome: HostObservable<WorkbenchChrome>
  readonly sessionList: HostObservable<ResearchSessionListView>
  /** The business face shared with the page seat (the `main` slot's inject). */
  readonly injected: ResearchPanelInjected
  /** The copy dictionary to read at render time. */
  readonly copy: () => 'zh' | 'en'
}

/** One snapshot per observable this seat follows. */
export interface WorkbenchSnapshots {
  readonly view: ResearchView
  readonly panel: ResearchPanelState
  readonly chrome: WorkbenchChrome
  readonly sessionList: ResearchSessionListView
}

/**
 * Bind the seat's snapshots to the three prop groups the slot machinery usually
 * provides. Pure on purpose: the selector hooks are plain closures over
 * `snapshots`, so a test can ask what the panel would see without a renderer.
 *
 * They must not be React hooks of their own — the panel calls them as ordinary
 * functions from its own render, and re-rendering the seat is what makes them
 * read fresh values (one subscription, one re-render, no hook inside a hook).
 * @param seat - the seat (its injected face and its own store actions).
 * @param snapshots - the current snapshot of each observable.
 * @returns the props the workbench body renders with.
 */
export function surfacePropsOf(seat: WorkbenchSeat, snapshots: WorkbenchSnapshots): ResearchPanelSurfaceProps {
  // The host namespace is wider than this plugin's dictionary (it merges every
  // contributor's keys), so an unknown key falls back to the key itself.
  const dictionary: Record<string, string> = seat.copy() === 'en' ? en : zh
  const useResearch: SnapshotSelectorHook<ResearchView> = selector => selector(snapshots.view)
  const useStore: SnapshotSelectorHook<ResearchPanelState> = selector => selector(snapshots.panel)
  const useChrome: SnapshotSelectorHook<WorkbenchChrome> = selector => selector(snapshots.chrome)
  const useSessionList: SnapshotSelectorHook<ResearchSessionListView> = selector => selector(snapshots.sessionList)
  return {
    ...seat.injected,
    useStore,
    useResearch,
    useChrome,
    useSessionList,
    actions: seat.panel.actions,
    t: (key, params) => formatMessage(dictionary[key] ?? key, params),
  }
}

/**
 * The tab body: the whole workbench, subscribed to the shared controller and to
 * this seat's store.
 * @param props - the seat.
 * @returns the workbench markup.
 */
export function ResearchWorkbenchTab({ seat }: { readonly seat: WorkbenchSeat }): ReactElement {
  const view = useSyncExternalStore(seat.controller.subscribe, seat.controller.getSnapshot, seat.controller.getSnapshot)
  const panelState = useSyncExternalStore(seat.panel.subscribe, seat.panel.getSnapshot, seat.panel.getSnapshot)
  const chrome = useSyncExternalStore(seat.chrome.subscribe, seat.chrome.getSnapshot, seat.chrome.getSnapshot)
  const sessionList = useSyncExternalStore(seat.sessionList.subscribe, seat.sessionList.getSnapshot, seat.sessionList.getSnapshot)
  return <ResearchPanel {...surfacePropsOf(seat, { view, panel: panelState, chrome, sessionList })} />
}

/**
 * The full dsh-better-sidebar descriptor for the workbench tab.
 * @param options - the seat.
 * @returns the descriptor to hand to `registerTab`.
 */
export function researchWorkbenchTab(options: {
  readonly panel: EngineStoreInstance<ResearchPanelState, ResearchPanelActions>
  readonly controller: ResearchController
  readonly chrome: HostObservable<WorkbenchChrome>
  readonly sessionList: HostObservable<ResearchSessionListView>
  readonly injected: ResearchPanelInjected
  readonly copy: () => 'zh' | 'en'
}): Parameters<BetterSidebarTabService['registerTab']>[0] {
  const seat: WorkbenchSeat = options
  return {
    id: WORKBENCH_TAB_ID,
    title: () => (options.copy() === 'en' ? en : zh)['sidebar.workbench'],
    icon: workbenchTabIcon,
    order: 61,
    single: true,
    component: () => <ResearchWorkbenchTab seat={seat} />,
  }
}
