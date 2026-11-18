/**
 * The #222 trigger matrix: every lazy slice answers the same three questions
 * the issue asks about — what happens on first open, on a revisit after a
 * failure, and on a reconnect — and the answers come from one table instead of
 * from each `ensure*` method's private guard.
 *
 * Two halves:
 *  - the policy table itself (pure, exhaustive);
 *  - the controller applying it, driven through the real trigger entry points
 *    the panel calls, so a rule that only exists in the table fails here.
 */

import { describe, expect, it } from 'vitest'
import { ResearchController } from '../src/client/controller.ts'
import type { ResearchRemote } from '../src/client/controller.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RESEARCH_PROTOCOL_VERSION } from '../src/client/protocol.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Test-only carrier failure code for unreachable-host simulations. */
    'unavailable': {}
  }
}
import {
  isProjectScoped,
  LOAD_MATRIX,
  sliceAction,
  SLICES_BY_TAB,
  type LazySlice,
  type LoadTrigger,
} from '../src/client/slice-policy.ts'
import type {
  ResearchArxivSubscriptionsResult,
  ResearchListJobsResult,
  ResearchListProjectsResult,
  ResearchPapersResult,
} from 'dsh-mimir/types'

const carried = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const failed = <T>(code: 'unavailable', message: string): RemoteResult<T> => ({
  ok: false, error: new RemoteError(code, message, {}),
})

const NO_PROJECTS: ResearchListProjectsResult = { ok: true, value: { projects: [] } }
const NO_PAPERS: ResearchPapersResult = {
  ok: true, value: { papers: [] },
}
const NO_JOBS: ResearchListJobsResult = { ok: true, value: { jobs: [] } }
const NO_SUBSCRIPTIONS: ResearchArxivSubscriptionsResult = { ok: true, value: { subscriptions: [] } }

function stubRemote(overrides: Partial<ResearchRemote>): ResearchRemote {
  const target: Record<PropertyKey, unknown> = {}
  const stub = new Proxy(target, {
    get: (t, prop) => {
      if (prop in t) return t[prop]
      if (prop === 'then') return undefined
      return () => Promise.reject(new Error(`unexpected ${String(prop)} call`))
    },
  })
  return Object.assign(stub as unknown as ResearchRemote, overrides)
}

