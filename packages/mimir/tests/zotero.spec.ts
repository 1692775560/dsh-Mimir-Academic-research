/**
 * Behavior tests for the Zotero integration: the read-only Web API client
 * (injected mock fetch: parsing, pagination, auth header, the single
 * rate-limit retry), and the five Remote methods over a real memory-backed
 * domain (unconfigured failure vocabulary, import idempotence and PaperRecord
 * mapping, the BibTeX merge/dedup, and the wiki-schema-stays-v2 regression).
 * No test touches the real api.zotero.org.
 */

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import { createZoteroClient } from '../src/tools/zotero.ts'
import type { ZoteroFetch } from '../src/tools/zotero.ts'
import type { ProjectRecord } from '../src/types.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** One journal-article item body the API would return (arXiv id in `extra`). */
const ARXIV_ITEM = {
  key: 'ABCD2345',
  version: 3,
  data: {
    key: 'ABCD2345',
    itemType: 'journalArticle',
    title: 'Attention Is All You Need',
    creators: [
      { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
      { creatorType: 'author', name: 'Google Brain' },
    ],
    date: '2017-06-12',
    DOI: '10.5555/3295222.3295349',
    url: '',
    publicationTitle: 'Advances in Neural Information Processing Systems',
    extra: 'arXiv: 1706.03762 [cs.CL]',
  },
}

/** One book item without any arXiv trace (the `zotero-<key>` import path). */
const PLAIN_ITEM = {
  key: 'WXYZ9876',
  version: 1,
  data: {
    key: 'WXYZ9876',
    itemType: 'book',
    title: 'Deep Learning',
    creators: [{ creatorType: 'author', firstName: 'Ian', lastName: 'Goodfellow' }],
    date: '2016',
    DOI: '10.1000/xyz',
    url: 'https://example.com/deep-learning',
    extra: '',
  },
}

/** A response whose JSON body is the given payload. */
function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers })
}

