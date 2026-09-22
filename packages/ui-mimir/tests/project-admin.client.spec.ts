/**
 * Behavior tests for the panel controller's project-management verbs:
 * create/rename/delete each settle the Remote envelope, refresh the project
 * list, and toast; failures surface as failure views without a refresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_DEBOUNCE_MS, COMPILE_DEBOUNCE_MS, ResearchController } from '../src/client/controller.ts'
import type { ResearchRemote } from '../src/client/controller.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Test-only carrier failure code for unreachable-host simulations. */
    'unavailable': {}
  }
}
import type {
  ResearchCompileResult,
  ResearchCompileStatusResult,
  ResearchCreateProjectResult,
  ResearchDeleteProjectResult,
  ResearchExperimentsResult,
  ResearchListProjectsResult,
  ResearchOutlineResult,
  ResearchPaperSourceResult,
  ResearchRenameProjectResult,
  ResearchSavePaperSourceResult,
} from 'dsh-mimir/types'

/** Wrap one business result in the carrier's success branch. */
function carried<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One remote stub; unspecified calls reject, which no test path reaches. */
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

const PROJECT = { id: 'p1', title: 'Paper One', stage: 'idea' as const, reviewRounds: 0, updatedAt: '2026-08-01T00:00:00Z', artifacts: [] }

/** A listProjects stub whose answer advances per call (the post-verb refresh). */
function listProjectsReturning(lists: ResearchListProjectsResult[]): ResearchRemote['listProjects'] {
  let calls = 0
  return () => Promise.resolve(carried(lists[Math.min(calls++, lists.length - 1)] ?? lists[0] ?? { ok: true, value: { projects: [] } }))
}

describe('ResearchController project management', () => {
  it('creates a project, refreshes the list, and toasts', async () => {
    const notify = vi.spyOn(ResearchController.prototype, 'notify')
    const remote = stubRemote({
      createProject: ({ title }) => Promise.resolve(carried<ResearchCreateProjectResult>({
        ok: true, value: { project: { ...PROJECT, title } },
      })),
      listProjects: listProjectsReturning([
        { ok: true, value: { projects: [PROJECT] } },
      ]),
    })
    const controller = new ResearchController(remote)
    const outcome = await controller.createProject('Paper One')
    expect(outcome).toMatchObject({ id: 'p1', title: 'Paper One' })
    expect(controller.getSnapshot().projects.map(project => project.id)).toEqual(['p1'])
    expect(notify).toHaveBeenCalledWith('success', 'toast.projectCreated', 'Paper One')
    notify.mockRestore()
  })

  it('returns the settled failure of a rejected create and does not refresh', async () => {
    const remote = stubRemote({
      createProject: () => Promise.resolve(carried<ResearchCreateProjectResult>({
        ok: false, error: { code: 'invalid-input', message: 'title must be 1-200 non-blank characters' },
      })),
    })
    const controller = new ResearchController(remote)
    const outcome = await controller.createProject('   ')
    expect(outcome).toMatchObject({ code: 'invalid-input' })
    expect(controller.getSnapshot().projectsStatus).toBe('cold')
  })

  it('renames a project and refreshes the list', async () => {
    const remote = stubRemote({
      renameProject: ({ title }) => Promise.resolve(carried<ResearchRenameProjectResult>({
        ok: true, value: { project: { ...PROJECT, title } },
      })),
      listProjects: listProjectsReturning([
        { ok: true, value: { projects: [{ ...PROJECT, title: 'Renamed' }] } },
      ]),
    })
    const controller = new ResearchController(remote)
    const outcome = await controller.renameProject('p1', 'Renamed')
    expect(outcome).toMatchObject({ id: 'p1', title: 'Renamed' })
    expect(controller.getSnapshot().projects[0]?.title).toBe('Renamed')
  })

  it('returns the settled failure of renaming an unknown project', async () => {
    const remote = stubRemote({
      renameProject: () => Promise.resolve(carried<ResearchRenameProjectResult>({
        ok: false, error: { code: 'project-not-found', projectId: 'ghost' },
      })),
    })
    const controller = new ResearchController(remote)
    const outcome = await controller.renameProject('ghost', 'Renamed')
    expect(outcome).toMatchObject({ code: 'project-not-found' })
  })

  it('deletes a project with the confirm gate and refreshes the list', async () => {
    const notify = vi.spyOn(ResearchController.prototype, 'notify')
    const deleteProject = vi.fn((request: { projectId: string; confirm: true }) => Promise.resolve(carried<ResearchDeleteProjectResult>({
      ok: true,
      value: {
        projectId: request.projectId,
        removed: { experiments: 1, figures: 2, venueWatches: 0, ideas: 0, paperLinks: 1, meetingsRemoved: true },
      },
    })))
    const remote = stubRemote({
      deleteProject,
      listProjects: listProjectsReturning([
        { ok: true, value: { projects: [] } },
      ]),
    })
    const controller = new ResearchController(remote)
    const failure = await controller.deleteProject('p1')
    expect(failure).toBeNull()
    expect(deleteProject).toHaveBeenCalledWith({ projectId: 'p1', confirm: true })
    expect(controller.getSnapshot().projects).toEqual([])
    expect(notify).toHaveBeenCalledWith('success', 'toast.projectDeleted')
    notify.mockRestore()
  })

  it('returns the settled failure of deleting an unknown project', async () => {
    const remote = stubRemote({
      deleteProject: () => Promise.resolve(carried<ResearchDeleteProjectResult>({
        ok: false, error: { code: 'project-not-found', projectId: 'ghost' },
      })),
    })
    const controller = new ResearchController(remote)
    const failure = await controller.deleteProject('ghost')
    expect(failure).toMatchObject({ code: 'project-not-found' })
  })

  it('keeps the ready list on screen while a verb-triggered refresh is in flight', async () => {
    const statuses: string[] = []
    const remote = stubRemote({
      listProjects: listProjectsReturning([
        { ok: true, value: { projects: [PROJECT] } },
        { ok: true, value: { projects: [PROJECT, { ...PROJECT, id: 'p2', title: 'Paper Two' }] } },
      ]),
      createProject: ({ title }) => Promise.resolve(carried<ResearchCreateProjectResult>({
        ok: true, value: { project: { ...PROJECT, id: 'p2', title } },
      })),
    })
    const controller = new ResearchController(remote)
    controller.ensure()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().projectsStatus).toBe('ready')
    controller.subscribe(() => { statuses.push(controller.getSnapshot().projectsStatus) })
    await controller.createProject('Paper Two')
    expect(controller.getSnapshot().projects.map(project => project.id)).toEqual(['p1', 'p2'])
    // The refresh over a ready list repaints without a loading detour (no
    // sidebar flash); only the first-ever load shows the loading state.
    expect(statuses).not.toContain('loading')
  })

  it('keeps the last good list when a quiet refresh fails', async () => {
    const remote = stubRemote({
      listProjects: listProjectsReturning([
        { ok: true, value: { projects: [PROJECT] } },
        { ok: false, error: { code: 'operation-failed', message: 'disk hiccup' } },
      ]),
      createProject: () => Promise.resolve(carried<ResearchCreateProjectResult>({
        ok: true, value: { project: PROJECT },
      })),
    })
    const controller = new ResearchController(remote)
    controller.ensure()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().projectsStatus).toBe('ready')
    // A business failure on the quiet refresh keeps the old list and status.
    await controller.createProject('Paper One')
    expect(controller.getSnapshot()).toMatchObject({ projectsStatus: 'ready', projectsFailure: null })
    expect(controller.getSnapshot().projects.map(project => project.id)).toEqual(['p1'])
    // A carrier failure on the quiet refresh is just as silent.
    const carrying = stubRemote({
      listProjects: listProjectsReturning([{ ok: true, value: { projects: [PROJECT] } }]),
      createProject: () => Promise.resolve(carried<ResearchCreateProjectResult>({
        ok: true, value: { project: PROJECT },
      })),
    })
    const second = new ResearchController(carrying)
    second.ensure()
    await Promise.resolve()
    await Promise.resolve()
    expect(second.getSnapshot().projectsStatus).toBe('ready')
    ;(carrying as { listProjects: ResearchRemote['listProjects'] }).listProjects =
      () => Promise.resolve({ ok: false, error: new RemoteError('unavailable', 'host down', {}) })
    await second.createProject('Paper One')
    expect(second.getSnapshot()).toMatchObject({ projectsStatus: 'ready', projectsFailure: null })
    expect(second.getSnapshot().projects.map(project => project.id)).toEqual(['p1'])
  })
})

