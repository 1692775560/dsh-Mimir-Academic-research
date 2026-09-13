/**
 * Behavior tests for the wiki export/import remotes: exportWiki snapshot
 * completeness (all seven tables, envelope fields, records with their keys),
 * importWiki merge (absent keys upsert, existing records skipped untouched),
 * replace (wipes first, requires confirmReplace), invalid-record rejection
 * before any write, and the format/version envelope checks — plus the pure
 * validators in wiki-snapshot.ts. Memory-backed domain, no mocks.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import {
  buildWikiSnapshot, snapshotEnvelopeError, snapshotTables, tableRowsError,
  WIKI_SNAPSHOT_FORMAT, WIKI_SNAPSHOT_VERSION, WIKI_SNAPSHOT_MIN_VERSION,
} from '../src/wiki-snapshot.ts'
import { recoverPendingWikiImport, WIKI_IMPORT_RECOVERY_FILE } from '../src/services/wiki-admin.ts'
import { appendEvent, PANEL_ACTOR } from '../src/ledger.ts'
import type {
  ExperimentRecord, FigureRecord, PaperRecord, ProjectRecord, ResearchWikiSnapshot, ServerRecord,
} from '../src/types.ts'

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function harness(pool = new MemoryMediaPool(), workspaceDir?: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  workspaceDir ??= await mkdtemp(join(tmpdir(), 'mimir-wiki-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
  })
  return { ctx, domain, pool, service, workspaceDir }
}

const PAPER: PaperRecord = {
  arxivId: '2401.00001',
  title: 'Paper One',
  authors: ['A. One'],
  summary: 'summary',
  url: 'https://arxiv.org/abs/2401.00001',
  notes: 'curated note',
  tags: ['baseline'],
  projectIds: ['p1'],
  addedAt: '2026-08-01T00:00:00.000Z',
}

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Project',
  stage: 'writing',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

const EXPERIMENT: ExperimentRecord = {
  id: 'e1',
  projectId: 'p1',
  name: 'run one',
  status: 'success',
  metrics: { mpjpe: 82.9 },
  updatedAt: '2026-08-20T00:00:00.000Z',
}

const SERVER: ServerRecord = {
  id: 's1',
  name: 'gpu01',
  host: '127.0.0.1',
  port: 22,
  username: 'ops',
  note: '',
  tags: [],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

const FIGURE: FigureRecord = {
  id: 'p1:figures/curve.png',
  projectId: 'p1',
  relPath: 'figures/curve.png',
  caption: 'Training curve',
  experimentId: 'e1',
  createdAt: '2026-08-20T00:00:00.000Z',
}

const IDEA = {
  id: 'i1', title: 'Idea', hypothesis: 'It works.', status: 'active', createdAt: '2026-08-01T00:00:00.000Z',
} as const

const CLAIM = { id: 'c1', text: 'Claim', status: 'supported', evidence: 'Evidence' } as const

/** Seed one record into five snapshot tables. */
async function seed(domain: Awaited<ReturnType<typeof harness>>['domain']): Promise<void> {
  await domain.table('papers').put(PAPER.arxivId, PAPER)
  await domain.table('projects').put(PROJECT.id, PROJECT)
  await domain.table('experiments').put(EXPERIMENT.id, EXPERIMENT)
  await domain.table('servers').put(SERVER.id, SERVER)
  await domain.table('figures').put(FIGURE.id, FIGURE)
}

/** Fill the three remaining snapshot tables for all-table recovery checks. */
async function seedAll(domain: Awaited<ReturnType<typeof harness>>['domain']): Promise<void> {
  await seed(domain)
  await domain.table('ideas').put(IDEA.id, IDEA)
  await domain.table('claims').put(CLAIM.id, CLAIM)
  await appendEvent(domain, { actor: PANEL_ACTOR, action: 'knowledge.claim.set', refs: { claimId: CLAIM.id }, payload: {} })
}

/** Export through the service and assert the envelope; returns the snapshot. */
async function exportOk(service: ResearchService): Promise<ResearchWikiSnapshot> {
  const outcome = await service.exportWiki()
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) throw new Error('unreachable')
  const { snapshot } = outcome.value
  expect(snapshot.format).toBe(WIKI_SNAPSHOT_FORMAT)
  expect(snapshot.version).toBe(WIKI_SNAPSHOT_VERSION)
  expect(typeof snapshot.exportedAt).toBe('string')
  return snapshot
}

