/**
 * Behavior tests for the venue-catalog slice of the research panel
 * controller: the lazy project-scoped load (the watch list rides the read),
 * the manual upstream refresh, and the watch toggle's optimistic flip with
 * rollback on failure.
 */

import { describe, expect, it } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { ResearchController } from '../src/client/controller.ts'
import type { ResearchRemote } from '../src/client/controller.ts'
import type {
  ResearchRefreshVenueDeadlinesResult,
  ResearchSetVenueWatchResult,
  ResearchVenueDeadlinesResult,
  VenueDeadlineView,
} from 'dsh-mimir/types'

/** Wrap one business result in the carrier's success branch. */
function carried<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One deferred promise for driving in-flight Remote calls. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/**
 * Build a remote stub; unspecified calls reject, which no test path reaches.
 * A Proxy keeps the stub total over ResearchRemote without enumerating every
 * method, so a widening Remote face never silently drifts from a literal.
 */
function stubRemote(overrides: Partial<ResearchRemote>): ResearchRemote {
  const target: Record<PropertyKey, unknown> = {}
  const stub = new Proxy(target, {
    get: (t, prop) => {
      if (prop in t) return t[prop]
      // Keep the stub non-thenable so it is never accidentally awaited.
      if (prop === 'then') return undefined
      return () => Promise.reject(new Error(`unexpected ${String(prop)} call`))
    },
  })
  Object.assign(stub, overrides)
  return stub as unknown as ResearchRemote
}

/** Flush the microtask queue so fire-and-forget loads settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

/** One catalog row factory. */
function venue(key: string): VenueDeadlineView {
  return {
    key,
    title: key.toUpperCase(),
    description: `The ${key} conference`,
    sub: 'AI',
    ccfRank: 'A',
    dblp: null,
    conf: { year: 2027, id: `${key}27`, link: '', date: '', place: '', timeline: [] },
    nextDeadlineAt: null,
    nextDeadlineKind: null,
  }
}

/** One catalog answer for one project's watch list. */
function catalogAnswer(watched: readonly string[]): ResearchVenueDeadlinesResult {
  return {
    ok: true,
    value: {
      venues: [venue('cvpr'), venue('sosp')],
      journals: [],
      watched,
      fetchedAt: '2026-09-01T00:00:00.000Z',
    },
  }
}

describe('ensureVenues / refreshVenues', () => {
  it('loads the catalog once; a same-project ensure is a no-op', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      listVenueDeadlines: ({ projectId }) => {
        calls += 1
        expect(projectId).toBe('p1')
        return Promise.resolve(carried(catalogAnswer(['cvpr'])))
      },
    }))
    expect(controller.getSnapshot().venues.status).toBe('cold')
    controller.ensureVenues('p1')
    expect(controller.getSnapshot().venues.status).toBe('loading')
    await settle()
    expect(controller.getSnapshot().venues).toMatchObject({
      status: 'ready', watchedProjectId: 'p1', watched: ['cvpr'], fetchedAt: '2026-09-01T00:00:00.000Z',
    })
    expect(controller.getSnapshot().venues.list.map(row => row.key)).toEqual(['cvpr', 'sosp'])
    controller.ensureVenues('p1')
    expect(calls).toBe(1)
  })

  it('refetches when the watch list was loaded for another project', async () => {
    const seen: (string | undefined)[] = []
    const controller = new ResearchController(stubRemote({
      listVenueDeadlines: ({ projectId }) => {
        seen.push(projectId)
        return Promise.resolve(carried(catalogAnswer([])))
      },
    }))
    controller.ensureVenues('p1')
    await settle()
    controller.ensureVenues('p2')
    await settle()
    expect(seen).toEqual(['p1', 'p2'])
    expect(controller.getSnapshot().venues.watchedProjectId).toBe('p2')
  })

  it('publishes the business failure and stays retryable', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      listVenueDeadlines: () => {
        calls += 1
        return Promise.resolve(carried<ResearchVenueDeadlinesResult>(
          calls === 1
            ? { ok: false, error: { code: 'operation-failed', message: 'boom' } }
            : catalogAnswer([]),
        ))
      },
    }))
    controller.ensureVenues(null)
    await settle()
    expect(controller.getSnapshot().venues).toMatchObject({ status: 'error', failure: { code: 'operation-failed' } })
    controller.refreshVenues(null)
    await settle()
    expect(controller.getSnapshot().venues.status).toBe('ready')
    expect(calls).toBe(2)
  })

  it('queues a load requested mid-flight and discards the stale reply', async () => {
    const first = deferred<RemoteResult<ResearchVenueDeadlinesResult>>()
    const seen: (string | undefined)[] = []
    const controller = new ResearchController(stubRemote({
      listVenueDeadlines: ({ projectId }) => {
        seen.push(projectId)
        return seen.length === 1
          ? first.promise
          : Promise.resolve(carried(catalogAnswer(['sosp'])))
      },
    }))
    controller.ensureVenues('p1')
    // A project switch mid-flight must queue a reload: publishing p1's reply
    // would flash p1's watch list under p2.
    controller.ensureVenues('p2')
    first.resolve(carried(catalogAnswer(['cvpr'])))
    await settle()
    expect(seen).toEqual(['p1', 'p2'])
    const venues = controller.getSnapshot().venues
    expect(venues.watchedProjectId).toBe('p2')
    expect(venues.watched).toEqual(['sosp'])
  })
})

