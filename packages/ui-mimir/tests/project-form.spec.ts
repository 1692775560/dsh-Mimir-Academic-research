/**
 * Behavior tests for the project-form pure helpers: the create/rename title
 * rule (the client-side mirror of the Host's guard) and the session-list
 * projection behind the rail's session switcher.
 */

import { describe, expect, it } from 'vitest'
import {
  cleanProjectTitle,
  nextSelectionAfterDelete,
  PROJECT_TITLE_MAX_LENGTH,
  sameSessionListView,
  sessionListView,
} from '../src/client/project-form.ts'

describe('cleanProjectTitle', () => {
  it('trims surrounding whitespace', () => {
    expect(cleanProjectTitle('  My Paper  ')).toBe('My Paper')
  })

  it('rejects blank and whitespace-only titles', () => {
    expect(cleanProjectTitle('')).toBeNull()
    expect(cleanProjectTitle('   ')).toBeNull()
  })

  it('rejects titles over the cap and accepts the cap itself', () => {
    expect(cleanProjectTitle('x'.repeat(PROJECT_TITLE_MAX_LENGTH))).toHaveLength(PROJECT_TITLE_MAX_LENGTH)
    expect(cleanProjectTitle('x'.repeat(PROJECT_TITLE_MAX_LENGTH + 1))).toBeNull()
  })
})

describe('nextSelectionAfterDelete', () => {
  const projects = [{ id: 'p1' }, { id: 'p2' }]

  it('leaves the selection alone when another project was deleted', () => {
    expect(nextSelectionAfterDelete(projects, 'p2', 'p1')).toBeUndefined()
    expect(nextSelectionAfterDelete(projects, 'p2', null)).toBeUndefined()
  })

  it('hands the selection to the first remaining project', () => {
    expect(nextSelectionAfterDelete(projects, 'p1', 'p1')).toBe('p2')
  })

  it('clears the selection when the deleted project was the last one', () => {
    expect(nextSelectionAfterDelete([{ id: 'p1' }], 'p1', 'p1')).toBeNull()
    expect(nextSelectionAfterDelete([], 'p1', 'p1')).toBeNull()
  })
})

describe('sessionListView', () => {
  it('projects the ids in order with the current selection', () => {
    const view = sessionListView({
      ids: ['s1', 's2'],
      byId: {
        s1: { displayTitle: 'First', running: true },
        s2: { displayTitle: 'Second', running: false },
      },
      current: 's2',
    })
    expect(view.current).toBe('s2')
    expect(view.list).toEqual([
      { id: 's1', title: 'First', running: true },
      { id: 's2', title: 'Second', running: false },
    ])
  })

  it('maps no selection to null and falls back to the id for a missing row', () => {
    const view = sessionListView({ ids: ['s1'], byId: {}, current: undefined })
    expect(view.current).toBeNull()
    expect(view.list).toEqual([{ id: 's1', title: 's1', running: false }])
  })
})

describe('sameSessionListView', () => {
  const base = sessionListView({
    ids: ['s1'],
    byId: { s1: { displayTitle: 'First', running: false } },
    current: 's1',
  })

  it('treats equal projections as identical (the adapter keeps identity)', () => {
    const again = sessionListView({
      ids: ['s1'],
      byId: { s1: { displayTitle: 'First', running: false } },
      current: 's1',
    })
    expect(sameSessionListView(base, again)).toBe(true)
  })

  it('spots a selection, membership, title, and running change', () => {
    expect(sameSessionListView(base, { ...base, current: null })).toBe(false)
    expect(sameSessionListView(base, { ...base, list: Object.freeze([]) })).toBe(false)
    expect(sameSessionListView(base, sessionListView({
      ids: ['s1'],
      byId: { s1: { displayTitle: 'Renamed', running: false } },
      current: 's1',
    }))).toBe(false)
    expect(sameSessionListView(base, sessionListView({
      ids: ['s1'],
      byId: { s1: { displayTitle: 'First', running: true } },
      current: 's1',
    }))).toBe(false)
  })
})
