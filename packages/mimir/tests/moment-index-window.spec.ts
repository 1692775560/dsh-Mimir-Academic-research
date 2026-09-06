/**
 * Two moment-index follow-ups from #127, tracked as item 3 of #143.
 *
 *  - `resolveWindow` accepted `since > until`. An inverted window reads as an
 *    empty one, and "no events" is rendered as a quiet period -- which is the
 *    one thing these organs must not confuse, since dormancy is a signal here
 *    rather than an absence of signal.
 *  - `getMomentIndex`'s lookback prefix could be truncated without saying so.
 *    `loadLedgerWindow` keeps the NEWEST events when it caps, so a truncated
 *    prefix drops exactly the oldest history that dormancy and lane-opening
 *    are judged against.
 *
 * @module dsh-mimir/tests/moment-index-window
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import { LIST_EVENTS_MAX_LIMIT } from '../src/ledger.ts'
import type { EventRecord, LedgerActor } from '../src/types.ts'

const USER: LedgerActor = { kind: 'user', id: 'panel' }

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function serviceHarness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-moment-window-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
  })
  return { domain, service }
}

function eventAt(index: number, ts: string): EventRecord {
  return Object.freeze({
    id: `ev-${String(index).padStart(5, '0')}`,
    ts,
    actor: USER,
    action: 'knowledge.idea.added',
    refs: Object.freeze({}),
    payload: Object.freeze({}),
  }) as EventRecord
}

describe('moment index window bounds', () => {
  it('an inverted since/until is normalised rather than read as empty', async () => {
    const { domain, service } = await serviceHarness()
    for (let index = 0; index < 5; index += 1) {
      const ts = `2026-08-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`
      await domain.table('events').put(`ev-${String(index)}`, eventAt(index, ts))
    }

    // Bounds the wrong way round. Before the guard this returned a window
    // that matched nothing, and the view reported it as a quiet period.
    const inverted = await service.getMomentIndex({
      since: '2026-08-20T00:00:00.000Z',
      until: '2026-08-01T00:00:00.000Z',
    })

    expect(inverted.ok).toBe(true)
    if (!inverted.ok) return
    expect(new Date(inverted.value.window.since).getTime()).toBeLessThanOrEqual(
      new Date(inverted.value.window.until).getTime(),
    )
    expect(inverted.value.window.since).toBe('2026-08-01T00:00:00.000Z')
    expect(inverted.value.window.until).toBe('2026-08-20T00:00:00.000Z')
    // And it now sees the events that fall inside the corrected span.
    expect(inverted.value.retrieval.eventsTotal).toBeGreaterThan(0)
  })

  it('an inverted window returns the same view as the corrected one', async () => {
    const { domain, service } = await serviceHarness()
    for (let index = 0; index < 5; index += 1) {
      const ts = `2026-08-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`
      await domain.table('events').put(`ev-${String(index)}`, eventAt(index, ts))
    }

    const inverted = await service.getMomentIndex({
      since: '2026-08-20T00:00:00.000Z',
      until: '2026-08-01T00:00:00.000Z',
    })
    const correct = await service.getMomentIndex({
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-20T00:00:00.000Z',
    })

    expect(inverted.ok && correct.ok).toBe(true)
    if (!inverted.ok || !correct.ok) return
    expect(inverted.value.window).toEqual(correct.value.window)
    expect(inverted.value.retrieval.eventsTotal).toBe(correct.value.retrieval.eventsTotal)
  })

  it('an ordinary window is untouched', async () => {
    const { service } = await serviceHarness()
    const result = await service.getMomentIndex({
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-20T00:00:00.000Z',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.window.since).toBe('2026-08-01T00:00:00.000Z')
    expect(result.value.window.until).toBe('2026-08-20T00:00:00.000Z')
  })

  it('equal bounds stay equal rather than being swapped', async () => {
    const { service } = await serviceHarness()
    const at = '2026-08-10T00:00:00.000Z'
    const result = await service.getMomentIndex({ since: at, until: at })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.window).toEqual({ since: at, until: at })
  })

  it('a malformed bound is still rejected, not swapped', async () => {
    const { service } = await serviceHarness()
    const result = await service.getMomentIndex({ since: 'not-a-date' })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })
})

describe('moment index lookback truncation', () => {
  it('declares a truncated lookback as a silence', async () => {
    // The lookback prefix reaches further back than the window, so it is the
    // first of the two to hit the cap. Filling only the prefix span proves
    // the new silence comes from the prefix rather than the window.
    const { domain, service } = await serviceHarness()

    const total = LIST_EVENTS_MAX_LIMIT + 50
    const base = Date.parse('2026-08-20T00:00:00.000Z')
    for (let index = 0; index < total; index += 1) {
      // Spread across the prefix span, all before the window's `since`.
      const ts = new Date(base - (index + 1) * 60_000).toISOString()
      await domain.table('events').put(`ev-${String(index)}`, eventAt(index, ts))
    }

    const result = await service.getMomentIndex({
      since: '2026-08-20T00:00:00.000Z',
      until: '2026-08-21T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.retrieval.truncated).toBe(true)
    const silences = result.value.retrieval.silences.join(' ')
    expect(silences).toContain('lookback truncated')
    // The message has to say *what it costs*, not merely that it happened.
    expect(silences).toMatch(/dormancy/i)
  })

  it('reports no silence when nothing was truncated', async () => {
    const { domain, service } = await serviceHarness()
    for (let index = 0; index < 5; index += 1) {
      const ts = `2026-08-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`
      await domain.table('events').put(`ev-${String(index)}`, eventAt(index, ts))
    }

    const result = await service.getMomentIndex({
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-08-20T00:00:00.000Z',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.retrieval.truncated).toBe(false)
    expect(result.value.retrieval.silences).toEqual([])
  })
})
