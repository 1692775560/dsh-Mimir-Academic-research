/**
 * Behavior tests for the arXiv subscription surface: the JSON file storage
 * round trip and its fail-open reads, the save/delete validation, and the
 * new-paper check — baseline seeding on the first run, the seenIds diff,
 * per-subscription failure isolation, and the caps. The arXiv API is stubbed
 * by injecting `fetchSearch`; a real temp directory stands in for the
 * workspace.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ARXIV_SUBSCRIPTIONS_FILE,
  ARXIV_SUBSCRIPTION_NEW_LIMIT,
  ARXIV_SUBSCRIPTION_SEEN_LIMIT,
  foldArxivSubscriptionCheck,
  loadArxivSubscriptions,
  runArxivSubscriptionCheck,
  saveArxivSubscriptions,
} from '../src/arxiv-subscriptions.ts'
import type { ArxivSubscriptionRecord } from '../src/arxiv-subscriptions.ts'
import {
  checkArxivSubscriptions,
  deleteArxivSubscription,
  listArxivSubscriptions,
  saveArxivSubscription,
} from '../src/services/subscriptions.ts'
import type { ArxivEntry } from '../src/tools/arxiv.ts'

/** One fresh temp workspace per test. */
async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mimir-subscriptions-'))
}

/** One minimal entry factory. */
function entry(id: string): ArxivEntry {
  return {
    id,
    title: `Paper ${id}`,
    authors: ['Doe, Jane'],
    summary: `Summary of ${id}`,
    published: '2026-08-01T00:00:00Z',
    url: `https://arxiv.org/abs/${id}`,
  }
}

/** One stored-record factory (checked once, having seen base). */
function record(id: string, query: string, seenIds: readonly string[] = ['2608.00001v1']): ArxivSubscriptionRecord {
  return {
    id,
    query,
    createdAt: '2026-08-20T00:00:00.000Z',
    lastCheckedAt: '2026-08-21T00:00:00.000Z',
    seenIds,
    newEntryIds: [],
    newEntries: [],
  }
}