describe('exportWiki', () => {
  it('snapshots all seven tables with every record', async () => {
    const { domain, service } = await harness()
    await seed(domain)
    const snapshot = await exportOk(service)
    expect(snapshot.tables.papers).toEqual([PAPER])
    expect(snapshot.tables.projects).toEqual([PROJECT])
    expect(snapshot.tables.experiments).toEqual([EXPERIMENT])
    expect(snapshot.tables.servers).toEqual([SERVER])
    expect(snapshot.tables.figures).toEqual([FIGURE])
    expect(snapshot.tables.ideas).toEqual([])
    expect(snapshot.tables.claims).toEqual([])
  })

  it('round-trips through JSON (the download/upload path)', async () => {
    const { domain, service } = await harness()
    await seed(domain)
    const snapshot = await exportOk(service)
    const parsed: unknown = JSON.parse(JSON.stringify(snapshot))
    expect(snapshotEnvelopeError(parsed)).toBeNull()
  })

  it('carries the whole ledger — the CBE layer’s single source of truth', async () => {
    const { domain, service } = await harness()
    await seed(domain)
    await appendEvent(domain, {
      actor: PANEL_ACTOR,
      action: 'knowledge.claim.set',
      refs: { claimId: 'c1' },
      payload: { status: 'supported' },
    })
    const snapshot = await exportOk(service)
    // Without the events table a restore would bring the library back and
    // silently zero worktree / habits / foraging / eureka / digest.
    expect(snapshot.tables.events).toHaveLength(1)
    expect(snapshotTables(snapshot)).toContain('events')
  })
})

describe('importWiki merge', () => {
  it('upserts absent keys and skips existing records untouched', async () => {
    const { domain, service } = await harness()
    await seed(domain)
    const snapshot = await exportOk(service)
    const fresh: PaperRecord = { ...PAPER, arxivId: '2401.00002', title: 'Paper Two' }
    const clone: ResearchWikiSnapshot = {
      ...(JSON.parse(JSON.stringify(snapshot)) as ResearchWikiSnapshot),
      // An edited copy of the existing paper must NOT overwrite the original.
      tables: { ...snapshot.tables, papers: [{ ...PAPER, title: 'Overwritten', notes: '' }, fresh] },
    }
    const outcome = await service.importWiki({ snapshot: clone, mode: 'merge' })
    expect(outcome).toEqual({
      ok: true,
      value: {
        imported: { papers: 1, ideas: 0, claims: 0, projects: 0, experiments: 0, servers: 0, figures: 0, events: 0 },
        skipped: { papers: 1, ideas: 0, claims: 0, projects: 1, experiments: 1, servers: 1, figures: 1, events: 0 },
      },
    })
    expect(domain.table('papers').get(PAPER.arxivId)).toEqual(PAPER)
    expect(domain.table('papers').get(fresh.arxivId)).toEqual(fresh)
  })
})

