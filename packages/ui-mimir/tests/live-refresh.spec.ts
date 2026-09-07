/**
 * Behavior tests for the live-refresh pure logic: the change→slice mapping
 * and the trailing-debounce aggregator that collapses an agent's write burst
 * into one refresh pass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWikiChangeAggregator, slicesForWikiChange } from '../src/client/live-refresh.ts'
import type { LiveSlice } from '../src/client/live-refresh.ts'
import type { ResearchWikiChangeEvent } from 'dsh-mimir/types'

/** One change frame shorthand. */
function change(table: string, key = 'k'): ResearchWikiChangeEvent {
  return { table, key, operation: 'put' }
}

describe('slicesForWikiChange', () => {
  it('maps every domain table and the file-side pseudo-tables to their slices', () => {
    expect(slicesForWikiChange(change('projects'))).toEqual(['projects'])
    expect(slicesForWikiChange(change('papers'))).toEqual(['papers'])
    expect(slicesForWikiChange(change('experiments'))).toEqual(['experiments'])
    expect(slicesForWikiChange(change('figures'))).toEqual(['figures'])
    expect(slicesForWikiChange(change('servers'))).toEqual(['servers'])
    expect(slicesForWikiChange(change('jobs'))).toEqual(['jobs'])
    expect(slicesForWikiChange(change('venue_watches'))).toEqual(['venues'])
    expect(slicesForWikiChange(change('events'))).toEqual(['ledger'])
    expect(slicesForWikiChange(change('paper-source', 'p1'))).toEqual(['paper'])
    expect(slicesForWikiChange(change('bibliography', 'p1'))).toEqual(['bibliography'])
  })

  it('maps CBE-internal and unknown tables to nothing', () => {
    expect(slicesForWikiChange(change('ideas'))).toEqual([])
    expect(slicesForWikiChange(change('claims'))).toEqual([])
    expect(slicesForWikiChange(change('nope'))).toEqual([])
  })
})

describe('createWikiChangeAggregator', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('collapses a burst into one flush carrying the slice union', () => {
    const flushes: ReadonlySet<LiveSlice>[] = []
    const aggregator = createWikiChangeAggregator(slices => flushes.push(slices), 400)
    // An agent importing ten papers in a row — a true burst (same tick).
    for (let index = 0; index < 10; index += 1) {
      aggregator.push(change('papers', `2608.0000${index}`))
    }
    expect(aggregator.pending()).toBe(true)
    expect(flushes).toHaveLength(0)
    vi.advanceTimersByTime(400)
    expect(flushes).toHaveLength(1)
    expect([...flushes[0]!]).toEqual(['papers'])
    expect(aggregator.pending()).toBe(false)
  })

  it('does not re-arm the timer on events that add no new slice', () => {
    const flushes: ReadonlySet<LiveSlice>[] = []
    const aggregator = createWikiChangeAggregator(slices => flushes.push(slices), 400)
    aggregator.push(change('papers'))
    vi.advanceTimersByTime(300)
    // Neither an unmappable event nor a repeat of the pending slice extends
    // the quiet window: the flush still lands at t=400.
    aggregator.push(change('ideas'))
    aggregator.push(change('papers', 'other'))
    vi.advanceTimersByTime(100)
    expect(flushes).toHaveLength(1)
    expect([...flushes[0]!]).toEqual(['papers'])
  })

  it('never starves a sustained same-table stream', () => {
    const flushes: ReadonlySet<LiveSlice>[] = []
    const aggregator = createWikiChangeAggregator(slices => flushes.push(slices), 400)
    // Writes keep landing every 300ms — faster than the 400ms quiet window.
    for (let index = 0; index < 6; index += 1) {
      aggregator.push(change('papers', `k${index}`))
      vi.advanceTimersByTime(300)
    }
    // Flushes fired mid-stream (t=400, 1000, 1600) instead of waiting for
    // the stream to end.
    expect(flushes).toHaveLength(3)
    expect(aggregator.pending()).toBe(false)
  })

  it('caps a stream of distinct slices at the max-wait deadline', () => {
    const flushes: ReadonlySet<LiveSlice>[] = []
    const aggregator = createWikiChangeAggregator(slices => flushes.push(slices), 400, 2000)
    // Every 300ms a NEW slice arrives; each would re-arm the trailing timer,
    // postponing the flush to t=2200 without the cap.
    const tables = ['papers', 'experiments', 'figures', 'servers', 'jobs', 'venue_watches', 'events']
    for (const table of tables) {
      aggregator.push(change(table))
      vi.advanceTimersByTime(300)
    }
    // The deadline fired at t=2000 carrying the slices seen so far.
    expect(flushes).toHaveLength(1)
    expect([...flushes[0]!].sort()).toEqual(['experiments', 'figures', 'jobs', 'ledger', 'papers', 'servers', 'venues'])
    // The stream's tail settles on its own trailing timer.
    aggregator.push(change('bibliography', 'p1'))
    vi.advanceTimersByTime(400)
    expect(flushes).toHaveLength(2)
    expect([...flushes[1]!]).toEqual(['bibliography'])
  })

  it('unions distinct slices of one burst and ignores unmappable events', () => {
    const flushes: ReadonlySet<LiveSlice>[] = []
    const aggregator = createWikiChangeAggregator(slices => flushes.push(slices), 400)
    aggregator.push(change('papers'))
    aggregator.push(change('ideas')) // unmappable: no slice, no re-arm needed
    aggregator.push(change('venue_watches'))
    vi.advanceTimersByTime(400)
    expect(flushes).toHaveLength(1)
    expect([...flushes[0]!].sort()).toEqual(['papers', 'venues'])
  })

  it('flushNow fires immediately and cancel drops the pending set', () => {
    const flushes: ReadonlySet<LiveSlice>[] = []
    const aggregator = createWikiChangeAggregator(slices => flushes.push(slices), 400)
    aggregator.push(change('figures'))
    aggregator.flushNow()
    expect(flushes).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(flushes).toHaveLength(1)
    aggregator.push(change('servers'))
    aggregator.cancel()
    expect(aggregator.pending()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(flushes).toHaveLength(1)
  })
})
