import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { createPaperFetchTool, rememberFetchedPaper, type ArxivEntry } from '../src/tools/arxiv.ts'

const ENTRY: ArxivEntry = {
  id: '2401.01234v2',
  title: 'Useful Paper',
  authors: ['Ada Researcher'],
  summary: 'A useful result.',
  published: '2024-01-03T00:00:00Z',
  url: 'https://arxiv.org/abs/2401.01234v2',
}

async function domainHarness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  return facility.open(researchWikiDomainSpec)
}

describe('automatic paper capture', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('archives through the paper_fetch tool, not only the storage helper', async () => {
    const domain = await domainHarness()
    await domain.table('projects').put('p1', { id: 'p1', title: 'P1', stage: 'idea', artifacts: [], reviewRounds: 0, updatedAt: new Date().toISOString() })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`
      <feed><entry>
        <id>https://arxiv.org/abs/${ENTRY.id}</id><title>${ENTRY.title}</title>
        <author><name>${ENTRY.authors[0]}</name></author><summary>${ENTRY.summary}</summary>
        <published>${ENTRY.published}</published>
      </entry></feed>
    `, { status: 200 })))

    const tool = createPaperFetchTool(domain)
    await tool.execute({ arxiv_id: ENTRY.id, project_id: 'p1', notes: 'Use in related work', tags: ['useful'] }, { signal: AbortSignal.timeout(1_000) } as ToolRunContext)

    expect(domain.table('papers').get(ENTRY.id)).toMatchObject({
      notes: 'Use in related work',
      tags: ['useful'],
      projectIds: ['p1'],
    })
  })

  it('links a fetched paper to the latest project and records context', async () => {
    const domain = await domainHarness()
    await domain.table('projects').put('older', { id: 'older', title: 'Old', stage: 'idea', artifacts: [], reviewRounds: 0, updatedAt: '2024-01-01T00:00:00Z' })
    await domain.table('projects').put('active', { id: 'active', title: 'Active', stage: 'idea', artifacts: [], reviewRounds: 0, updatedAt: '2024-01-02T00:00:00Z' })

    const saved = await rememberFetchedPaper(domain, ENTRY, { notes: 'Closest baseline', tags: ['retrieval'] })

    expect(saved).toMatchObject({ notes: 'Closest baseline', tags: ['retrieval'], projectIds: ['active'] })
    expect(domain.table('papers').get(ENTRY.id)).toEqual(saved)
  })

  it('refreshes metadata without losing prior curation', async () => {
    const domain = await domainHarness()
    await domain.table('projects').put('p1', { id: 'p1', title: 'P1', stage: 'idea', artifacts: [], reviewRounds: 0, updatedAt: new Date().toISOString() })
    const first = await rememberFetchedPaper(domain, ENTRY, { projectId: 'p1', notes: 'First note', tags: ['baseline'] })
    await domain.table('papers').update(ENTRY.id, current => ({ ...current, pdfPath: 'papers/saved.pdf' }))

    const refreshed = await rememberFetchedPaper(domain, { ...ENTRY, title: 'Updated title' }, { projectId: 'p1', notes: 'Second note', tags: ['strong'] })

    expect(refreshed.title).toBe('Updated title')
    expect(refreshed.notes).toBe('First note\n\nSecond note')
    expect(refreshed.tags).toEqual(['baseline', 'strong'])
    expect(refreshed.projectIds).toEqual(['p1'])
    expect(refreshed.pdfPath).toBe('papers/saved.pdf')
    expect(refreshed.addedAt).toBe(first.addedAt)
  })

  it('rejects an explicit unknown project instead of silently mislinking', async () => {
    const domain = await domainHarness()
    await expect(rememberFetchedPaper(domain, ENTRY, { projectId: 'missing' })).rejects.toThrow("no project with id 'missing'")
  })

  it('rejects a path-unsafe arXiv id at the write boundary', async () => {
    const domain = await domainHarness()
    // The durable schema is permissive on purpose (a legacy bad row must not
    // abort the domain open), so the write path validates explicitly.
    await expect(rememberFetchedPaper(domain, { ...ENTRY, id: '../escape' })).rejects.toThrow("unsafe arXiv id '../escape'")
    expect(domain.table('papers').size).toBe(0)
  })
})