describe('importWiki replace', () => {
  it('treats an absent recovery journal in a missing workspace as a no-op', async () => {
    const { domain } = await harness()
    await expect(recoverPendingWikiImport({ domain, workspaceDir: join(tmpdir(), 'mimir-missing-workspace') }))
      .resolves.toBeUndefined()
  })

  it('requires confirmReplace: true', async () => {
    const { domain, service } = await harness()
    await seed(domain)
    const snapshot = await exportOk(service)
    const outcome = await service.importWiki({ snapshot, mode: 'replace' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.error.code).toBe('invalid-input')
    // Nothing was wiped.
    expect(domain.table('papers').get(PAPER.arxivId)).toEqual(PAPER)
  })

  it('wipes all seven tables and writes the snapshot', async () => {
    const { domain, service } = await harness()
    await seed(domain)
    const snapshot = await exportOk(service)
    const clone: ResearchWikiSnapshot = {
      ...(JSON.parse(JSON.stringify(snapshot)) as ResearchWikiSnapshot),
      tables: { ...snapshot.tables, papers: [], experiments: [] },
    }
    const outcome = await service.importWiki({ snapshot: clone, mode: 'replace', confirmReplace: true })
    expect(outcome).toEqual({
      ok: true,
      value: {
        imported: { papers: 0, ideas: 0, claims: 0, projects: 1, experiments: 0, servers: 1, figures: 1, events: 0 },
        skipped: { papers: 0, ideas: 0, claims: 0, projects: 0, experiments: 0, servers: 0, figures: 0, events: 0 },
      },
    })
    expect(domain.table('papers').get(PAPER.arxivId)).toBeUndefined()
    expect(domain.table('experiments').get(EXPERIMENT.id)).toBeUndefined()
    expect(domain.table('projects').get(PROJECT.id)).toEqual(PROJECT)
    expect(domain.table('figures').get(FIGURE.id)).toEqual(FIGURE)
  })

  it('round-trips every snapshot table into an empty domain', async () => {
    const source = await harness()
    await seedAll(source.domain)
    const snapshot = await exportOk(source.service)
    const target = await harness()
    await target.service.importWiki({ snapshot, mode: 'replace', confirmReplace: true })
    for (const name of snapshotTables(snapshot)) {
      for (const row of snapshot.tables[name]) {
        const key = name === 'papers' ? row.arxivId : row.id
        expect(target.domain.table(name).get(key)).toEqual(row)
      }
    }
  })

  it.each([0, 4, 8])('restores the complete old state when replace fails after %i writes', async (writes) => {
    const target = await harness()
    await seedAll(target.domain)
    const before = buildWikiSnapshot(target.domain)
    const incoming = await harness()
    await seed(incoming.domain)
    const snapshot = await exportOk(incoming.service)
    target.pool.failAfterSuccessfulWrites(writes)
    await expect(target.service.importWiki({ snapshot, mode: 'replace', confirmReplace: true }))
      .rejects.toThrow('injected write failure')
    for (const name of snapshotTables(before)) {
      expect([...target.domain.table(name).entries()].map(([, row]) => row)).toEqual(before.tables[name])
    }
  })

  it('restores a pending replace journal after restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    await seed(first.domain)
    const before = await exportOk(first.service)
    await writeFile(join(first.workspaceDir, WIKI_IMPORT_RECOVERY_FILE), JSON.stringify(before))
    await first.domain.table('papers').delete(PAPER.arxivId)
    await first.domain.close()
    const restarted = await harness(pool, first.workspaceDir)
    await recoverPendingWikiImport({ domain: restarted.domain, workspaceDir: restarted.workspaceDir })
    for (const name of snapshotTables(before)) {
      expect([...restarted.domain.table(name).entries()].map(([, row]) => row)).toEqual(before.tables[name])
    }
  })

  it('still skips path-unsafe paper ids during replacement', async () => {
    const target = await harness()
    const snapshot = await exportOk(target.service)
    const unsafe = { ...PAPER, arxivId: '../escape' }
    const incoming = { ...snapshot, tables: { ...snapshot.tables, papers: [unsafe] } }
    const outcome = await target.service.importWiki({ snapshot: incoming, mode: 'replace', confirmReplace: true })
    expect(outcome.ok).toBe(true)
    expect(target.domain.table('papers').get(unsafe.arxivId)).toBeUndefined()
  })
})

