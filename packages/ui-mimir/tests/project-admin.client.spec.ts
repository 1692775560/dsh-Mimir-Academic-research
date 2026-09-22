/**
 * Behavior tests for the panel controller's project-management verbs:
 * create/rename/delete each settle the Remote envelope, refresh the project
 * list, and toast; failures surface as failure views without a refresh.
 */

import { describe, expect, it, vi } from 'vitest'
import { ResearchController } from '../src/client/controller.ts'
import type { ResearchRemote } from '../src/client/controller.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ResearchCreateProjectResult,
  ResearchDeleteProjectResult,
  ResearchListProjectsResult,
  ResearchRenameProjectResult,
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
})