describe('ResearchController project deselection', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const IDLE: ResearchCompileStatusResult = {
    ok: true,
    value: { state: 'idle', issues: [], engine: null, pdfUpdatedAt: null },
  }

  it('flushes the dirty draft and empties every per-project slice', async () => {
    const saved: Array<{ projectId: string; content: string; baseMtimeMs: number }> = []
    let compiles = 0
    const controller = new ResearchController(stubRemote({
      getPaperOutline: ({ projectId }: { projectId: string }) => Promise.resolve(
        carried<ResearchOutlineResult>({ ok: true, value: { projectId, nodes: [] } }),
      ),
      getCompileStatus: () => Promise.resolve(carried(IDLE)),
      getPaperSource: () => Promise.resolve(
        carried<ResearchPaperSourceResult>({ ok: true, value: { content: 'v1', mtimeMs: 1000 } }),
      ),
      listExperiments: () => Promise.resolve(
        carried<ResearchExperimentsResult>({ ok: true, value: { experiments: [] } }),
      ),
      savePaperSource: (request) => {
        saved.push(request)
        return Promise.resolve(carried<ResearchSavePaperSourceResult>({ ok: true, value: { mtimeMs: 2000 } }))
      },
      compile: () => {
        compiles += 1
        return Promise.resolve(carried<ResearchCompileResult>({
          ok: true, value: { state: 'ok', issues: [], engine: null, pdfUpdatedAt: 3 },
        }))
      },
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.getSnapshot().source).toMatchObject({ projectId: 'p1', status: 'ready', saveState: 'clean' })
    expect(controller.getSnapshot().experiments).toMatchObject({ projectId: 'p1', status: 'ready' })
    controller.edit('v1 edited')
    // Deselect before the autosave debounce fires: the draft rides out with
    // the deselect instead of dying with the cleared timer.
    controller.select(null)
    expect(saved).toEqual([{ projectId: 'p1', content: 'v1 edited', baseMtimeMs: 1000 }])
    const view = controller.getSnapshot()
    expect(view.outline).toBeNull()
    expect(view.source).toBeNull()
    expect(view.experiments).toBeNull()
    expect(view.figures).toBeNull()
    expect(view.meetings).toBeNull()
    expect(view.artifact).toBeNull()
    expect(view.snapshots).toBeNull()
    expect(view.snapshotDetail).toBeNull()
    expect(view.compile).toMatchObject({ projectId: null, state: 'idle', issues: [] })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + COMPILE_DEBOUNCE_MS)
    // The deselect cleared the pending debounces: no second save, and the
    // flushed save's auto-compile is stale-marked away by the generation bump.
    expect(saved).toHaveLength(1)
    expect(compiles).toBe(0)
  })
})