describe('importWiki ledger restore', () => {
  it('restores the events table from a v3 snapshot', async () => {
    const source = await harness()
    await seed(source.domain)
    await appendEvent(source.domain, {
      actor: PANEL_ACTOR,
      action: 'knowledge.claim.set',
      refs: { claimId: 'c1' },
      payload: { status: 'supported' },
    })
    const snapshot = await exportOk(source.service)
    const carried = snapshot.tables.events[0]
    expect(carried).toBeDefined()

    const target = await harness()
    const outcome = await target.service.importWiki({
      snapshot: JSON.parse(JSON.stringify(snapshot)) as ResearchWikiSnapshot,
      mode: 'merge',
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.value.imported.events).toBe(1)
    // (exportWiki/importWiki ledger their own audit events afterwards, so the
    // count is checked through the carried id rather than the table length.)
    expect(target.domain.table('events').get(carried?.id ?? '')).toEqual(carried)
  })

  it('still restores a legacy v2 snapshot that carries no events', async () => {
    const { domain, service } = await harness()
    // A live ledger the v2 snapshot cannot know about.
    const live = await appendEvent(domain, {
      actor: PANEL_ACTOR,
      action: 'knowledge.claim.set',
      refs: { claimId: 'c1' },
      payload: { status: 'supported' },
    })
    const legacy = {
      format: WIKI_SNAPSHOT_FORMAT,
      version: WIKI_SNAPSHOT_MIN_VERSION,
      exportedAt: '2026-08-20T00:00:00.000Z',
      tables: {
        papers: [PAPER], ideas: [], claims: [], projects: [PROJECT],
        experiments: [EXPERIMENT], servers: [SERVER], figures: [FIGURE],
      },
    } as unknown as ResearchWikiSnapshot

    expect(snapshotEnvelopeError(legacy)).toBeNull()
    const outcome = await service.importWiki({ snapshot: legacy, mode: 'replace', confirmReplace: true })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.value.imported.papers).toBe(1)
    expect(outcome.value.imported.events).toBe(0)
    // A v2 snapshot says nothing about the ledger, so it must not wipe it.
    expect(domain.table('events').get(live.id)).toEqual(live)
  })
})

describe('importWiki validation', () => {
  it('rejects a foreign format', async () => {
    const { service } = await harness()
    const bad = { format: 'other', version: 2 } as unknown as ResearchWikiSnapshot
    const outcome = await service.importWiki({ snapshot: bad, mode: 'merge' })
    expect(outcome).toEqual({ ok: false, error: { code: 'invalid-input', message: 'format must be "mimir-wiki"' } })
  })

  it('rejects a wrong version', async () => {
    const { service } = await harness()
    const snapshot = { format: WIKI_SNAPSHOT_FORMAT, version: 1, exportedAt: 'x', tables: {} } as unknown as ResearchWikiSnapshot
    const outcome = await service.importWiki({ snapshot, mode: 'merge' })
    expect(outcome).toEqual({ ok: false, error: { code: 'invalid-input', message: 'version must be 2 or 3' } })
  })

  it('rejects an unknown mode', async () => {
    const { service } = await harness()
    const outcome = await service.importWiki({ snapshot: {} as ResearchWikiSnapshot, mode: 'append' as 'merge' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.error.code).toBe('invalid-input')
  })

  it('rejects one invalid row before writing anything', async () => {
    const { domain, service } = await harness()
    await seed(domain)
    const snapshot = await exportOk(service)
    const badRow = { ...PAPER, arxivId: '2401.00009', tags: 'not-an-array' }
    const clone: ResearchWikiSnapshot = {
      ...(JSON.parse(JSON.stringify(snapshot)) as ResearchWikiSnapshot),
      tables: { ...snapshot.tables, papers: [badRow as unknown as PaperRecord] },
    }
    const outcome = await service.importWiki({ snapshot: clone, mode: 'merge' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    if (outcome.error.code !== 'invalid-input') throw new Error('unreachable')
    expect(outcome.error.message).toContain('tables.papers[0]')
    // The valid tables in the same snapshot were NOT written.
    expect([...domain.table('ideas').entries()]).toEqual([])
  })
})

describe('wiki-snapshot validators', () => {
  it('rejects malformed envelopes', () => {
    expect(snapshotEnvelopeError(null)).toBe('snapshot must be an object')
    expect(snapshotEnvelopeError({ format: WIKI_SNAPSHOT_FORMAT, version: 2, exportedAt: 'x', tables: { papers: 'x' } }))
      .toBe('tables.papers must be an array')
  })

  it('rejects duplicate primary keys within one table', () => {
    expect(tableRowsError('papers', [PAPER, PAPER])).toContain('duplicates arxivId')
  })

  it('rejects a row missing its primary key', () => {
    expect(tableRowsError('servers', [{ ...SERVER, id: '' }])).toContain('has no id')
  })

  it('accepts a clean table', () => {
    expect(tableRowsError('experiments', [EXPERIMENT])).toBeNull()
  })
})
