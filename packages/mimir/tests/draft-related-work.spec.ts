/**
 * Remote-path tests for `draftRelatedWork` (#153): the address validation the
 * issue names (`isValidProjectId` plus a real project), the `paper-not-found`
 * branch, and the bibliography bookkeeping that decides which cited keys still
 * need an entry.
 *
 * The prose itself is covered by `related-work-draft.spec.ts`; what is asserted
 * here is the shell around it — that it reads the project's own
 * `references.bib`, that a version suffix on the requested id does not lose the
 * record, and that nothing is written back to the paper.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { draftRelatedWork } from '../src/services/paper.ts'
import type { PaperRecord, ProjectRecord } from '../src/types.ts'

const PROJECT: ProjectRecord = {
  id: 'proj-rw',
  title: 'related work project',
  stage: 'writing',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-09-01T00:00:00.000Z',
}

/** One library record, filed under `arxivId`. */
function paper(arxivId: string, overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    arxivId,
    title: `title of ${arxivId}`,
    authors: ['Ada Lovelace'],
    summary: `summary of ${arxivId}. Second sentence.`,
    url: `https://arxiv.org/abs/${arxivId}`,
    notes: '',
    tags: [],
    projectIds: [],
    addedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

/** One BibTeX entry with the given key. */
function bibEntry(key: string): string {
  return `@misc{${key},\n  title = {${key}},\n  author = {Someone},\n}\n`
}

/** Boot the paper service over a memory domain and a temp workspace. */
async function harness(bibKeys: readonly string[] = []) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-rw-'))
  await mkdir(join(workspaceDir, 'paper'), { recursive: true })
  await writeFile(join(workspaceDir, 'paper', 'references.bib'), bibKeys.map(bibEntry).join('\n'))
  await domain.table('projects').put(PROJECT.id, PROJECT)
  const deps = { workspaceDir, domain, latex: { engine: 'auto' as const, timeoutMs: 1000 } }
  return { deps, domain, workspaceDir }
}

describe('draftRelatedWork (#153)', () => {
  it('cites every selected paper with the key the project bibliography uses', async () => {
    const { deps, domain } = await harness(['170603762'])
    await domain.table('papers').put('1706.03762', paper('1706.03762'))
    await domain.table('papers').put('1810.04805', paper('1810.04805'))
    const result = await draftRelatedWork(deps, {
      projectId: PROJECT.id,
      arxivIds: ['1706.03762', '1810.04805'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.keys).toEqual(['170603762', '181004805'])
    expect(result.value.text).toContain('\\cite{170603762}')
    expect(result.value.text).toContain('\\cite{181004805}')
    // Only the key the .bib actually lacks is reported as missing.
    expect(result.value.missingBibKeys).toEqual(['181004805'])
  })

  it('reports every key as missing when the project has no references.bib yet', async () => {
    const { deps, domain, workspaceDir } = await harness()
    // An absent bibliography is a normal state, not an error.
    await rm(join(workspaceDir, 'paper', 'references.bib'), { force: true })
    await domain.table('papers').put('1706.03762', paper('1706.03762'))
    const result = await draftRelatedWork(deps, { projectId: PROJECT.id, arxivIds: ['1706.03762'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.missingBibKeys).toEqual(['170603762'])
  })

  it('finds a record filed without the version suffix the caller asked with', async () => {
    const { deps, domain } = await harness(['210300020v2'])
    await domain.table('papers').put('2103.00020', paper('2103.00020'))
    const result = await draftRelatedWork(deps, { projectId: PROJECT.id, arxivIds: ['2103.00020v2'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The citation key comes from the record, so it keeps the version form the
    // bibliography was written with.
    expect(result.value.keys).toEqual(['210300020'])
  })

  it('rejects a project id that fails the whitelist', async () => {
    const { deps } = await harness()
    for (const projectId of ['../etc', '.hidden', '/abs', 'a/b']) {
      const result = await draftRelatedWork(deps, { projectId, arxivIds: [] })
      expect(result.ok, projectId).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('invalid-input')
    }
  })

  it('rejects a project the wiki does not have', async () => {
    const { deps } = await harness()
    const result = await draftRelatedWork(deps, { projectId: 'proj-missing', arxivIds: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('project-not-found')
  })

  it('rejects a paper the library does not hold', async () => {
    const { deps } = await harness()
    const result = await draftRelatedWork(deps, { projectId: PROJECT.id, arxivIds: ['9999.99999'] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('paper-not-found')
  })

  it('carries the hint into the draft as a comment', async () => {
    const { deps, domain } = await harness(['170603762'])
    await domain.table('papers').put('1706.03762', paper('1706.03762'))
    const result = await draftRelatedWork(deps, {
      projectId: PROJECT.id,
      arxivIds: ['1706.03762'],
      hint: 'group by architecture',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.text).toContain('% Steer: group by architecture')
  })

  it('works from notes when the record carries them', async () => {
    const { deps, domain } = await harness(['170603762'])
    await domain.table('papers').put(
      '1706.03762',
      paper('1706.03762', { notes: 'Replaces recurrence with attention. Details follow.' }),
    )
    const result = await draftRelatedWork(deps, { projectId: PROJECT.id, arxivIds: ['1706.03762'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.text).toContain('Replaces recurrence with attention.')
    expect(result.value.text).not.toContain('summary of 1706.03762')
  })

  it('writes nothing into the paper directory', async () => {
    const { deps, domain, workspaceDir } = await harness(['170603762'])
    await domain.table('papers').put('1706.03762', paper('1706.03762'))
    const before = await readdir(join(workspaceDir, 'paper'))
    await draftRelatedWork(deps, { projectId: PROJECT.id, arxivIds: ['1706.03762'] })
    const after = await readdir(join(workspaceDir, 'paper'))
    // The whole point of returning text: the draft cannot land in main.tex
    // behind the user's back.
    expect(after).toEqual(before)
  })
})
