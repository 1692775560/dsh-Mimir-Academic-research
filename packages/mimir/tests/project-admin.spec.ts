/**
 * Behavior tests for the panel-driven project lifecycle (#160): create and
 * rename validation, the confirmed delete cascade (experiments / figures /
 * venue watches / ideas removed, papers unlinked with verdicts dropped, the
 * decks directory removed from disk, ledger kept), and the failure
 * vocabulary. Real memory-backed domain, real temp workspace — no mocks.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import type { PaperRecord, ProjectRecord } from '../src/types.ts'

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
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
  return { ctx, domain, workspaceDir, service }
}

/** Seed one project row directly. */
async function seedProject(domain: Awaited<ReturnType<typeof harness>>['domain'], id: string, title = 'Demo'): Promise<void> {
  const record: ProjectRecord = {
    id, title, stage: 'idea', artifacts: [], reviewRounds: 0, updatedAt: '2026-09-01T00:00:00.000Z',
  }
  await domain.table('projects').put(id, record)
}

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
        removed: { experiments: 1, figures: 1, venueWatches: 1, ideas: 1, paperLinks: 1, meetingsRemoved: true },
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
    await expect(mkdir(join(workspaceDir, 'meetings', 'p1'), { recursive: false })).resolves.toBeUndefined()
    const deleted = [...domain.table('events').entries()].map(([, row]) => row.action)
    expect(deleted).toContain('project.deleted')
  })

  it('succeeds without a decks directory on disk', async () => {
    const { service, domain } = await harness()
    await seedProject(domain, 'p1')
    const removed = await service.deleteProject({ projectId: 'p1', confirm: true })
    expect(removed).toMatchObject({ ok: true, value: { removed: { meetingsRemoved: false } } })
  })
})