/** A manually settled promise for coordinating concurrent check calls. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

describe('arXiv subscription storage', () => {
  it('round-trips the list through the JSON file', async () => {
    const dir = await workspace()
    const records = [record('s1', 'mesh reconstruction'), record('s2', 'gaussian splatting', [])]
    await saveArxivSubscriptions(dir, records)
    expect(await loadArxivSubscriptions(dir)).toEqual(records)
    // The file lives at the workspace root as plain JSON.
    const raw = JSON.parse(await readFile(join(dir, ARXIV_SUBSCRIPTIONS_FILE), 'utf8'))
    expect(raw).toHaveLength(2)
  })

  it('reads a missing or malformed file as empty and drops invalid records', async () => {
    const dir = await workspace()
    expect(await loadArxivSubscriptions(dir)).toEqual([])
    await writeFile(join(dir, ARXIV_SUBSCRIPTIONS_FILE), 'not json')
    expect(await loadArxivSubscriptions(dir)).toEqual([])
    await writeFile(join(dir, ARXIV_SUBSCRIPTIONS_FILE), JSON.stringify([
      record('s1', 'mesh'),
      { id: 'broken' },
      'garbage',
      42,
    ]))
    expect(await loadArxivSubscriptions(dir)).toEqual([record('s1', 'mesh')])
  })
})

describe('saveArxivSubscription / deleteArxivSubscription', () => {
  it('saves a trimmed query and rejects empty, overlong, and duplicate ones', async () => {
    const dir = await workspace()
    const deps = { workspaceDir: dir }
    await expect(saveArxivSubscription(deps, { query: '   ' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(saveArxivSubscription(deps, { query: 'x'.repeat(201) }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    const saved = await saveArxivSubscription(deps, { query: '  mesh reconstruction  ' })
    expect(saved).toMatchObject({
      ok: true,
      value: { subscription: { query: 'mesh reconstruction', lastCheckedAt: null, newEntries: [] } },
    })
    // Duplicates compare trimmed and case-insensitively.
    await expect(saveArxivSubscription(deps, { query: 'Mesh Reconstruction' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    const listed = await listArxivSubscriptions(deps)
    expect(listed.ok && listed.value.subscriptions.length).toBe(1)
  })

  it('deletes by id and reports subscription-not-found for an unknown one', async () => {
    const dir = await workspace()
    const deps = { workspaceDir: dir }
    const saved = await saveArxivSubscription(deps, { query: 'mesh' })
    const id = saved.ok ? saved.value.subscription.id : ''
    await expect(deleteArxivSubscription(deps, { id })).resolves.toEqual({ ok: true, value: { id } })
    await expect(deleteArxivSubscription(deps, { id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'subscription-not-found', id } })
    const listed = await listArxivSubscriptions(deps)
    expect(listed.ok && listed.value.subscriptions.length).toBe(0)
  })
})

describe('foldArxivSubscriptionCheck', () => {
  it('seeds the baseline on the first check without surfacing new entries', () => {
    const fresh: ArxivSubscriptionRecord = { ...record('s1', 'mesh', []), lastCheckedAt: null }
    const now = new Date('2026-08-23T00:00:00.000Z')
    const { record: folded, added } = foldArxivSubscriptionCheck(fresh, [entry('a'), entry('b')], now)
    expect(added).toEqual([])
    expect(folded.seenIds).toEqual(['a', 'b'])
    expect(folded.newEntryIds).toEqual([])
    expect(folded.lastCheckedAt).toBe(now.toISOString())
  })

  it('surfaces unseen entries, accumulates them newest first, and caps both lists', () => {
    const now = new Date('2026-08-23T00:00:00.000Z')
    const first = foldArxivSubscriptionCheck(record('s1', 'mesh', ['b']), [entry('a'), entry('b')], now)
    expect(first.added.map(item => item.id)).toEqual(['a'])
    expect(first.record.newEntryIds).toEqual(['a'])
    expect(first.record.newEntries.map(item => item.id)).toEqual(['a'])
    // A second check keeps the earlier find and adds the new one, newest first.
    const second = foldArxivSubscriptionCheck(first.record, [entry('c'), entry('b')], now)
    expect(second.added.map(item => item.id)).toEqual(['c'])
    expect(second.record.newEntryIds).toEqual(['c', 'a'])
    expect(second.record.newEntries.map(item => item.id)).toEqual(['c', 'a'])
    // The seen cap keeps the newest ids.
    const crowded: ArxivSubscriptionRecord = {
      ...record('s1', 'mesh', Array.from({ length: ARXIV_SUBSCRIPTION_SEEN_LIMIT }, (_, index) => `old-${index}`)),
    }
    const trimmed = foldArxivSubscriptionCheck(crowded, [entry('fresh')], now)
    expect(trimmed.record.seenIds.length).toBe(ARXIV_SUBSCRIPTION_SEEN_LIMIT)
    expect(trimmed.record.seenIds[0]).toBe('fresh')
    // The new-entry cap drops the oldest accumulated entries (details included).
    let accumulated = record('s2', 'mesh', [])
    for (let round = 0; round < ARXIV_SUBSCRIPTION_NEW_LIMIT + 10; round += 1) {
      accumulated = foldArxivSubscriptionCheck(accumulated, [entry(`n-${round}`)], now).record
    }
    expect(accumulated.newEntryIds.length).toBe(ARXIV_SUBSCRIPTION_NEW_LIMIT)
    expect(accumulated.newEntries.length).toBe(ARXIV_SUBSCRIPTION_NEW_LIMIT)
    expect(accumulated.newEntryIds[0]).toBe(`n-${ARXIV_SUBSCRIPTION_NEW_LIMIT + 9}`)
  })
})

describe('runArxivSubscriptionCheck', () => {
  it('checks serially with the polite gap and persists the updated records', async () => {
    const dir = await workspace()
    await saveArxivSubscriptions(dir, [record('s1', 'mesh', ['a']), record('s2', 'splatting', ['x'])])
    const queries: string[] = []
    let sleeps = 0
    const outcomes = await runArxivSubscriptionCheck(dir, {
      gapMs: 5,
      sleep: async () => { sleeps += 1 },
      now: new Date('2026-08-23T00:00:00.000Z'),
      fetchSearch: async (query, _maxResults, _signal, options) => {
        queries.push(query)
        expect(options?.sortBySubmittedDate).toBe(true)
        return query === 'mesh' ? [entry('b'), entry('a')] : [entry('x')]
      },
    })
    expect(outcomes).toHaveLength(2)
    expect(queries).toEqual(['mesh', 'splatting'])
    expect(sleeps).toBe(1)
    expect(outcomes?.[0]?.added.map(item => item.id)).toEqual(['b'])
    expect(outcomes?.[1]?.added).toEqual([])
    const persisted = await loadArxivSubscriptions(dir)
    expect(persisted[0]?.newEntryIds).toEqual(['b'])
    expect(persisted[0]?.lastCheckedAt).toBe('2026-08-23T00:00:00.000Z')
    expect(persisted[1]?.newEntryIds).toEqual([])
  })

  it('isolates one subscription failure and never persists its record', async () => {
    const dir = await workspace()
    await saveArxivSubscriptions(dir, [record('s1', 'mesh', ['a']), record('s2', 'splatting', ['x'])])
    const outcomes = await runArxivSubscriptionCheck(dir, {
      gapMs: 0,
      fetchSearch: async (query) => {
        if (query === 'mesh') throw new Error('HTTP 503')
        return [entry('y')]
      },
    })
    expect(outcomes?.[0]?.error).toBeInstanceOf(Error)
    expect(outcomes?.[0]?.record.seenIds).toEqual(['a'])
    expect(outcomes?.[1]?.added.map(item => item.id)).toEqual(['y'])
    const persisted = await loadArxivSubscriptions(dir)
    // The failed record is untouched; the clean one settled.
    expect(persisted[0]?.lastCheckedAt).toBe('2026-08-21T00:00:00.000Z')
    expect(persisted[1]?.seenIds).toEqual(['y', 'x'])
  })

  it('keeps subscriptions added mid-check and honors mid-check deletions', async () => {
    const dir = await workspace()
    await saveArxivSubscriptions(dir, [record('s1', 'mesh', ['a']), record('s2', 'splatting', ['x'])])
    const added = record('s3', 'diffusion', ['d'])
    const outcomes = await runArxivSubscriptionCheck(dir, {
      gapMs: 0,
      now: new Date('2026-08-23T00:00:00.000Z'),
      fetchSearch: async (query) => {
        if (query === 'mesh') {
          // A subscription added while the check is in flight must survive the save.
          await saveArxivSubscriptions(dir, [record('s1', 'mesh', ['a']), record('s2', 'splatting', ['x']), added])
        }
        if (query === 'splatting') {
          // A deletion mid-window must be honored, not resurrected by the merge.
          await saveArxivSubscriptions(dir, [record('s1', 'mesh', ['a']), added])
        }
        return query === 'mesh' ? [entry('b')] : [entry('x')]
      },
    })
    expect(outcomes).toHaveLength(2)
    const persisted = await loadArxivSubscriptions(dir)
    expect(persisted.map(item => item.id)).toEqual(['s1', 's3'])
    // The check-updated state landed on the surviving record; the addition is untouched.
    expect(persisted[0]?.newEntryIds).toEqual(['b'])
    expect(persisted[1]).toEqual(added)
  })

  it('coalesces concurrent checks without losing the settled update', async () => {
    const dir = await workspace()
    await saveArxivSubscriptions(dir, [record('s1', 'mesh', ['base'])])
    const first = deferred<ArxivEntry[]>()
    let calls = 0
    const fetchSearch = async (): Promise<ArxivEntry[]> => {
      calls += 1
      return calls === 1 ? first.promise : [entry('right'), entry('base')]
    }
    const left = runArxivSubscriptionCheck(dir, { gapMs: 0, fetchSearch })
    await Promise.resolve()
    const right = runArxivSubscriptionCheck(dir, { gapMs: 0, fetchSearch })
    first.resolve([entry('left'), entry('base')])
    await Promise.all([left, right])
    expect(calls).toBe(1)
    const [persisted] = await loadArxivSubscriptions(dir)
    expect(persisted?.seenIds).toEqual(expect.arrayContaining(['left', 'base']))
    expect(persisted?.newEntryIds).toEqual(expect.arrayContaining(['left']))
  })

  it('does NOT fold a single-subscription check into a full run in flight', async () => {
    const dir = await workspace()
    await saveArxivSubscriptions(dir, [record('s1', 'mesh', ['base']), record('s2', 'splatting', ['x'])])
    const slow = deferred<ArxivEntry[]>()
    const fetchSearch = async (query: string): Promise<ArxivEntry[]> =>
      query === 'mesh' ? slow.promise : [entry('y'), entry('x')]
    // The full run parks on s1's fetch; a single-target check for s2 must run
    // on its own and return only s2's outcome.
    const full = runArxivSubscriptionCheck(dir, { gapMs: 0, fetchSearch, now: new Date('2026-08-23T00:00:00.000Z') })
    await Promise.resolve()
    const single = await runArxivSubscriptionCheck(dir, { gapMs: 0, id: 's2', fetchSearch, now: new Date('2026-08-23T00:00:00.000Z') })
    expect(single).toHaveLength(1)
    expect(single?.[0]?.record.id).toBe('s2')
    expect(single?.[0]?.record.newEntryIds).toEqual(['y'])
    slow.resolve([entry('b'), entry('base')])
    const outcomes = await full
    expect(outcomes).toHaveLength(2)
    // Both checks' updates survived: s1 from the full run, s2 from the single.
    const persisted = await loadArxivSubscriptions(dir)
    expect(persisted.find(item => item.id === 's1')?.newEntryIds).toEqual(['b'])
    expect(persisted.find(item => item.id === 's2')?.newEntryIds).toEqual(['y'])
  })

  it('returns undefined for an unknown id and skips the fetch entirely', async () => {
    const dir = await workspace()
    await saveArxivSubscriptions(dir, [record('s1', 'mesh')])
    let fetches = 0
    const outcomes = await runArxivSubscriptionCheck(dir, {
      id: 'nope',
      fetchSearch: async () => { fetches += 1; return [] },
    })
    expect(outcomes).toBeUndefined()
    expect(fetches).toBe(0)
  })

  it('fires no request over an empty list', async () => {
    const dir = await workspace()
    let fetches = 0
    const outcomes = await runArxivSubscriptionCheck(dir, {
      fetchSearch: async () => { fetches += 1; return [] },
    })
    expect(outcomes).toEqual([])
    expect(fetches).toBe(0)
  })

  it('service CRUD inside the check window neither loses the check update nor resurrects a deletion', async () => {
    const dir = await workspace()
    await saveArxivSubscriptions(dir, [record('s1', 'mesh', ['base']), record('s2', 'splatting', ['x'])])
    const slow = deferred<ArxivEntry[]>()
    const check = runArxivSubscriptionCheck(dir, {
      gapMs: 0,
      now: new Date('2026-08-23T00:00:00.000Z'),
      fetchSearch: async (query) => query === 'mesh' ? slow.promise : [entry('x')],
    })
    await Promise.resolve()
    // The panel's add/delete go through the SAME file lock as the check's
    // save: they land after the check's persistence, and the check's earlier
    // in-window state can never overwrite them.
    const added = await saveArxivSubscription({ workspaceDir: dir }, { query: 'diffusion' })
    expect(added.ok).toBe(true)
    const deleted = await deleteArxivSubscription({ workspaceDir: dir }, { id: 's2' })
    expect(deleted.ok).toBe(true)
    slow.resolve([entry('b'), entry('base')])
    await check
    const persisted = await loadArxivSubscriptions(dir)
    expect(persisted.map(item => item.id)).toHaveLength(2)
    expect(persisted.some(item => item.id === 's2')).toBe(false) // not resurrected
    expect(persisted.some(item => item.query === 'diffusion')).toBe(true) // not lost
    expect(persisted.find(item => item.id === 's1')?.newEntryIds).toEqual(['b']) // check update kept
  })
})

describe('checkArxivSubscriptions (domain)', () => {
  it('returns per-subscription views with entry details and error messages', async () => {
    const dir = await workspace()
    const deps = { workspaceDir: dir }
    await saveArxivSubscriptions(dir, [record('s1', 'mesh', ['a']), record('s2', 'broken', ['x'])])
    const outcome = await checkArxivSubscriptions(deps, {}, {
      gapMs: 0,
      fetchSearch: async (query) => {
        if (query === 'broken') throw new Error('socket hangup')
        return [entry('b')]
      },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.checks[0]).toMatchObject({
      subscription: { id: 's1', newEntries: [entry('b')] },
      added: [entry('b')],
      error: null,
    })
    expect(outcome.value.checks[1]).toMatchObject({
      subscription: { id: 's2', newEntries: [] },
      added: [],
      error: 'socket hangup',
    })
  })

  it('rejects an unknown id as subscription-not-found', async () => {
    const dir = await workspace()
    await expect(checkArxivSubscriptions({ workspaceDir: dir }, { id: 'nope' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'subscription-not-found', id: 'nope' } })
  })
})
