/**
 * Behavior tests for the panel-driven project lifecycle (#160): create and
 * rename validation, the confirmed delete cascade (disk first — a failed
 * removal rejects with nothing touched; then experiments / figures / venue
 * watches / ideas, then the paper unlink under the per-paper lock), the
 * imported-only paper-directory cleanup, the restart-proof idea registration
 * (schema carries `projectId`), and the cascade-completeness backstop over
 * the domain spec. Real memory-backed domain, real temp workspace — no mocks.
 */

import { chmod, mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import type { ResearchWikiDomain } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import { createWikiNoteTool } from '../src/tools/wiki.ts'
import { withProjectMutationLock } from '../src/services/mutation-locks.ts'
import type { PaperRecord, ProjectRecord } from '../src/types.ts'

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function harness(pool?: MemoryMediaPool) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool ?? new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-project-admin-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
  })
  return { ctx, domain, workspaceDir, service, facility }
}

/** Seed one project row directly. */
async function seedProject(domain: ResearchWikiDomain, id: string, title = 'Demo', paperDir?: string): Promise<void> {
  const record: ProjectRecord = {
    id, title, stage: 'idea', artifacts: [], reviewRounds: 0, updatedAt: '2026-09-01T00:00:00.000Z',
    ...(paperDir === undefined ? {} : { paperDir }),
  }
  await domain.table('projects').put(id, record)
}

/** The tool's execute needs a ToolRunContext it never reads in these paths. */
const NO_EXEC = {} as ToolRunContext