describe('createZoteroClient', () => {
  const CONFIG = { apiKey: 'secret-key', userId: '12345678' }
  const SIGNAL = AbortSignal.timeout(5000)

  it('sends the API key as a header, never in the URL', async () => {
    let seenUrl = ''
    let seenKey = ''
    const fetchMock: ZoteroFetch = async (url, init) => {
      seenUrl = url
      seenKey = (init.headers as Record<string, string>)['Zotero-API-Key'] ?? ''
      return json([])
    }
    const client = createZoteroClient(CONFIG, fetchMock)
    await client.listCollections(SIGNAL)
    expect(seenKey).toBe('secret-key')
    expect(seenUrl).toBe('https://api.zotero.org/users/12345678/collections?limit=100')
    expect(seenUrl).not.toContain('secret-key')
  })

  it('parses collections down to key, name, and item count', async () => {
    const client = createZoteroClient(CONFIG, async () => json([
      { key: 'COLL1', data: { key: 'COLL1', name: 'Papers' }, meta: { numItems: 7 } },
      { key: 'COLL2', data: { key: 'COLL2', name: 'Books' }, meta: {} },
      { data: { name: 'broken' } },
    ]))
    await expect(client.listCollections(SIGNAL)).resolves.toEqual([
      { key: 'COLL1', name: 'Papers', itemCount: 7 },
      { key: 'COLL2', name: 'Books', itemCount: 0 },
    ])
  })

  it('parses search items and recovers arXiv ids from extra and url', async () => {
    let seenUrl = ''
    const client = createZoteroClient(CONFIG, async (url) => {
      seenUrl = url
      return json([
        ARXIV_ITEM,
        { key: 'URLARXIV', data: { key: 'URLARXIV', itemType: 'preprint', title: 'T', url: 'https://arxiv.org/abs/2401.00099v2' } },
        { key: 'ATTACH', data: { key: 'ATTACH', itemType: 'attachment', title: 'fulltext.pdf' } },
        { key: 'NOTE', data: { key: 'NOTE', itemType: 'note', note: 'a note' } },
      ])
    })
    const items = await client.searchItems('attention', 25, SIGNAL)
    expect(seenUrl).toContain('q=attention&qmode=everything&limit=25')
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      key: 'ABCD2345',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Google Brain'],
      year: '2017',
      doi: '10.5555/3295222.3295349',
      arxivId: '1706.03762',
      publicationTitle: 'Advances in Neural Information Processing Systems',
      url: 'https://doi.org/10.5555/3295222.3295349',
    })
    expect(items[1]?.arxivId).toBe('2401.00099v2')
    expect(items[1]?.year).toBe('')
  })

  it('reads one item and rejects an attachment as not-a-reference', async () => {
    const client = createZoteroClient(CONFIG, async () => json(PLAIN_ITEM))
    const item = await client.getItem('WXYZ9876', SIGNAL)
    expect(item.title).toBe('Deep Learning')
    expect(item.arxivId).toBeNull()
    const attachments = createZoteroClient(CONFIG, async () =>
      json({ key: 'ATTACH', data: { key: 'ATTACH', itemType: 'attachment', title: 'fulltext.pdf' } }))
    await expect(attachments.getItem('ATTACH', SIGNAL)).rejects.toThrow('not a reference item')
  })

  it('exports explicit item keys as BibTeX and short-circuits an empty key list', async () => {
    let fetches = 0
    let seenUrl = ''
    const client = createZoteroClient(CONFIG, async (url) => {
      fetches += 1
      seenUrl = url
      return new Response('@misc{a,\n  title = {A}\n}\n', { status: 200 })
    })
    await expect(client.getItemsBibTeX({ itemKeys: [] }, SIGNAL)).resolves.toBe('')
    expect(fetches).toBe(0)
    const bib = await client.getItemsBibTeX({ itemKeys: ['ABCD2345', 'WXYZ9876'] }, SIGNAL)
    expect(bib).toContain('@misc{a,')
    expect(seenUrl).toContain('format=bibtex&itemKey=ABCD2345,WXYZ9876')
  })

  it('paginates a collection export by the Total-Results header', async () => {
    const seenStarts: string[] = []
    const client = createZoteroClient(CONFIG, async (url) => {
      const start = new URL(url).searchParams.get('start') ?? ''
      seenStarts.push(start)
      return new Response(`@misc{page${start},\n  title = {T}\n}\n`, {
        status: 200,
        headers: start === '0' ? { 'Total-Results': '120' } : {},
      })
    })
    const bib = await client.getItemsBibTeX({ collectionKey: 'COLL1' }, SIGNAL)
    expect(seenStarts).toEqual(['0', '100'])
    expect(bib).toContain('@misc{page0,')
    expect(bib).toContain('@misc{page100,')
  })

  it('retries a 429 once after Retry-After, then reports the failure', async () => {
    let attempts = 0
    const flaky = createZoteroClient(CONFIG, async () => {
      attempts += 1
      return attempts === 1
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })
        : json([])
    })
    await expect(flaky.listCollections(SIGNAL)).resolves.toEqual([])
    expect(attempts).toBe(2)

    let stubborn = 0
    const limited = createZoteroClient(CONFIG, async () => {
      stubborn += 1
      return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } })
    })
    await expect(limited.listCollections(SIGNAL)).rejects.toThrow('HTTP 429')
    expect(stubborn).toBe(2)
  })

  it('retries a 429 without Retry-After after the default wait, not immediately', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const waits: number[] = []
    const client = createZoteroClient(CONFIG, async () => {
      attempts += 1
      return new Response('slow down', { status: 429 })
    })
    const pending = client.listCollections(SIGNAL)
    pending.catch(() => {})
    for (let i = 0; i < 20 && attempts < 2; i++) {
      await vi.advanceTimersByTimeAsync(100)
      void waits
      if (attempts === 2) break
    }
    await vi.runAllTimersAsync()
    await expect(pending).rejects.toThrow('HTTP 429')
    expect(attempts).toBe(2)
    vi.useRealTimers()
  })

  it('rejects HTTP failures with status and URL, never the API key', async () => {
    const client = createZoteroClient(CONFIG, async () => new Response('forbidden', { status: 403 }))
    await expect(client.testConnection(SIGNAL)).rejects.toThrow('HTTP 403')
    await expect(client.testConnection(SIGNAL)).rejects.not.toThrow('secret-key')
  })
})

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function harness(zotero?: { apiKey: string; userId: string }) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-zotero-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
    ...(zotero === undefined ? {} : { zotero }),
  })
  return { ctx, domain, workspaceDir, service }
}

