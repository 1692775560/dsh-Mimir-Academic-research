/**
 * Behavior tests for the shared arXiv-id path-safety predicate and its
 * enforcement points: the wiki write tool, the literature import/fetch
 * services, the load-time quarantine, and the filesystem reads (cached PDF,
 * figure crops). Traversal, absolute paths, and backslashes are rejected
 * everywhere; a real old-style id with a slash passes.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { isValidArxivId } from '../src/arxiv-id.ts'
import { paperRecord, researchWikiDomainSpec } from '../src/store.ts'
import { createWikiNoteTool } from '../src/tools/wiki.ts'
import { resolvePaperPdf } from '../src/services/paper-figures.ts'
import { loadPaperFigures } from '../src/services/meeting.ts'

describe('isValidArxivId', () => {
  it('accepts modern, versioned, and old-style slashed ids', () => {
    expect(isValidArxivId('2304.06024')).toBe(true)
    expect(isValidArxivId('2304.06024v2')).toBe(true)
    expect(isValidArxivId('hep-th/9901001')).toBe(true)
    expect(isValidArxivId('cs.CV/0601001v3')).toBe(true)
  })

  it('rejects traversal, absolute paths, backslashes, and empty input', () => {
    expect(isValidArxivId('../../etc')).toBe(false)
    expect(isValidArxivId('a/../b')).toBe(false)
    expect(isValidArxivId('..')).toBe(false)
    expect(isValidArxivId('/etc/passwd')).toBe(false)
    expect(isValidArxivId('..\\windows')).toBe(false)
    expect(isValidArxivId('C:/temp')).toBe(false)
    expect(isValidArxivId('')).toBe(false)
    expect(isValidArxivId('some id')).toBe(false)
  })
})

describe('paperRecord schema', () => {
  it('parses any id string at load time (quarantine, not the schema, removes unsafe rows)', () => {
    // Load-time tolerance: a library carrying a legacy unsafe id must still
    // open; quarantineUnsafePaperIds (store.spec.ts) deletes the row on boot,
    // and the write tools/services reject unsafe ids before they land.
    const base = {
      title: 't', authors: [], summary: 's', url: 'u', notes: '', addedAt: '2026-08-20T00:00:00.000Z',
    }
    expect(paperRecord.safeParse({ ...base, arxivId: 'hep-th/9901001' }).success).toBe(true)
    expect(paperRecord.safeParse({ ...base, arxivId: '../../etc' }).success).toBe(true)
  })
})

describe('wiki_note add_paper id safety', () => {
  it('rejects a traversal arxiv_id without writing', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    ctx.storage.backend.register('memory', backend)
    ctx.provide(storageBackendServiceKey('memory'), backend)
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    const domain = await facility.open(researchWikiDomainSpec)
    const tool = createWikiNoteTool(domain)
    await expect(tool.execute(
      { action: 'add_paper', arxiv_id: '../../etc', title: 'x', summary: 'y' },
      {} as ToolRunContext,
    )).rejects.toThrow('unsafe arxiv_id')
    expect(domain.table('papers').get('../../etc')).toBeUndefined()
  })
})

describe('filesystem reads fail closed on unsafe ids', () => {
  it('resolvePaperPdf finds the percent-encoded file of a slashed id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mimir-arxivid-'))
    await mkdir(join(dir, 'papers'), { recursive: true })
    await writeFile(join(dir, 'papers', 'hep-th%2F9901001.pdf'), '%PDF fake')
    expect(await resolvePaperPdf(dir, 'hep-th/9901001'))
      .toBe(join(dir, 'papers', 'hep-th%2F9901001.pdf'))
  })

  it('resolvePaperPdf never escapes the papers directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mimir-arxivid-'))
    await mkdir(join(dir, 'papers'), { recursive: true })
    await writeFile(join(dir, 'escape.pdf'), '%PDF fake')
    expect(await resolvePaperPdf(dir, '../escape')).toBeUndefined()
  })

  it('loadPaperFigures returns empty for an unsafe id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mimir-arxivid-'))
    expect(await loadPaperFigures(dir, '../../etc')).toEqual([])
  })
})
