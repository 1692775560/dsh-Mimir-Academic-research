/**
 * The right-pane seat mounts the WHOLE workbench, and it can only do that
 * because two things are true: the selected project rides the shared controller
 * view (both seats agree), and the seat supplies the store face + selector hooks
 * + copy that the slot machinery would otherwise bind. These tests pin both —
 * the descriptor the host receives, the props the panel actually gets, and the
 * copy interpolation the seat has to do itself.
 * @module dsh-client-ui-mimir/tests/workbench-tab
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { EngineStoreInstance } from '@deepseek-ai/dsh-client-store'
import type { ResearchPanelInjected } from '../src/client/slots.ts'
import type { ResearchPanelActions, ResearchPanelState } from '../src/client/store.ts'
import type { ResearchView } from '../src/client/controller.ts'
import type { ResearchSessionListView } from '../src/client/project-form.ts'

const captured = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }))

vi.mock('../src/client/ResearchPanel.tsx', () => ({
  // The panel body is huge and stateful; the seat's job is what it is HANDED.
  ResearchPanel: (props: Record<string, unknown>): null => {
    captured.props = props
    return null
  },
}))

import {
  ResearchWorkbenchTab, WORKBENCH_TAB_ID, formatMessage, researchWorkbenchTab, surfacePropsOf,
  type WorkbenchSeat, type WorkbenchSnapshots,
} from '../src/client/workbench-tab.tsx'

/** An observable over one frozen value. */
function observableOf<T>(value: T): { getSnapshot: () => T; subscribe: () => () => void } {
  return { getSnapshot: () => value, subscribe: () => () => {} }
}

const STATE: ResearchPanelState = { open: false, activeTab: 'paper', paperFullscreen: 'editor' }
const VIEW = { selectedProjectId: 'p1' } as unknown as ResearchView
const SESSIONS = { sessions: [] } as unknown as ResearchSessionListView

/** A store instance that answers with one frozen state. */
function panelOf(state: ResearchPanelState): EngineStoreInstance<ResearchPanelState, ResearchPanelActions> {
  return {
    actions: { setTab: () => {} } as unknown as EngineStoreInstance<ResearchPanelState, ResearchPanelActions>['actions'],
    getSnapshot: () => state,
    subscribe: () => () => {},
    clearPersisted: () => {},
  } as unknown as EngineStoreInstance<ResearchPanelState, ResearchPanelActions>
}

const injected = {
  hooks: { research: observableOf({}), chrome: observableOf({}), sessionList: observableOf({}) },
  ensure: () => {},
  selectProject: () => {},
} as unknown as ResearchPanelInjected

/**
 * A seat over frozen fakes.
 * @param copy - the copy locale the seat reports.
 * @returns the seat.
 */
function seatOf(copy: 'zh' | 'en'): WorkbenchSeat {
  return {
    panel: panelOf(STATE),
    controller: {
      subscribe: () => () => {},
      getSnapshot: () => VIEW,
    } as unknown as WorkbenchSeat['controller'],
    chrome: observableOf({ locale: copy }) as unknown as WorkbenchSeat['chrome'],
    sessionList: observableOf(SESSIONS) as unknown as WorkbenchSeat['sessionList'],
    injected,
    copy: () => copy,
  }
}

/**
 * The snapshot bundle for a seat.
 * @param locale - the chrome locale.
 * @returns the snapshots.
 */
function snapshotsOf(locale: 'zh' | 'en'): WorkbenchSnapshots {
  return {
    view: VIEW,
    panel: STATE,
    chrome: { locale } as unknown as WorkbenchSnapshots['chrome'],
    sessionList: SESSIONS,
  }
}

describe('the right-pane workbench tab descriptor', () => {
  it('registers under the plugin namespace, after the glance card', () => {
    const tab = researchWorkbenchTab(seatOf('zh'))
    expect(tab.id).toBe(WORKBENCH_TAB_ID)
    expect(tab.id).toBe('dsh-mimir:workbench')
    expect(tab.order).toBe(61)
    expect(tab.single).toBe(true)
  })

  it('titles itself from the copy, at call time', () => {
    const titleOf = (tab: ReturnType<typeof researchWorkbenchTab>): string =>
      typeof tab.title === 'function' ? tab.title() : (tab.title ?? '')
    expect(titleOf(researchWorkbenchTab(seatOf('zh')))).toBe('科研工作台')
    expect(titleOf(researchWorkbenchTab(seatOf('en')))).toBe('Research workbench')
  })

  it('renders a component', () => {
    const tab = researchWorkbenchTab(seatOf('zh'))
    const node = tab.component?.({ visible: true } as never)
    expect(node).toBeTruthy()
  })
})

describe('what the seat hands the panel', () => {
  it('passes the injected face and its own store actions through', () => {
    const seat = seatOf('zh')
    const props = surfacePropsOf(seat, snapshotsOf('zh'))
    expect(props.ensure).toBe(injected.ensure)
    expect(props.actions).toBe(seat.panel.actions)
  })

  it('reads the selection from the shared view and the tab from its own store', () => {
    const props = surfacePropsOf(seatOf('zh'), snapshotsOf('zh'))
    expect(props.useResearch(view => view.selectedProjectId)).toBe('p1')
    expect(props.useStore(state => state.activeTab)).toBe('paper')
    expect(props.useStore(state => state.paperFullscreen)).toBe('editor')
  })

  it('resolves copy in the seat locale, tolerating params it has no slot for', () => {
    const zhProps = surfacePropsOf(seatOf('zh'), snapshotsOf('zh'))
    const enProps = surfacePropsOf(seatOf('en'), snapshotsOf('en'))
    expect(zhProps.t('sidebar.workbench')).toBe('科研工作台')
    expect(enProps.t('sidebar.workbench')).toBe('Research workbench')
    expect(zhProps.t('sidebar.workbench', { extra: 1 })).toBe('科研工作台')
  })

  it('mounts the panel with those props', () => {
    renderToString(<ResearchWorkbenchTab seat={seatOf('en')} />)
    expect(captured.props).toBeDefined()
    const props = captured.props as {
      t: (key: 'sidebar.workbench') => string
      useResearch: (selector: (view: ResearchView) => unknown) => unknown
    }
    expect(props.t('sidebar.workbench')).toBe('Research workbench')
    expect(props.useResearch(view => view.selectedProjectId)).toBe('p1')
  })
})

describe('copy interpolation', () => {
  it('fills {name} placeholders and leaves unknown names verbatim', () => {
    expect(formatMessage('Hi {name}, {n} left', { name: 'YG', n: 2 })).toBe('Hi YG, 2 left')
    expect(formatMessage('Hi {name}', {})).toBe('Hi {name}')
    expect(formatMessage('plain')).toBe('plain')
  })
})
