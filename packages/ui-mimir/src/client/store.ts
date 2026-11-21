/**
 * The research panel's per-seat viewing state: which view tab a seat is on and
 * whether the paper view is focused on one pane. The selected PROJECT is not
 * here — it is shared intent (two seats must agree), so it lives on the
 * controller's view instead; this store only holds what may legitimately differ
 * between seats.
 *
 * One handle is created in apply. The `main` seat's instance comes from the
 * host's slot machinery; the right-pane seat takes its own instance from the
 * same handle (see `workbench-tab.tsx`).
 * @module dsh-client-ui-mimir/client/store
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** The workbench's nine view tabs. */
export type ResearchTab = 'overview' | 'paper' | 'papers' | 'experiments' | 'figures' | 'meetings' | 'servers' | 'ledger' | 'venues'

/** The paper-view pane holding fullscreen, or null. */
export type PaperFullscreen = 'editor' | 'preview'

/** Shared panel viewing state. */
export interface ResearchPanelState {
  /** Whether the overlay panel is on screen. */
  open: boolean
  /** The active workbench view. */
  activeTab: ResearchTab
  /** The paper-view pane holding fullscreen, or null when split. */
  paperFullscreen: PaperFullscreen | null
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
export type ResearchPanelActions = {
  toggleOpen: (draft: ResearchPanelState) => void
  setOpen: (draft: ResearchPanelState, open: boolean) => void
  setTab: (draft: ResearchPanelState, tab: ResearchTab) => void
  setPaperFullscreen: (draft: ResearchPanelState, pane: PaperFullscreen | null) => void
}

/**
 * Build the panel store handle shared by the toggle and panel registrations.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createResearchPanelStore(): EngineStoreHandle<ResearchPanelState, ResearchPanelActions> {
  return defineStore({
    init: (): ResearchPanelState => ({
      open: false, activeTab: 'overview', paperFullscreen: null,
    }),
    actions: {
      toggleOpen: (d) => { d.open = !d.open },
      setOpen: (d, open: boolean) => { d.open = open },
      setTab: (d, tab: ResearchTab) => { d.activeTab = tab },
      setPaperFullscreen: (d, pane: PaperFullscreen | null) => { d.paperFullscreen = pane },
    },
  })
}