describe('refreshVenueCatalog', () => {
  it('refreshes upstream, toasts, and reloads the slice', async () => {
    let lists = 0
    const controller = new ResearchController(stubRemote({
      refreshVenueDeadlines: () => Promise.resolve(carried<ResearchRefreshVenueDeadlinesResult>(
        { ok: true, value: { fetchedAt: '2026-09-02T00:00:00.000Z' } },
      )),
      listVenueDeadlines: () => {
        lists += 1
        return Promise.resolve(carried(catalogAnswer([])))
      },
    }))
    controller.ensureVenues('p1')
    await settle()
    await controller.refreshVenueCatalog('p1')
    expect(lists).toBe(2)
    expect(controller.getSnapshot().toasts.some(toast => toast.kind === 'success')).toBe(true)
  })

  it('a failed upstream refresh toasts and keeps the old slice', async () => {
    const controller = new ResearchController(stubRemote({
      refreshVenueDeadlines: () => Promise.resolve(carried<ResearchRefreshVenueDeadlinesResult>(
        { ok: false, error: { code: 'operation-failed', message: 'offline' } },
      )),
      listVenueDeadlines: () => Promise.resolve(carried(catalogAnswer(['cvpr']))),
    }))
    controller.ensureVenues('p1')
    await settle()
    await controller.refreshVenueCatalog('p1')
    const venues = controller.getSnapshot().venues
    expect(venues.status).toBe('ready')
    expect(venues.watched).toEqual(['cvpr'])
    expect(controller.getSnapshot().toasts.some(toast => toast.kind === 'error')).toBe(true)
  })
})

describe('toggleVenueWatch', () => {
  it('flips the star optimistically and settles the remote call', async () => {
    const writes: { series: string, watched: boolean }[] = []
    const controller = new ResearchController(stubRemote({
      listVenueDeadlines: () => Promise.resolve(carried(catalogAnswer([]))),
      setVenueWatch: ({ series, watched }) => {
        writes.push({ series, watched })
        return Promise.resolve(carried<ResearchSetVenueWatchResult>(
          { ok: true, value: { projectId: 'p1', series, watched } },
        ))
      },
    }))
    controller.ensureVenues('p1')
    await settle()
    const pending = controller.toggleVenueWatch('cvpr')
    // Optimistic: the flag flips before the remote settles.
    expect(controller.getSnapshot().venues.watched).toEqual(['cvpr'])
    await pending
    expect(writes).toEqual([{ series: 'cvpr', watched: true }])
    expect(controller.getSnapshot().venues.watched).toEqual(['cvpr'])
  })

  it('rolls the star back and toasts when the write fails', async () => {
    const controller = new ResearchController(stubRemote({
      listVenueDeadlines: () => Promise.resolve(carried(catalogAnswer(['cvpr']))),
      setVenueWatch: () => Promise.resolve(carried<ResearchSetVenueWatchResult>(
        { ok: false, error: { code: 'operation-failed', message: 'disk full' } },
      )),
    }))
    controller.ensureVenues('p1')
    await settle()
    await controller.toggleVenueWatch('cvpr')
    expect(controller.getSnapshot().venues.watched).toEqual(['cvpr'])
    expect(controller.getSnapshot().toasts.some(toast => toast.kind === 'error')).toBe(true)
  })

  it('rolls back only the failed flip when another toggle settled mid-flight', async () => {
    const slowWrite = deferred<RemoteResult<ResearchSetVenueWatchResult>>()
    const controller = new ResearchController(stubRemote({
      listVenueDeadlines: () => Promise.resolve(carried(catalogAnswer(['cvpr']))),
      setVenueWatch: ({ series, watched }) => series === 'cvpr'
        ? slowWrite.promise
        : Promise.resolve(carried<ResearchSetVenueWatchResult>(
          { ok: true, value: { projectId: 'p1', series, watched } },
        )),
    }))
    controller.ensureVenues('p1')
    await settle()
    const failing = controller.toggleVenueWatch('cvpr') // optimistic: []
    await controller.toggleVenueWatch('sosp') // optimistic: ['sosp'], settles
    expect(controller.getSnapshot().venues.watched).toEqual(['sosp'])
    slowWrite.resolve(carried<ResearchSetVenueWatchResult>(
      { ok: false, error: { code: 'operation-failed', message: 'disk full' } },
    ))
    await failing
    // cvpr is restored; the settled sosp toggle survives the rollback.
    expect(controller.getSnapshot().venues.watched).toEqual(['sosp', 'cvpr'])
  })

  it('is a no-op without a project-scoped watch list', async () => {
    const controller = new ResearchController(stubRemote({}))
    await controller.toggleVenueWatch('cvpr')
    expect(controller.getSnapshot().venues.watched).toEqual([])
  })
})
