/**
 * Behavior tests for the Zotero write-back (#151): the pure payload/identity
 * mapping, and `pushZoteroCollection` against a scripted fetch.
 *
 * The properties that matter and are asserted here:
 * - a first push creates the collection and one item per linked paper;
 * - a second push creates nothing, because every entry is matched first;
 * - a 429 on the write retries with the same `Zotero-Write-Token`, so the retry
 *   cannot duplicate what it already created;
 * - a record with no title degrades to a note instead of failing the push;
 * - one rejected item lands in `failures` with its papers-table id while the
 *   rest still go out.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import {
  batchPayloads,
  pushIdentityOf,
  samePaper,
  zoteroItemPayloadOf,
} from '../src/zotero-push.ts'
import type { PushEntry } from '../src/zotero-push.ts'
import type { ZoteroItem } from '../src/tools/zotero.ts'
import type { PaperRecord, ProjectRecord } from '../src/types.ts'

const CONFIG = { apiKey: 'secret-key', userId: '12345678' }

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Related Work',
  stage: 'writing',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-09-01T00:00:00.000Z',
}

/** One library record linked to {@link PROJECT}. */
function paper(arxivId: string, overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    arxivId,
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Google Brain'],
    summary: '',
    url: `https://arxiv.org/abs/${arxivId}`,
    notes: '',
    tags: [],
    projectIds: [PROJECT.id],
    addedAt: '2026-09-01T00:00:00.000Z',
    published: '2017',
    doi: '10.5555/3295222',
    ...overrides,
  }
}

