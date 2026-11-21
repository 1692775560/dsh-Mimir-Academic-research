/**
 * The dsh-better-sidebar tab shows a glance card over the SHARED controller, so
 * every number in it must be the number the page shows. These tests pin the
 * counting rules and the descriptor the host receives — the two places where a
 * future edit could make the right pane disagree with the main column.
 */
import { describe, expect, it } from 'vitest'
import type { ResearchView } from '../src/client/controller.ts'
import {
  SIDEBAR_TAB_ID, compileLineKeyOf, glanceCountsOf, glanceProjectOf, researchSidebarTab, sidebarTabIcon,
} from '../src/client/sidebar-tab.tsx'
import { en, zh } from '../src/client/locales.ts'

/**
 * A view with only the slices the glance card reads.
 * @param overrides - slices to replace.
 * @returns the view, cast: the card never touches anything else.
 */
function viewOf(overrides: Record<string, unknown> = {}): ResearchView {
  return {
    projects: [],
    outline: null,
    papers: { list: [] },
    experiments: null,
    figures: null,
    jobs: { list: [] },
    compile: { state: 'idle', observed: false },
    ...overrides,
  } as unknown as ResearchView
}

describe('glance counters', () => {
  it('counts each slice the way the page counts it', () => {
    const counts = glanceCountsOf(viewOf({
      papers: { list: [{ id: 'a' }, { id: 'b' }] },
      experiments: { list: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }] },
      figures: { list: [{ id: 'f1' }] },
    }))
    expect(counts).toEqual({ papers: 2, experiments: 3, figures: 1, running: 0 })
  })

  it('treats a slice that was never loaded as zero, not as unknown', () => {
    expect(glanceCountsOf(viewOf())).toEqual({ papers: 0, experiments: 0, figures: 0, running: 0 })
  })

  it('counts queued jobs as running and settled jobs as not', () => {
    const counts = glanceCountsOf(viewOf({
      jobs: {
        list: [
          { id: 'j1', status: 'running' },
          { id: 'j2', status: 'queued' },
          { id: 'j3', status: 'succeeded' },
          { id: 'j4', status: 'failed' },
        ],
      },
    }))
    expect(counts.running).toBe(2)
  })
})

describe('which project the card is about', () => {
  const projects = [
    { id: 'alpha', title: 'Alpha', stage: 'experiment' },
    { id: 'beta', title: 'Beta', stage: 'writing' },
  ]

  it('follows the outline, which is what the page is showing', () => {
    expect(glanceProjectOf(viewOf({ projects, outline: { projectId: 'beta' } }))?.id).toBe('beta')
  })

  it('falls back to the first project when nothing is open', () => {
    expect(glanceProjectOf(viewOf({ projects }))?.id).toBe('alpha')
  })

  it('reports no project at all when there are none', () => {
    expect(glanceProjectOf(viewOf())).toBeUndefined()
  })
})

describe('compile line', () => {
  it('names each state, and separates a claim from an observation', () => {
    expect(compileLineKeyOf({ state: 'idle' } as never)).toBe('compile.idle')
    expect(compileLineKeyOf({ state: 'running' } as never)).toBe('compile.running')
    expect(compileLineKeyOf({ state: 'error' } as never)).toBe('compile.error')
    expect(compileLineKeyOf({ state: 'ok', observed: true } as never)).toBe('compile.ok')
    expect(compileLineKeyOf({ state: 'ok', observed: false } as never)).toBe('compile.okUnobserved')
  })
})

describe('the descriptor handed to dsh-better-sidebar', () => {
  const descriptor = researchSidebarTab({
    controller: {} as never,
    chrome: {} as never,
    copy: () => 'zh',
    openPanel: () => {},
  })

  it('registers one tab under a namespaced id', () => {
    expect(SIDEBAR_TAB_ID).toBe('dsh-mimir:research')
    expect(descriptor.id).toBe(SIDEBAR_TAB_ID)
    expect(descriptor.single).toBe(true)
    expect(descriptor.order).toBe(60)
  })

  it('titles itself in the live locale', () => {
    const title = descriptor.title
    expect(typeof title).toBe('function')
    expect((title as () => string)()).toBe(zh['sidebar.glance'])
    const english = researchSidebarTab({
      controller: {} as never, chrome: {} as never, copy: () => 'en', openPanel: () => {},
    })
    expect((english.title as () => string)()).toBe(en['sidebar.glance'])
  })

  it('carries an icon and a body', () => {
    expect(typeof sidebarTabIcon(16)).toBe('object')
    const body = descriptor.component({ visible: true })
    expect(body).toBeTypeOf('object')
  })
})
