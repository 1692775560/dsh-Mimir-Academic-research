/**
 * Regression tests for the shared re-import merge (R29 / #230): the same
 * paper re-ingested through any of the three entry points — the panel's
 * `importPaper`, the Zotero item import, and the agent's `wiki_note
 * add_paper` — must keep everything the workbench curated (notes, tags,
 * project links, relevance scores, the fetched-PDF pointer) plus the
 * original first-import timestamp, while the source metadata refreshes.
 * Before the shared mergePaperRecord each entry point merged ad hoc, and
 * every one of them dropped something (pdfPath everywhere, relevance on
 * the Zotero path, addedAt on the agent path).
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import type { ResearchWikiDomain } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import { createWikiNoteTool } from '../src/tools/wiki.ts'
import type { ArxivEntry, PaperRecord, ProjectRecord } from '../src/types.ts'

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Project',
  stage: 'writing',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

const ENTRY: ArxivEntry = {
  id: '2103.00020',
  title: 'EgoSync, refreshed title',
  authors: ['Doe, Jane', 'Roe, John'],
  summary: 'Refreshed abstract.',
  published: '2021-03-04',
  url: '',
}

/** One paper the workbench has heavily curated since the first import. */
function curatedPaper(arxivId: string): PaperRecord {
  return {
    arxivId,
    title: 'Original title',
    authors: ['Doe, Jane'],
    summary: 'Original abstract.',
    url: `https://arxiv.org/abs/${arxivId}`,
    notes: 'keep me',
    tags: ['mesh'],
    projectIds: ['p1'],
    relevance: { p1: { score: 9, reason: 'core reference', at: '2026-02-01T00:00:00.000Z' } },
    pdfPath: `papers/${arxivId}.pdf`,
    addedAt: '2026-01-01T00:00:00.000Z',
    published: '2021-03-01',
    doi: '10.1000/original',
  }
}

/** The curated fields every entry point must preserve across a re-import. */
function expectCuratedFieldsKept(record: PaperRecord | undefined): void {
  expect(record).toBeDefined()
  expect(record?.notes).toBe('keep me')
  expect(record?.tags).toEqual(['mesh'])
  expect(record?.relevance).toEqual({ p1: { score: 9, reason: 'core reference', at: '2026-02-01T00:00:00.000Z' } })
  expect(record?.pdfPath).toBeDefined()
  expect(record?.addedAt).toBe('2026-01-01T00:00:00.000Z')
}

/** Boot a memory-backed domain plus a fresh temp workspace and the service. */
async function harness(zotero?: { apiKey: string; userId: string }) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  await domain.table('projects').put(PROJECT.id, PROJECT)
  await domain.table('projects').put('p2', { ...PROJECT, id: 'p2', title: 'Second' })
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-paper-merge-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
    ...(zotero === undefined ? {} : { zotero }),
  })
  return { domain, service }
}