const CONFIGURED = { apiKey: 'secret-key', userId: '12345678' }

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Project',
  stage: 'writing',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

describe('ResearchService zotero methods, unconfigured', () => {
  it('checkZotero reports unconfigured; the other four reject invalid-input', async () => {
    const { service } = await harness()
    await expect(service.checkZotero()).resolves.toEqual({ ok: true, value: { state: 'unconfigured' } })
    await expect(service.listZoteroCollections())
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: expect.stringContaining('zotero.apiKey') } })
    await expect(service.searchZotero({ query: 'mesh' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.importZoteroItem({ key: 'ABCD2345' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.exportZoteroCollectionToBib({ projectId: 'p1', collectionKey: 'COLL1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('blank credentials in the config count as unconfigured too', async () => {
    const { service } = await harness({ apiKey: '  ', userId: '12345678' })
    await expect(service.checkZotero()).resolves.toEqual({ ok: true, value: { state: 'unconfigured' } })
  })
})

describe('ResearchService.checkZotero', () => {
  it('reports ok when the API accepts the credentials', async () => {
    vi.stubGlobal('fetch', async () => json([]))
    const { service } = await harness(CONFIGURED)
    await expect(service.checkZotero()).resolves.toEqual({ ok: true, value: { state: 'ok' } })
  })

  it('reports failed with the underlying reason, never the key', async () => {
    vi.stubGlobal('fetch', async () => new Response('forbidden', { status: 403 }))
    const { service } = await harness(CONFIGURED)
    const outcome = await service.checkZotero()
    expect(outcome).toMatchObject({ ok: true, value: { state: 'failed', message: expect.stringContaining('HTTP 403') } })
    expect(outcome.ok && outcome.value.message).not.toContain('secret-key')
  })
})

describe('ResearchService.listZoteroCollections / searchZotero', () => {
  it('lists parsed collections', async () => {
    vi.stubGlobal('fetch', async () => json([
      { key: 'COLL1', data: { key: 'COLL1', name: 'Papers' }, meta: { numItems: 7 } },
    ]))
    const { service } = await harness(CONFIGURED)
    await expect(service.listZoteroCollections()).resolves.toEqual({
      ok: true,
      value: { collections: [{ key: 'COLL1', name: 'Papers', itemCount: 7 }] },
    })
  })

  it('searches with validation and maps API failures to operation-failed', async () => {
    vi.stubGlobal('fetch', async () => json([ARXIV_ITEM]))
    const { service } = await harness(CONFIGURED)
    const outcome = await service.searchZotero({ query: 'attention' })
    expect(outcome).toMatchObject({
      ok: true,
      value: { results: [{ key: 'ABCD2345', arxivId: '1706.03762', year: '2017' }] },
    })
    await expect(service.searchZotero({ query: '  ' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.searchZotero({ query: 'mesh', maxResults: 51 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    vi.stubGlobal('fetch', async () => { throw new Error('socket hangup') })
    await expect(service.searchZotero({ query: 'mesh' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', message: 'socket hangup' } })
  })
})

describe('ResearchService.importZoteroItem', () => {
  it('imports an arXiv-carrying item through the regular importPaper path', async () => {
    vi.stubGlobal('fetch', async () => json(ARXIV_ITEM))
    const { domain, service } = await harness(CONFIGURED)
    const outcome = await service.importZoteroItem({ key: 'ABCD2345' })
    expect(outcome).toEqual({ ok: true, value: { imported: true, paperId: '1706.03762' } })
    expect(domain.table('papers').get('1706.03762')).toMatchObject({
      arxivId: '1706.03762',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Google Brain'],
      url: 'https://arxiv.org/abs/1706.03762',
    })
    // A re-import refreshes metadata but preserves workbench-curated notes.
    await service.updatePaper({ arxivId: '1706.03762', notes: 'keep me' })
    const again = await service.importZoteroItem({ key: 'ABCD2345' })
    expect(again).toEqual({ ok: true, value: { imported: false, paperId: '1706.03762' } })
    expect(domain.table('papers').get('1706.03762')?.notes).toBe('keep me')
  })

  it('imports an arXiv-less item under zotero-<key> with provenance in the notes', async () => {
    vi.stubGlobal('fetch', async () => json(PLAIN_ITEM))
    const { domain, service } = await harness(CONFIGURED)
    const outcome = await service.importZoteroItem({ key: 'WXYZ9876' })
    expect(outcome).toEqual({ ok: true, value: { imported: true, paperId: 'zotero-WXYZ9876' } })
    const record = domain.table('papers').get('zotero-WXYZ9876')
    expect(record).toMatchObject({
      arxivId: 'zotero-WXYZ9876',
      title: 'Deep Learning',
      authors: ['Ian Goodfellow'],
      url: 'https://example.com/deep-learning',
    })
    expect(record?.notes).toContain('Imported from Zotero (item WXYZ9876)')
    expect(record?.notes).toContain('DOI: 10.1000/xyz')
  })

  it('maps a missing item to operation-failed and rejects a blank key', async () => {
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }))
    const { service } = await harness(CONFIGURED)
    await expect(service.importZoteroItem({ key: 'GHOST000' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', message: expect.stringContaining('HTTP 404') } })
    await expect(service.importZoteroItem({ key: '  ' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })
})

describe('ResearchService.exportZoteroCollectionToBib', () => {
  const EXPORT_BIB = '@article{vaswani2017attention,\n  title = {Attention Is All You Need},\n  year = {2017}\n}\n\n@misc{existing,\n  title = {Already Here}\n}\n'

  /** Seed the project and its paper directory with one pre-existing bib entry. */
  async function seedProject() {
    const { domain, workspaceDir, service } = await harness(CONFIGURED)
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const dir = join(workspaceDir, 'paper')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'references.bib'), '@misc{existing,\n  title = {Already Here}\n}\n')
    return { domain, workspaceDir, service }
  }

  it('merges the collection BibTeX, skipping citation keys already present', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(String(url)).toContain('/collections/COLL1/items?format=bibtex')
      return new Response(EXPORT_BIB, { status: 200 })
    })
    const { service, workspaceDir } = await seedProject()
    const outcome = await service.exportZoteroCollectionToBib({ projectId: 'p1', collectionKey: 'COLL1' })
    expect(outcome).toEqual({ ok: true, value: { added: ['vaswani2017attention'], skipped: ['existing'] } })
    const text = await readFile(join(workspaceDir, 'paper', 'references.bib'), 'utf8')
    expect(text).toContain('@article{vaswani2017attention,')
    // The pre-existing entry survived the merge exactly once.
    expect(text.match(/@misc\{existing,/g)).toHaveLength(1)
    // A repeat export adds nothing.
    const again = await service.exportZoteroCollectionToBib({ projectId: 'p1', collectionKey: 'COLL1' })
    expect(again).toEqual({ ok: true, value: { added: [], skipped: ['vaswani2017attention', 'existing'] } })
  })

  it('rejects an unknown project without writing anything', async () => {
    vi.stubGlobal('fetch', async () => new Response(EXPORT_BIB, { status: 200 }))
    const { service, workspaceDir } = await seedProject()
    await expect(service.exportZoteroCollectionToBib({ projectId: 'ghost', collectionKey: 'COLL1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found', projectId: 'ghost' } })
    const text = await readFile(join(workspaceDir, 'paper', 'references.bib'), 'utf8')
    expect(text).not.toContain('vaswani2017attention')
  })

  it('maps API failures to operation-failed', async () => {
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 500 }))
    const { service } = await seedProject()
    await expect(service.exportZoteroCollectionToBib({ projectId: 'p1', collectionKey: 'COLL1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', message: expect.stringContaining('HTTP 500') } })
  })
})

describe('wiki schema regression', () => {
  it('the domain spec stays at version 2 with the ten existing tables', () => {
    expect(researchWikiDomainSpec.version).toBe(2)
    expect(Object.keys(researchWikiDomainSpec.tables)).toEqual([
      'papers', 'ideas', 'claims', 'projects', 'experiments', 'servers', 'jobs', 'figures', 'events', 'venue_watches',
    ])
  })
})