/** Settle the microtasks of a void-fired load. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve()
}

const ALL_SLICES: readonly LazySlice[] = [
  'projects', 'papers', 'subscriptions', 'zotero', 'jobs', 'venues', 'figures', 'artifact',
]
const ALL_TRIGGERS: readonly LoadTrigger[] = ['first-open', 'revisit', 'reconnect', 'project-switch', 'retry']

describe('slice policy table', () => {
  it('answers deterministically for every status × trigger pair', () => {
    const statuses = ['cold', 'loading', 'ready', 'error'] as const
    for (const trigger of ALL_TRIGGERS) {
      for (const status of statuses) {
        const action = sliceAction(status, false, trigger)
        expect(['load', 'refresh', 'skip']).toContain(action)
      }
    }
  })

  it('never starts a second concurrent load', () => {
    for (const trigger of ALL_TRIGGERS) {
      for (const status of ['cold', 'loading', 'ready', 'error'] as const) {
        expect(sliceAction(status, true, trigger)).toBe('skip')
      }
    }
  })

  it('leaves a settled slice alone on a first open', () => {
    expect(sliceAction('ready', false, 'first-open')).toBe('skip')
  })

  it('loads a cold slice and retries a failed one on a first open', () => {
    expect(sliceAction('cold', false, 'first-open')).toBe('load')
    // The regression behind #222: this used to be `skip` for good.
    expect(sliceAction('error', false, 'first-open')).toBe('load')
    expect(sliceAction('error', false, 'revisit')).toBe('load')
  })

  it('refreshes a settled slice in place on a reconnect, and retries a failed one', () => {
    expect(sliceAction('ready', false, 'reconnect')).toBe('refresh')
    expect(sliceAction('error', false, 'reconnect')).toBe('load')
    expect(sliceAction('cold', false, 'reconnect')).toBe('skip')
  })

  it('treats a project switch like a reconnect for the scoped slices', () => {
    expect(sliceAction('ready', false, 'project-switch')).toBe('refresh')
    expect(sliceAction('error', false, 'project-switch')).toBe('load')
  })

  it('always acts on an explicit retry', () => {
    expect(sliceAction('ready', false, 'retry')).toBe('refresh')
    expect(sliceAction('error', false, 'retry')).toBe('load')
    expect(sliceAction('cold', false, 'retry')).toBe('load')
  })

  it('keys every trigger to real slices, scoped ones only in the switch row', () => {
    for (const trigger of ALL_TRIGGERS) {
      for (const slice of LOAD_MATRIX[trigger]) expect(ALL_SLICES).toContain(slice)
    }
    expect(LOAD_MATRIX['project-switch']).toEqual(['venues', 'figures', 'artifact'])
    for (const slice of LOAD_MATRIX['project-switch']) expect(isProjectScoped(slice)).toBe(true)
  })

  it('has a row for every tab, and every tab row names real slices', () => {
    for (const slices of Object.values(SLICES_BY_TAB)) {
      for (const slice of slices) expect(ALL_SLICES).toContain(slice)
    }
    expect(SLICES_BY_TAB.overview).toEqual(['papers', 'jobs', 'venues', 'figures'])
    expect(SLICES_BY_TAB.papers).toEqual(['papers', 'subscriptions', 'zotero'])
    expect(SLICES_BY_TAB.experiments).toEqual(['artifact'])
    expect(SLICES_BY_TAB.ledger).toEqual([])
  })
})

describe('ResearchController load matrix (#222)', () => {
  it('retries a failed papers load on the next trigger instead of stranding it', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      listPapers: () => {
        calls += 1
        return calls === 1
          ? Promise.resolve(failed<ResearchPapersResult>('unavailable', 'offline'))
          : Promise.resolve(carried(NO_PAPERS))
      },
    }))
    controller.loadSlice('papers', 'first-open')
    await settle()
    expect(controller.getSnapshot().papers.status).toBe('error')

    // Before #222 every ensure*早退 on `status === 'ready'`, so an errored
    // slice was only recoverable from that view's own button.
    controller.loadSlice('papers', 'revisit')
    await settle()
    expect(calls).toBe(2)
    expect(controller.getSnapshot().papers.status).toBe('ready')
  })

  it('does not re-load a settled slice on a first open', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      listPapers: () => {
        calls += 1
        return Promise.resolve(carried(NO_PAPERS))
      },
    }))
    controller.loadSlice('papers', 'first-open')
    await settle()
    controller.loadSlice('papers', 'first-open')
    await settle()
    expect(calls).toBe(1)
  })

  it('collapses concurrent asks into one request while in flight', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      listPapers: () => {
        calls += 1
        return Promise.resolve(carried(NO_PAPERS))
      },
    }))
    controller.loadSlice('papers', 'first-open')
    controller.loadSlice('papers', 'first-open')
    controller.loadSlice('papers', 'retry')
    await settle()
    expect(calls).toBe(1)
  })

  it('re-reads a failed slice on resync (the reconnect path)', async () => {
    let papers = 0
    const controller = new ResearchController(stubRemote({
      listProjects: () => Promise.resolve(carried(NO_PROJECTS)),
      listPapers: () => {
        papers += 1
        return papers === 1
          ? Promise.resolve(failed<ResearchPapersResult>('unavailable', 'offline'))
          : Promise.resolve(carried(NO_PAPERS))
      },
      getProtocolVersion: () => Promise.resolve(carried({ ok: true, value: { version: RESEARCH_PROTOCOL_VERSION } })),
    }))
    controller.loadSlice('projects', 'first-open')
    controller.loadSlice('papers', 'first-open')
    await settle()
    expect(controller.getSnapshot().papers.status).toBe('error')

    controller.resync()
    await settle()
    expect(controller.getSnapshot().papers.status).toBe('ready')
    expect(papers).toBe(2)
  })

  it('refreshes a settled slice on resync without flashing it cold', async () => {
    const seen: string[] = []
    let jobs = 0
    const controller = new ResearchController(stubRemote({
      listProjects: () => Promise.resolve(carried(NO_PROJECTS)),
      listJobs: () => {
        jobs += 1
        return Promise.resolve(carried(NO_JOBS))
      },
      getProtocolVersion: () => Promise.resolve(carried({ ok: true, value: { version: RESEARCH_PROTOCOL_VERSION } })),
    }))
    controller.loadSlice('projects', 'first-open')
    controller.loadSlice('jobs', 'first-open')
    await settle()
    // Subscribe only AFTER the slice settled: the first-open transition is
    // the one that legitimately goes through 'loading'.
    expect(controller.getSnapshot().jobs.status).toBe('ready')
    controller.subscribe(() => { seen.push(controller.getSnapshot().jobs.status) })
    controller.resync()
    await settle()
    expect(jobs).toBe(2)
    // The reconnect refresh must not push the view back through 'loading'.
    expect(seen).not.toContain('loading')
    // It refreshes in place: the rows never leave the screen.
    expect(controller.getSnapshot().jobs.status).toBe('ready')
  })

  it('re-reads the project list on a reconnect resync after a failure', async () => {
    let loads = 0
    const controller = new ResearchController(stubRemote({
      listProjects: () => {
        loads += 1
        return loads === 1
          ? Promise.resolve(failed<ResearchListProjectsResult>('unavailable', 'offline'))
          : Promise.resolve(carried(NO_PROJECTS))
      },
      getProtocolVersion: () => Promise.resolve(carried({ ok: true, value: { version: RESEARCH_PROTOCOL_VERSION } })),
    }))
    controller.ensure()
    await settle()
    expect(controller.getSnapshot().projectsStatus).toBe('error')
    controller.resync()
    await settle()
    expect(controller.getSnapshot().projectsStatus).toBe('ready')
  })

  it('does not touch a cold slice on a reconnect', async () => {
    let jobs = 0
    const controller = new ResearchController(stubRemote({
      listProjects: () => Promise.resolve(carried(NO_PROJECTS)),
      listJobs: () => {
        jobs += 1
        return Promise.resolve(carried(NO_JOBS))
      },
      getProtocolVersion: () => Promise.resolve(carried({ ok: true, value: { version: RESEARCH_PROTOCOL_VERSION } })),
    }))
    controller.loadSlice('projects', 'first-open')
    await settle()
    controller.resync()
    await settle()
    expect(jobs).toBe(0)
    expect(controller.getSnapshot().jobs.status).toBe('cold')
  })

  it('re-reads the project-scoped slices when the selection changes', async () => {
    const venues: Array<string | null> = []
    const figures: Array<string | null> = []
    const controller = new ResearchController(stubRemote({
      listProjects: () => Promise.resolve(carried(NO_PROJECTS)),
      listVenueDeadlines: (request: unknown) => {
        const projectId = (request as { projectId?: string | null }).projectId ?? null
        venues.push(projectId)
        return Promise.resolve(carried({ venues: [], journals: [], watched: {}, fetchedAt: 'now' } as never))
      },
      listFigures: (request: unknown) => {
        const projectId = (request as { projectId?: string }).projectId ?? null
        figures.push(projectId)
        return Promise.resolve(carried({ figures: [] } as never))
      },
    }))
    controller.loadSlice('projects', 'first-open')
    controller.setSelectedProjectId('alpha')
    controller.loadSlice('venues', 'first-open')
    controller.loadSlice('figures', 'first-open')
    await settle()
    const venuesBefore = venues.length
    const figuresBefore = figures.length

    // The switch trigger is what the panel fires when the selection moves.
    controller.setSelectedProjectId('beta')
    for (const slice of LOAD_MATRIX['project-switch']) controller.loadSlice(slice, 'project-switch')
    await settle()

    // A settled catalog for another project is stale, so both re-read — and
    // they re-read for the NEW project, not the old one.
    expect(venues.slice(venuesBefore)).toEqual(['beta'])
    expect(figures.slice(figuresBefore)).toEqual(['beta'])
  })

  it('retries the subscription slice through the matrix, keeping its due-check', async () => {
    let loads = 0
    const controller = new ResearchController(stubRemote({
      listArxivSubscriptions: () => {
        loads += 1
        return loads === 1
          ? Promise.resolve(failed<ResearchArxivSubscriptionsResult>('unavailable', 'offline'))
          : Promise.resolve(carried(NO_SUBSCRIPTIONS))
      },
    }))
    controller.loadSlice('subscriptions', 'first-open')
    await settle()
    expect(controller.getSnapshot().arxivSubscriptions.status).toBe('error')
    controller.loadSlice('subscriptions', 'revisit')
    await settle()
    expect(loads).toBe(2)
    expect(controller.getSnapshot().arxivSubscriptions.status).toBe('ready')
  })
})
