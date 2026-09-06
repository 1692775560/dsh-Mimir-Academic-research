/**
 * Behavior tests for the research-wiki domain spec: schema validation at the
 * durable boundary and ordinary table operations over a real storage-domain
 * facility backed by the in-memory backend shared across storage suites.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { quarantineUnsafePaperIds, researchWikiDomainSpec } from '../src/store.ts'
import type { ExperimentRecord, IdeaRecord, PaperRecord, ServerRecord } from '../src/types.ts'

/** Boot a context with the storage hub, one memory backend, and a domain facility over it. */
async function harness(pool?: MemoryMediaPool) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  return { ctx, facility }
}

const paper: PaperRecord = {
  arxivId: '2103.00020v2',
  title: 'A Paper',
  authors: ['Doe, Jane'],
  summary: 'Summary text.',
  url: 'https://arxiv.org/abs/2103.00020v2',
  notes: '',
  tags: [],
  projectIds: [],
  addedAt: '2026-08-20T00:00:00.000Z',
}

const idea: IdeaRecord = {
  id: 'idea-1',
  title: 'An Idea',
  hypothesis: 'It works.',
  status: 'active',
  createdAt: '2026-08-20T00:00:00.000Z',
}

describe('researchWikiDomainSpec', () => {
  it('round-trips records through open, put, get, and entries', async () => {
    const { facility } = await harness()
    const domain = await facility.open(researchWikiDomainSpec)
    await domain.table('papers').put(paper.arxivId, paper)
    await domain.table('ideas').put(idea.id, idea)
    expect(domain.table('papers').get(paper.arxivId)).toEqual(paper)
    expect([...domain.table('ideas').entries()]).toEqual([[idea.id, idea]])
    expect(domain.table('claims').size).toBe(0)
    expect(domain.table('projects').size).toBe(0)
  })

  it('round-trips a paper carrying the optional pdfPath and reads older records without it', async () => {
    const { facility } = await harness()
    const domain = await facility.open(researchWikiDomainSpec)
    const linked: PaperRecord = { ...paper, pdfPath: 'papers/2103.00020v2.pdf' }
    await domain.table('papers').put(linked.arxivId, linked)
    expect(domain.table('papers').get(linked.arxivId)).toEqual(linked)
    // The field is optional: the pdfPath-less fixture validates unchanged.
    await domain.table('papers').put('2406.01079v1', { ...paper, arxivId: '2406.01079v1' })
    expect(domain.table('papers').get('2406.01079v1')?.pdfPath).toBeUndefined()
  })

  it('reopens stored records from the shared medium after a simulated restart', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness(pool)
      await (await facility.open(researchWikiDomainSpec)).table('papers').put(paper.arxivId, paper)
    }
    const { facility } = await harness(pool)
    const reopened = await facility.open(researchWikiDomainSpec)
    expect(reopened.table('papers').get(paper.arxivId)).toEqual(paper)
  })

  it('opens a v2 snapshot predating the servers table with servers empty', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness(pool)
      await (await facility.open(researchWikiDomainSpec)).table('papers').put(paper.arxivId, paper)
    }
    // The servers table was added without a version bump; a store written
    // before it existed simply has no servers snapshot to load.
    pool.media.get('research_wiki')!.tables.delete('servers')
    const { facility } = await harness(pool)
    const reopened = await facility.open(researchWikiDomainSpec)
    expect(reopened.table('papers').get(paper.arxivId)).toEqual(paper)
    expect(reopened.table('servers').size).toBe(0)
  })

  it('opens a v2 snapshot predating figure metadata with figures empty', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness(pool)
      await (await facility.open(researchWikiDomainSpec)).table('papers').put(paper.arxivId, paper)
    }
    pool.media.get('research_wiki')!.tables.delete('figures')
    const { facility } = await harness(pool)
    const reopened = await facility.open(researchWikiDomainSpec)
    expect(reopened.table('figures').size).toBe(0)
  })

  it('loads a paper record predating tags/projectIds with both defaulted empty', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness(pool)
      await (await facility.open(researchWikiDomainSpec)).table('papers').put(paper.arxivId, paper)
    }
    // Simulate a v2 store written before the organization fields existed:
    // strip them from the raw stored record.
    const legacy: Record<string, unknown> = { ...paper }
    delete legacy['tags']
    delete legacy['projectIds']
    pool.media.get('research_wiki')!.tables.get('papers')!.set(paper.arxivId, legacy)
    const { facility } = await harness(pool)
    const reopened = await facility.open(researchWikiDomainSpec)
    expect(reopened.table('papers').get(paper.arxivId)).toEqual(paper)
  })

  it('loads a server record predating tags with tags defaulted empty', async () => {
    const server: ServerRecord = {
      id: 'srv-1',
      name: 'gpu01',
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      note: '',
      tags: [],
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    }
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness(pool)
      await (await facility.open(researchWikiDomainSpec)).table('servers').put(server.id, server)
    }
    // Simulate a v2 store written before the tags field existed.
    const legacy: Record<string, unknown> = { ...server }
    delete legacy['tags']
    pool.media.get('research_wiki')!.tables.get('servers')!.set(server.id, legacy)
    const { facility } = await harness(pool)
    const reopened = await facility.open(researchWikiDomainSpec)
    expect(reopened.table('servers').get(server.id)).toEqual(server)
  })

  it('loads an experiment record predating serverId with the link absent', async () => {
    const experiment: ExperimentRecord = {
      id: 'exp-1',
      projectId: 'p1',
      name: 'baseline',
      status: 'success',
      metrics: { acc: 0.9 },
      updatedAt: '2026-08-20T00:00:00.000Z',
    }
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness(pool)
      await (await facility.open(researchWikiDomainSpec)).table('experiments').put(experiment.id, experiment)
    }
    const { facility } = await harness(pool)
    const reopened = await facility.open(researchWikiDomainSpec)
    const stored = reopened.table('experiments').get(experiment.id)
    expect(stored).toEqual(experiment)
    expect(stored?.serverId).toBeUndefined()
  })

  it('rejects a stored record that fails its zod schema, naming table and key', async () => {
    const pool = new MemoryMediaPool()
    {
      const { facility } = await harness(pool)
      await (await facility.open(researchWikiDomainSpec)).table('ideas').put(idea.id, idea)
    }
    pool.media.get('research_wiki')!.tables.get('ideas')!.set(idea.id, { ...idea, status: 'bogus' })
    const { facility } = await harness(pool)
    await expect(facility.open(researchWikiDomainSpec)).rejects.toMatchObject({
      name: 'DomainError',
      code: 'invalid-record',
      detail: { table: 'ideas', key: 'idea-1' },
    })
  })

  it('serializes reviewRounds increments without losing updates', async () => {
    const { facility } = await harness()
    const domain = await facility.open(researchWikiDomainSpec)
    await domain.table('projects').put('p1', {
      id: 'p1',
      title: 'Project',
      stage: 'writing',
      artifacts: ['paper/main.tex'],
      reviewRounds: 0,
      updatedAt: '2026-08-20T00:00:00.000Z',
    })
    await Promise.all(Array.from({ length: 3 }, () =>
      domain.table('projects').update('p1', current => ({ ...current, reviewRounds: current.reviewRounds + 1 }))))
    expect(domain.table('projects').get('p1')?.reviewRounds).toBe(3)
  })

  it('keeps failed ideas listed after their status flips', async () => {
    const { facility } = await harness()
    const domain = await facility.open(researchWikiDomainSpec)
    await domain.table('ideas').put(idea.id, idea)
    await domain.table('ideas').update(idea.id, current => ({
      ...current,
      status: 'failed' as const,
      failureReason: 'Hypothesis contradicted by experiment 2.',
    }))
    const stored = domain.table('ideas').get(idea.id)
    expect(stored?.status).toBe('failed')
    expect(stored?.failureReason).toBe('Hypothesis contradicted by experiment 2.')
    expect([...domain.table('ideas').keys()]).toEqual([idea.id])
  })
})

