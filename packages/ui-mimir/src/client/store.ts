/**
 * The research panel's shared viewing state: whether the overlay is open and
 * which project is selected. One handle is created in apply and passed to both
 * registrations (the sidebar-footer toggle and the shell.overlay panel), so the
 * toggle and the panel read and write the same instance.
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
  /** Selected wiki project id, or null before the first selection. */
  selectedProjectId: string | null
  /** The active workbench view. */
  activeTab: ResearchTab
  /** The paper-view pane holding fullscreen, or null when split. */
  paperFullscreen: PaperFullscreen | null
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type ResearchPanelActions = {
  toggleOpen: (draft: ResearchPanelState) => void
  setOpen: (draft: ResearchPanelState, open: boolean) => void
  select: (draft: ResearchPanelState, projectId: string | null) => void
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
      open: false, selectedProjectId: null, activeTab: 'overview', paperFullscreen: null,
    }),
    actions: {
      toggleOpen: (d) => { d.open = !d.open },
      setOpen: (d, open: boolean) => { d.open = open },
      select: (d, projectId: string | null) => { d.selectedProjectId = projectId },
      setTab: (d, tab: ResearchTab) => { d.activeTab = tab },
      setPaperFullscreen: (d, pane: PaperFullscreen | null) => { d.paperFullscreen = pane },
    },
  })
}