/** One parsed library item, as the search endpoint would return it. */
function item(overrides: Partial<ZoteroItem> = {}): ZoteroItem {
  return {
    key: 'ABCD2345',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani'],
    year: '2017',
    doi: '',
    arxivId: null,
    publicationTitle: '',
    url: '',
    ...overrides,
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('zotero push mapping (pure)', () => {
  const ENTRY: PushEntry = {
    paperId: '1706.03762',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Google Brain'],
    year: '2017',
    doi: '10.5555/3295222',
    arxivId: '1706.03762v5',
    url: '',
    publicationTitle: 'NeurIPS',
  }

  it('prefers the arXiv id for the dedupe query, stripping the version', () => {
    expect(pushIdentityOf(ENTRY)).toEqual({
      arxivId: '1706.03762',
      doi: '10.5555/3295222',
      title: 'attention is all you need',
      query: '1706.03762',
    })
  })

  it('falls back to the DOI and then the title when there is no arXiv id', () => {
    expect(pushIdentityOf({ ...ENTRY, arxivId: null }).query).toBe('10.5555/3295222')
    expect(pushIdentityOf({ ...ENTRY, arxivId: null, doi: undefined }).query).toBe('Attention Is All You Need')
  })

  it('matches on arXiv id, then DOI, then a normalized title', () => {
    expect(samePaper(item({ arxivId: '1706.03762v1' }), ENTRY)).toBe(true)
    expect(samePaper(item({ doi: '10.5555/3295222' }), ENTRY)).toBe(true)
    expect(samePaper(item({ title: 'attention is all you need.' }), ENTRY)).toBe(true)
    expect(samePaper(item({ title: 'A different paper' }), ENTRY)).toBe(false)
  })

  it('carries the arXiv id where Zotero translators put it', () => {
    const payload = zoteroItemPayloadOf(ENTRY, 'COLL1')
    expect(payload).toMatchObject({
      itemType: 'journalArticle',
      title: 'Attention Is All You Need',
      extra: 'arXiv: 1706.03762',
      collections: ['COLL1'],
      date: '2017',
      DOI: '10.5555/3295222',
      url: 'https://arxiv.org/abs/1706.03762',
    })
    expect(payload.creators).toEqual([
      { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
      // A name with a space splits into Zotero's two fields. Without an
      // institution list there is no way to tell "Google Brain" from a person,
      // and splitting is the commoner case by far.
      { creatorType: 'author', firstName: 'Google', lastName: 'Brain' },
    ])
  })

  it('keeps a single-token name in Zotero\'s one-field creator form', () => {
    const payload = zoteroItemPayloadOf({ ...ENTRY, authors: ['Aristotle'] }, 'COLL1')
    expect(payload.creators).toEqual([{ creatorType: 'author', name: 'Aristotle' }])
  })

  it('degrades a titleless record to a note instead of throwing', () => {
    const payload = zoteroItemPayloadOf({ ...ENTRY, title: '  ' }, 'COLL1')
    expect(payload).toMatchObject({ itemType: 'note', collections: ['COLL1'] })
    expect(String(payload.note)).toContain('Ashish Vaswani')
    expect(String(payload.note)).toContain('10.5555/3295222')
  })

  it('omits the fields the record does not have', () => {
    const payload = zoteroItemPayloadOf({ ...ENTRY, year: undefined, doi: undefined, arxivId: null, publicationTitle: undefined }, 'COLL1')
    expect(payload).not.toHaveProperty('date')
    expect(payload).not.toHaveProperty('DOI')
    expect(payload).not.toHaveProperty('extra')
    expect(payload).not.toHaveProperty('publicationTitle')
    expect(payload.itemType).toBe('document')
  })

  it('batches at the write endpoint cap, preserving order', () => {
    const payloads = Array.from({ length: 51 }, (_, index) => ({ title: `t${String(index)}` }))
    const batches = batchPayloads(payloads)
    expect(batches.map(batch => batch.length)).toEqual([50, 1])
    expect(batches[1]?.[0]).toEqual({ title: 't50' })
  })
})

describe('pushZoteroCollection (#151)', () => {
  it('creates the collection and one item per linked paper', async () => {
    const { service, domain } = await boot()
    await domain.table('papers').put('1706.03762', paper('1706.03762'))
    await domain.table('papers').put('1810.04805', paper('1810.04805', { title: 'BERT', doi: '10.1/bert' }))
    const fetch = scriptedFetch()
    vi.stubGlobal('fetch', fetch)
    const result = await service.pushZoteroCollection({ projectId: PROJECT.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ collectionKey: 'NEWCOLL', collectionName: 'Related Work', created: 2, skipped: 0, failures: [] })
    expect(fetch.calls.filter(call => call.method === 'POST' && call.url.endsWith('/collections'))).toHaveLength(1)
    const written = fetch.calls.filter(call => call.method === 'POST' && call.url.endsWith('/items'))
    expect(written).toHaveLength(1)
    const body = JSON.parse(written[0]?.body ?? '[]') as Record<string, unknown>[]
    expect(body.map(entry => entry.title)).toEqual(['Attention Is All You Need', 'BERT'])
    expect(body.every(entry => Array.isArray(entry.collections) && entry.collections[0] === 'NEWCOLL')).toBe(true)
  })

  it('creates nothing on a second push, because every entry is matched first', async () => {
    const { service, domain } = await boot()
    await domain.table('papers').put('1706.03762', paper('1706.03762'))
    const fetch = scriptedFetch({ libraryIsPopulated: true })
    vi.stubGlobal('fetch', fetch)
    const result = await service.pushZoteroCollection({ projectId: PROJECT.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ created: 0, skipped: 1, failures: [] })
    expect(fetch.calls.filter(call => call.method === 'POST' && call.url.endsWith('/items'))).toHaveLength(0)
  })

  it('retries a rate-limited write with the same write token', async () => {
    const { service, domain } = await boot()
    await domain.table('papers').put('1706.03762', paper('1706.03762'))
    const fetch = scriptedFetch({ rateLimitFirstWrite: true })
    vi.stubGlobal('fetch', fetch)
    const result = await service.pushZoteroCollection({ projectId: PROJECT.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.created).toBe(1)
    const writes = fetch.calls.filter(call => call.method === 'POST' && call.url.endsWith('/items'))
    expect(writes).toHaveLength(2)
    // The retry must be the same write: a fresh token would create a duplicate.
    expect(writes[0]?.writeToken).toBe(writes[1]?.writeToken)
    expect(writes[0]?.writeToken).not.toBe('')
  })

  it('sends a titleless record as a note rather than dropping it', async () => {
    const { service, domain } = await boot()
    await domain.table('papers').put('1706.03762', paper('1706.03762', { title: '   ' }))
    const fetch = scriptedFetch()
    vi.stubGlobal('fetch', fetch)
    const result = await service.pushZoteroCollection({ projectId: PROJECT.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.created).toBe(1)
    const body = JSON.parse(fetch.calls.find(call => call.method === 'POST' && call.url.endsWith('/items'))?.body ?? '[]') as Record<string, unknown>[]
    expect(body[0]?.itemType).toBe('note')
  })

  it('reports one rejected item by its papers-table id and still pushes the rest', async () => {
    const { service, domain } = await boot()
    await domain.table('papers').put('1706.03762', paper('1706.03762'))
    await domain.table('papers').put('1810.04805', paper('1810.04805', { title: 'BERT' }))
    const fetch = scriptedFetch({ rejectSecondItem: true })
    vi.stubGlobal('fetch', fetch)
    const result = await service.pushZoteroCollection({ projectId: PROJECT.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.created).toBe(1)
    expect(result.value.failures).toEqual([{ paperId: '1810.04805', message: 'field is not valid' }])
  })

  it('creates no collection when the project holds no papers', async () => {
    const { service } = await boot()
    const fetch = scriptedFetch()
    vi.stubGlobal('fetch', fetch)
    const result = await service.pushZoteroCollection({ projectId: PROJECT.id })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ collectionKey: null, created: 0, skipped: 0 })
    expect(fetch.calls).toHaveLength(0)
  })

  it('rejects an unknown project and the unconfigured case', async () => {
    const configured = await boot()
    const fetch = scriptedFetch()
    vi.stubGlobal('fetch', fetch)
    await expect(configured.service.pushZoteroCollection({ projectId: 'nope' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
    const bare = await boot(null)
    await expect(bare.service.pushZoteroCollection({ projectId: PROJECT.id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fetch.calls).toHaveLength(0)
  })

  it('never leaks the API key into a result message', async () => {
    const { service, domain } = await boot()
    await domain.table('papers').put('1706.03762', paper('1706.03762'))
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 403 }))
    const result = await service.pushZoteroCollection({ projectId: PROJECT.id })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(JSON.stringify(result.error)).not.toContain('secret-key')
  })
})

/** One recorded fetch call, flattened for assertions. */
interface RecordedCall {
  readonly method: string
  readonly url: string
  readonly body: string
  readonly writeToken: string
}

/**
 * A fetch stand-in that answers the four endpoints the push touches.
 * @param options - scenario switches (pre-populated library, a 429 on the first
 * write, one item rejected by the write endpoint).
 * @returns the fetch function plus the calls it saw.
 */
function scriptedFetch(options: {
  libraryIsPopulated?: boolean
  rateLimitFirstWrite?: boolean
  rejectSecondItem?: boolean
} = {}): ((url: string, init: RequestInit) => Promise<Response>) & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let writes = 0
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET'
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({
      method,
      url,
      body: typeof init.body === 'string' ? init.body : '',
      writeToken: headers['Zotero-Write-Token'] ?? '',
    })
    if (method === 'POST' && url.endsWith('/collections')) {
      return Response.json({ successful: { '0': { key: 'NEWCOLL' } }, failed: {} })
    }
    if (method === 'POST' && url.endsWith('/items')) {
      writes += 1
      if (options.rateLimitFirstWrite === true && writes === 1) {
        return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
      }
      if (options.rejectSecondItem === true) {
        return Response.json({
          successful: { '0': { key: 'I1' } },
          failed: { '1': { code: 400, message: 'field is not valid' } },
        })
      }
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '[]') as unknown[]
      const successful: Record<string, { key: string }> = {}
      body.forEach((_, index) => { successful[String(index)] = { key: `I${String(index)}` } })
      return Response.json({ successful, failed: {} })
    }
    if (url.includes('/collections?limit=')) {
      return Response.json(
        options.libraryIsPopulated === true
          ? [{ key: 'NEWCOLL', data: { name: 'Related Work' }, meta: { numItems: 1 } }]
          : [],
      )
    }
    if (url.includes('/items?q=')) {
      // The dedupe lookup: a populated library already holds the same paper.
      return Response.json(options.libraryIsPopulated === true ? [ARXIV_ITEM] : [])
    }
    return new Response('unexpected', { status: 500 })
  }
  return Object.assign(fetch, { calls })
}

/** One library item body the search endpoint returns for a populated library. */
const ARXIV_ITEM = {
  key: 'ABCD2345',
  data: {
    key: 'ABCD2345',
    itemType: 'journalArticle',
    title: 'Attention Is All You Need',
    creators: [{ creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' }],
    date: '2017',
    extra: 'arXiv: 1706.03762',
  },
}

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function boot(zotero: { apiKey: string; userId: string } | null = CONFIG) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  await domain.table('projects').put(PROJECT.id, PROJECT)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-zpush-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
    ...(zotero === null ? {} : { zotero }),
  })
  return { service, domain }
}