describe('createProject', () => {
  it('creates an idea-stage project and lists it', async () => {
    const { service, domain } = await harness()
    const created = await service.createProject({ title: '  Mesh Recovery  ' })
    expect(created).toMatchObject({ ok: true, value: { project: { title: 'Mesh Recovery', stage: 'idea' } } })
    if (!created.ok) throw new Error('create rejected')
    expect(domain.table('projects').get(created.value.project.id)).toBeDefined()
    const listed = await service.listProjects()
    expect(listed).toMatchObject({ ok: true, value: { projects: [{ id: created.value.project.id }] } })
    const actions = [...domain.table('events').entries()].map(([, row]) => row.action)
    expect(actions).toContain('project.created')
  })

  it('rejects a blank or over-long title', async () => {
    const { service } = await harness()
    await expect(service.createProject({ title: '   ' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.createProject({ title: 'x'.repeat(201) }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })
})

describe('renameProject', () => {
  it('renames and bumps updatedAt', async () => {
    const { service, domain } = await harness()
    await seedProject(domain, 'p1', 'Old Name')
    const renamed = await service.renameProject({ projectId: 'p1', title: 'New Name' })
    expect(renamed).toMatchObject({ ok: true, value: { project: { id: 'p1', title: 'New Name' } } })
    expect(domain.table('projects').get('p1')?.title).toBe('New Name')
    expect(domain.table('projects').get('p1')?.updatedAt > '2026-09-01T00:00:00.000Z').toBe(true)
  })

  it('rejects an unknown id and a blank title', async () => {
    const { service, domain } = await harness()
    await seedProject(domain, 'p1')
    await expect(service.renameProject({ projectId: 'ghost', title: 'x' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
    await expect(service.renameProject({ projectId: 'p1', title: ' ' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(domain.table('projects').get('p1')?.title).toBe('Demo')
  })
})

describe('deleteProject', () => {
  it('requires confirm and refuses an unknown id', async () => {
    const { service, domain } = await harness()
    await seedProject(domain, 'p1')
    await expect(service.deleteProject({ projectId: 'p1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.deleteProject({ projectId: 'ghost', confirm: true }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
    expect(domain.table('projects').get('p1')).toBeDefined()
  })

  it('cascades the project-scoped rows and unlinks papers', async () => {
    const { service, domain, workspaceDir } = await harness()
    await seedProject(domain, 'p1')
    await seedProject(domain, 'p2', 'Other')
    await domain.table('experiments').put('e1', {
      id: 'e1', projectId: 'p1', name: 'run', status: 'success', metrics: {}, updatedAt: '2026-09-01T00:00:00.000Z',
    })
    await domain.table('experiments').put('e2', {
      id: 'e2', projectId: 'p2', name: 'keep', status: 'success', metrics: {}, updatedAt: '2026-09-01T00:00:00.000Z',
    })
    await domain.table('figures').put('p1:figures/a.png', {
      id: 'p1:figures/a.png', projectId: 'p1', relPath: 'figures/a.png', caption: '', createdAt: '2026-09-01T00:00:00.000Z',
    })
    await domain.table('venue_watches').put('p1:cvpr', {
      id: 'p1:cvpr', projectId: 'p1', series: 'cvpr', createdAt: '2026-09-01T00:00:00.000Z',
    })
    await domain.table('ideas').put('i1', {
      id: 'i1', title: 'idea', hypothesis: 'h', status: 'adopted', projectId: 'p1', createdAt: '2026-09-01T00:00:00.000Z',
    })
    const paper: PaperRecord = {
      arxivId: '2103.00020', title: 'Paper', authors: [], summary: '', url: '', notes: '',
      tags: [], projectIds: ['p1', 'p2'], addedAt: '2026-09-01T00:00:00.000Z',
      relevance: {
        p1: { score: 9, reason: 'core', at: '2026-09-01T00:00:00.000Z' },
        p2: { score: 3, reason: 'marginal', at: '2026-09-01T00:00:00.000Z' },
      },
    }
    await domain.table('papers').put(paper.arxivId, paper)
    const decksDir = join(workspaceDir, 'meetings', 'p1')
    await mkdir(decksDir, { recursive: true })
    await writeFile(join(decksDir, 'deck.pptx'), 'pptx')

    const removed = await service.deleteProject({ projectId: 'p1', confirm: true })
    expect(removed).toMatchObject({
      ok: true,
      value: {
        projectId: 'p1',
        removed: { experiments: 1, figures: 1, venueWatches: 1, ideas: 1, paperLinks: 1, meetingsRemoved: true, paperDirRemoved: false },
      },
    })
    expect(domain.table('projects').get('p1')).toBeUndefined()
    expect(domain.table('projects').get('p2')).toBeDefined()
    expect(domain.table('experiments').get('e1')).toBeUndefined()
    expect(domain.table('experiments').get('e2')).toBeDefined()
    expect(domain.table('figures').get('p1:figures/a.png')).toBeUndefined()
    expect(domain.table('venue_watches').get('p1:cvpr')).toBeUndefined()
    expect(domain.table('ideas').get('i1')).toBeUndefined()
    const kept = domain.table('papers').get('2103.00020')
    expect(kept?.projectIds).toEqual(['p2'])
    expect(kept?.relevance).toEqual({ p2: { score: 3, reason: 'marginal', at: '2026-09-01T00:00:00.000Z' } })
    // The decks directory is gone; the delete event is in the ledger.
    await expect(stat(decksDir)).rejects.toMatchObject({ code: 'ENOENT' })
    const deleted = [...domain.table('events').entries()].map(([, row]) => row.action)
    expect(deleted).toContain('project.deleted')
  })

  it('still cascades project-registered ideas after a restart (the schema keeps projectId)', async () => {
    const pool = new MemoryMediaPool()
    {
      const first = await harness(pool)
      await seedProject(first.domain, 'p1')
      await first.domain.table('ideas').put('i1', {
        id: 'i1', title: 'idea', hypothesis: 'h', status: 'adopted', projectId: 'p1', createdAt: '2026-09-01T00:00:00.000Z',
      })
    }
    // Reopen the same medium (a simulated restart): the second harness's
    // domain is the reopened one.
    const second = await harness(pool)
    const reopened = second.domain
    const service = second.service
    // The reopened row must still carry the registration the schema once stripped.
    expect(reopened.table('ideas').get('i1')?.projectId).toBe('p1')
    const removed = await service.deleteProject({ projectId: 'p1', confirm: true })
    expect(removed).toMatchObject({ ok: true, value: { removed: { ideas: 1 } } })
    expect(reopened.table('ideas').get('i1')).toBeUndefined()
  })

  it('rejects without touching anything when the decks removal fails', async () => {
    const { service, domain, workspaceDir } = await harness()
    await seedProject(domain, 'p1')
    await domain.table('experiments').put('e1', {
      id: 'e1', projectId: 'p1', name: 'run', status: 'success', metrics: {}, updatedAt: '2026-09-01T00:00:00.000Z',
    })
    // An unreadable `meetings/` parent makes rm(meetings/p1) fail with EACCES.
    const meetingsDir = join(workspaceDir, 'meetings')
    await mkdir(join(meetingsDir, 'p1'), { recursive: true })
    await chmod(meetingsDir, 0o000)
    try {
      const removed = await service.deleteProject({ projectId: 'p1', confirm: true })
      expect(removed).toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    } finally {
      await chmod(meetingsDir, 0o755)
    }
    // Nothing moved: the project, its rows, and no audit event.
    expect(domain.table('projects').get('p1')).toBeDefined()
    expect(domain.table('experiments').get('e1')).toBeDefined()
    const actions = [...domain.table('events').entries()].map(([, row]) => row.action)
    expect(actions).not.toContain('project.deleted')
  })

  it('removes a paper directory inside imported/ but never one outside it', async () => {
    const { service, domain, workspaceDir } = await harness()
    await seedProject(domain, 'p-in', 'Imported', 'imported/qa-proj')
    await seedProject(domain, 'p-out', 'Own tree', 'paper')
    const inDir = join(workspaceDir, 'imported', 'qa-proj')
    const outDir = join(workspaceDir, 'paper')
    await mkdir(inDir, { recursive: true })
    await writeFile(join(inDir, 'main.tex'), '\\documentclass{article}')
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'main.tex'), '\\documentclass{article}')

    const removedIn = await service.deleteProject({ projectId: 'p-in', confirm: true })
    expect(removedIn).toMatchObject({ ok: true, value: { removed: { paperDirRemoved: true } } })
    await expect(stat(inDir)).rejects.toMatchObject({ code: 'ENOENT' })

    const removedOut = await service.deleteProject({ projectId: 'p-out', confirm: true })
    expect(removedOut).toMatchObject({ ok: true, value: { removed: { paperDirRemoved: false } } })
    // The user's own tree outside imported/ survives.
    await expect(stat(join(outDir, 'main.tex'))).resolves.toBeDefined()
  })

  it('never follows a symlinked paper directory out of imported/', async () => {
    const { service, domain, workspaceDir } = await harness()
    const outside = await mkdtemp(join(tmpdir(), 'mimir-outside-'))
    await writeFile(join(outside, 'keep.txt'), 'precious')
    const { symlink } = await import('node:fs/promises')
    await mkdir(join(workspaceDir, 'imported'), { recursive: true })
    await symlink(outside, join(workspaceDir, 'imported', 'linked'), 'dir')
    await seedProject(domain, 'p-link', 'Linked', 'imported/linked')

    const removed = await service.deleteProject({ projectId: 'p-link', confirm: true })
    expect(removed).toMatchObject({ ok: true, value: { removed: { paperDirRemoved: false } } })
    // The realpath gate refused the follow: the outside tree is intact.
    await expect(stat(join(outside, 'keep.txt'))).resolves.toBeDefined()
  })

  it('serializes a concurrent paper update against the unlink pass', async () => {
    const { service, domain } = await harness()
    await seedProject(domain, 'p1')
    const paper: PaperRecord = {
      arxivId: '2103.00020', title: 'Paper', authors: [], summary: '', url: '', notes: '',
      tags: [], projectIds: ['p1'], addedAt: '2026-09-01T00:00:00.000Z',
    }
    await domain.table('papers').put(paper.arxivId, paper)

    const [removed] = await Promise.all([
      service.deleteProject({ projectId: 'p1', confirm: true }),
      service.updatePaper({ arxivId: '2103.00020', notes: 'fresh notes' }),
    ])
    expect(removed).toMatchObject({ ok: true, value: { removed: { paperLinks: 1 } } })
    // Neither update is lost: the link is gone AND the notes landed.
    const kept = domain.table('papers').get('2103.00020')
    expect(kept?.projectIds).toEqual([])
    expect(kept?.notes).toBe('fresh notes')
  })

  it('a wiki_note write aimed at a project being deleted lands before it or fails after it', async () => {
    const { service, domain } = await harness()
    await seedProject(domain, 'p1')
    const tool = createWikiNoteTool(domain)

    // Hold the project lock (what the cascade does for its whole run), queue
    // the delete behind the gate, then the add_experiment behind the delete.
    // `release` is assigned eagerly (the promise executor runs at construction)
    // because the lock's mutation starts a microtask later.
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const gate = withProjectMutationLock('p1', () => hold)
    const deleting = service.deleteProject({ projectId: 'p1', confirm: true })
    const adding = tool.execute(
      { action: 'add_experiment', project_id: 'p1', name: 'late run', status: 'running' },
      NO_EXEC,
    )
    release()
    await gate
    await expect(deleting).resolves.toMatchObject({ ok: true })
    // The write serialized after the cascade and failed the existence check —
    // no experiment row for a deleted project can survive.
    await expect(adding).rejects.toThrow("no project with id 'p1'")
    expect([...domain.table('experiments').entries()].filter(([, row]) => row.projectId === 'p1')).toEqual([])
  })

  it('succeeds without a decks directory on disk', async () => {
    const { service, domain } = await harness()
    await seedProject(domain, 'p1')
    const removed = await service.deleteProject({ projectId: 'p1', confirm: true })
    expect(removed).toMatchObject({ ok: true, value: { removed: { meetingsRemoved: false, paperDirRemoved: false } } })
  })
})

describe('cascade completeness', () => {
  // Every domain table must be accounted for: cascaded, link-only-unlinked,
  // or explicitly exempt. A NEW table with project semantics fails here until
  // its cascade story is decided.
  const CASCADED = new Set(['experiments', 'figures', 'venue_watches', 'ideas'])
  const UNLINKED = new Set(['papers'])
  const EXEMPT = new Set([
    'projects', // the row the verb itself deletes
    'claims', // claim rows carry no project link (audit knowledge)
    'servers', // global compute resources shared across projects
    'jobs', // runtime state of those resources; kept as the audit trail
    'events', // the ledger IS the audit trail; project.deleted rides it
  ])

  it('every domain table is cascaded, unlinked, or explicitly exempt', () => {
    for (const [name, table] of Object.entries(researchWikiDomainSpec.tables)) {
      const accounted = CASCADED.has(name) || UNLINKED.has(name) || EXEMPT.has(name)
      expect(accounted, `table '${name}' has no cascade story`).toBe(true)
      // A table whose schema carries a projectId field may never be exempt.
      const shape = (table.valueSchema as { shape?: Record<string, unknown> }).shape
      if (shape !== undefined && 'projectId' in shape) {
        expect(
          CASCADED.has(name) || UNLINKED.has(name) || name === 'projects',
          `table '${name}' carries projectId but is not in the cascade`,
        ).toBe(true)
      }
    }
  })
})