describe('quarantineUnsafePaperIds', () => {
  it('opens a store holding a path-unsafe paper id, then drops it with a warn', async () => {
    const pool = new MemoryMediaPool()
    {
      // Write the dirty record with the schema now permissive: this simulates
      // a store written before the whitelist existed (or hand-edited).
      const { facility } = await harness(pool)
      const domain = await facility.open(researchWikiDomainSpec)
      await domain.table('papers').put('../evil', { ...paper, arxivId: '../evil' })
      await domain.table('papers').put(paper.arxivId, paper)
    }
    // The load itself must NOT fail — the whole point of moving the check
    // off the schema.
    const { facility } = await harness(pool)
    const reopened = await facility.open(researchWikiDomainSpec)
    expect(reopened.table('papers').size).toBe(2)

    const warnings: string[] = []
    const removed = await quarantineUnsafePaperIds(reopened, message => warnings.push(message))

    expect(removed).toEqual(['../evil'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('../evil')
    expect(reopened.table('papers').get('../evil')).toBeUndefined()
    expect(reopened.table('papers').get(paper.arxivId)).toEqual(paper)
  })

  it('leaves a clean store untouched and silent', async () => {
    const { facility } = await harness()
    const domain = await facility.open(researchWikiDomainSpec)
    await domain.table('papers').put(paper.arxivId, paper)
    const warnings: string[] = []
    const removed = await quarantineUnsafePaperIds(domain, message => warnings.push(message))
    expect(removed).toEqual([])
    expect(warnings).toEqual([])
    expect(domain.table('papers').size).toBe(1)
  })
})