describe('shared re-import merge (R29 / #230)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('panel importPaper re-import keeps the curated fields and unions the project link', async () => {
    const { domain, service } = await harness()
    await domain.table('papers').put(ENTRY.id, curatedPaper(ENTRY.id))

    const outcome = await service.importPaper({ entry: ENTRY, projectId: 'p2' })

    expect(outcome).toEqual({ ok: true, value: { imported: false } })
    const record = domain.table('papers').get(ENTRY.id)
    expectCuratedFieldsKept(record)
    expect(record?.projectIds).toEqual(['p1', 'p2'])
    // Source metadata refreshed.
    expect(record?.title).toBe('EgoSync, refreshed title')
    expect(record?.published).toBe('2021-03-04')
    // The source carried no DOI; the stored one survives.
    expect(record?.doi).toBe('10.1000/original')
  })

  it('zotero (arXiv path) re-import keeps the curated fields', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      key: 'ABCD2345',
      version: 1,
      data: {
        key: 'ABCD2345',
        itemType: 'journalArticle',
        title: 'EgoSync, refreshed title',
        creators: [{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe' }],
        date: '2021',
        DOI: '',
        url: '',
        extra: 'arXiv:2103.00020',
      },
    }), { status: 200 }))
    const { domain, service } = await harness({ apiKey: 'secret-key', userId: '12345678' })
    await domain.table('papers').put(ENTRY.id, curatedPaper(ENTRY.id))

    const outcome = await service.importZoteroItem({ key: 'ABCD2345' })

    expect(outcome).toEqual({ ok: true, value: { imported: false, paperId: ENTRY.id } })
    expectCuratedFieldsKept(domain.table('papers').get(ENTRY.id))
  })

  it('zotero (zotero-<key> path) re-import keeps relevance and the PDF pointer too', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      key: 'WXYZ9876',
      version: 1,
      data: {
        key: 'WXYZ9876',
        itemType: 'book',
        title: 'Deep Learning, new edition',
        creators: [{ creatorType: 'author', firstName: 'Ian', lastName: 'Goodfellow' }],
        date: '2016',
        DOI: '10.1000/xyz',
        url: 'https://example.com/deep-learning',
        extra: '',
      },
    }), { status: 200 }))
    const { domain, service } = await harness({ apiKey: 'secret-key', userId: '12345678' })
    const paperId = 'zotero-WXYZ9876'
    await domain.table('papers').put(paperId, curatedPaper(paperId))

    const outcome = await service.importZoteroItem({ key: 'WXYZ9876' })

    expect(outcome).toEqual({ ok: true, value: { imported: false, paperId } })
    const record = domain.table('papers').get(paperId)
    expectCuratedFieldsKept(record)
    expect(record?.title).toBe('Deep Learning, new edition')
    expect(record?.doi).toBe('10.1000/xyz')
  })

  it('agent wiki_note add_paper re-add keeps the curated fields and the first-import timestamp', async () => {
    const { domain } = await harness()
    await domain.table('papers').put(ENTRY.id, curatedPaper(ENTRY.id))
    const tool = createWikiNoteTool(domain)

    const outcome = await tool.execute({
      action: 'add_paper',
      arxiv_id: ENTRY.id,
      title: 'EgoSync, refreshed title',
      summary: 'Refreshed abstract.',
    }, {} as ToolRunContext) as Record<string, unknown>

    expect(outcome['ok']).toBe(true)
    const record = domain.table('papers').get(ENTRY.id)
    expectCuratedFieldsKept(record)
    expect(record?.projectIds).toEqual(['p1'])
    expect(record?.title).toBe('EgoSync, refreshed title')
  })

  it('agent wiki_note add_paper with an explicit note replaces the stored note', async () => {
    const { domain } = await harness()
    await domain.table('papers').put(ENTRY.id, curatedPaper(ENTRY.id))
    const tool = createWikiNoteTool(domain)

    await tool.execute({
      action: 'add_paper',
      arxiv_id: ENTRY.id,
      title: 'EgoSync, refreshed title',
      summary: 'Refreshed abstract.',
      notes: 'agent re-read: still relevant',
    }, {} as ToolRunContext)

    expect(domain.table('papers').get(ENTRY.id)?.notes).toBe('agent re-read: still relevant')
  })

  it('a first import through any entry writes the fresh record untouched', async () => {
    const { domain, service } = await harness()

    const outcome = await service.importPaper({ entry: ENTRY, projectId: 'p1' })

    expect(outcome).toEqual({ ok: true, value: { imported: true } })
    const record = domain.table('papers').get(ENTRY.id)
    expect(record?.title).toBe('EgoSync, refreshed title')
    expect(record?.notes).toBe('')
    expect(record?.tags).toEqual([])
    expect(record?.projectIds).toEqual(['p1'])
    expect(record?.pdfPath).toBeUndefined()
    expect(record?.addedAt).toBeDefined()
  })
})
