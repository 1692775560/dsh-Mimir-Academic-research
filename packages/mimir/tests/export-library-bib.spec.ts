/**
 * Behavior tests for `exportLibraryBib`: the whole-library / subset `.bib`
 * export the Library view's download button calls. The service is read-only
 * and project-agnostic (unlike `importPapersToBib`), so these pin the three
 * things a caller can get wrong: what a subset means, what an unknown id
 * means, and what the text actually is.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import type { PaperRecord } from '../src/types.ts'

function paperRecord(arxivId: string, addedAt: string): PaperRecord {
  return {
    arxivId,
    title: `Title of ${arxivId}`,
    authors: ['Doe, Jane'],
    summary: 'Abstract.',
    url: `https://arxiv.org/abs/${arxivId}`,
    notes: '',
    tags: [],
    projectIds: [],
    addedAt,
    published: '2021-03-04',
  }
}

/** Boot a memory-backed domain and the service over a fresh temp workspace. */
async function harness(): Promise<{ domain: Awaited<ReturnType<DomainFacility['open']>>; service: ResearchService }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-export-bib-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
  })
  return { domain, service }
}

describe('exportLibraryBib', () => {
  it('serializes the whole library, newest first, as parseable .bib', async () => {
    const { domain, service } = await harness()
    await domain.table('papers').put('2103.00020', paperRecord('2103.00020', '2026-01-01T00:00:00.000Z'))
    await domain.table('papers').put('1706.03762', paperRecord('1706.03762', '2026-03-01T00:00:00.000Z'))

    const outcome = await service.exportLibraryBib({})

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.count).toBe(2)
    // Library order is newest-first, and the serializer preserves it.
    const keys = [...outcome.value.bib.matchAll(/@misc\{([^,]+),/g)].map(match => match[1])
    expect(keys).toEqual(['170603762', '210300020'])
    expect(outcome.value.bib.endsWith('\n')).toBe(true)
    expect(outcome.value.bib).toContain('title = {Title of 1706.03762}')
  })

  it('narrows to a requested subset and keeps only those entries', async () => {
    const { domain, service } = await harness()
    await domain.table('papers').put('2103.00020', paperRecord('2103.00020', '2026-01-01T00:00:00.000Z'))
    await domain.table('papers').put('1706.03762', paperRecord('1706.03762', '2026-03-01T00:00:00.000Z'))

    const outcome = await service.exportLibraryBib({ arxivIds: ['2103.00020'] })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.count).toBe(1)
    expect(outcome.value.bib).toContain('2103.00020')
    expect(outcome.value.bib).not.toContain('1706.03762')
  })

  it('rejects an unknown id instead of returning a silently shorter document', async () => {
    const { domain, service } = await harness()
    await domain.table('papers').put('2103.00020', paperRecord('2103.00020', '2026-01-01T00:00:00.000Z'))

    const outcome = await service.exportLibraryBib({ arxivIds: ['2103.00020', '9999.99999'] })

    expect(outcome).toEqual({ ok: false, error: { code: 'paper-not-found' } })
  })

  it('serializes an empty library to the empty string, not an error', async () => {
    const { service } = await harness()

    const outcome = await service.exportLibraryBib({})

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value).toEqual({ bib: '', count: 0 })
  })
})
