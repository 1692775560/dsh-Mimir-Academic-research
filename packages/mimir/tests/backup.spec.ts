/**
 * Behavior tests for the scheduled wiki backup (backup.ts): the UTC filename,
 * the keep-cap pruning rule, one full backup pass against a real temp
 * directory (atomic write, snapshot round-trips through the importWiki
 * validators, oldest files pruned), the loop's first-delay/interval cadence,
 * and the plugin config defaults + boundary validation in index.ts.
 * Memory-backed domain, real filesystem, no mocks.
 */

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec, type ResearchWikiDomain } from '../src/store.ts'
import {
  backupFileName,
  isBackupFileName,
  pruneBackupNames,
  runWikiBackup,
  startWikiBackupLoop,
} from '../src/backup.ts'
import {
  snapshotEnvelopeError, tableRowsError, WIKI_TABLE_NAMES,
} from '../src/wiki-snapshot.ts'
import { apply, Config } from '../src/index.ts'
import type { PaperRecord, ResearchWikiSnapshot } from '../src/types.ts'
import { ResearchService } from '../src/service.ts'

/** A memory-backed wiki domain over a fresh temp workspace. */
async function openDomain(): Promise<{ ctx: Context; domain: ResearchWikiDomain; workspaceDir: string }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-backup-'))
  return { ctx, domain, workspaceDir }
}

const PAPER: PaperRecord = {
  arxivId: '2401.00001',
  title: 'Paper One',
  authors: ['A. One'],
  summary: 'summary',
  url: 'https://arxiv.org/abs/2401.00001',
  notes: '',
  tags: [],
  projectIds: [],
  addedAt: '2026-08-01T00:00:00.000Z',
}

describe('backupFileName', () => {
  it('formats the UTC timestamp, zero-padded, so names sort chronologically', () => {
    const name = backupFileName(new Date('2026-08-21T04:05:09.123Z'))
    expect(name).toBe('mimir-wiki-20260821-040509.json')
    expect(isBackupFileName(name)).toBe(true)
  })

  it('rejects foreign names in the prune filter', () => {
    expect(isBackupFileName('main.tex')).toBe(false)
    expect(isBackupFileName('mimir-wiki-20260821-040509.tmp')).toBe(false)
    expect(isBackupFileName('other-20260821-040509.json')).toBe(false)
  })
})

describe('pruneBackupNames', () => {
  const names = [
    'mimir-wiki-20260821-040000.json',
    'mimir-wiki-20260821-030000.json',
    'mimir-wiki-20260821-020000.json',
  ]

  it('drops the oldest past the cap, keeping the newest ones', () => {
    expect(pruneBackupNames(names, 2)).toEqual(['mimir-wiki-20260821-020000.json'])
    expect(pruneBackupNames(names, 3)).toEqual([])
    expect(pruneBackupNames(names, 1)).toEqual([
      'mimir-wiki-20260821-020000.json',
      'mimir-wiki-20260821-030000.json',
    ])
  })

  it('ignores non-backup files even when over the cap', () => {
    expect(pruneBackupNames([...names, 'keep-me.json', 'notes.txt'], 1)).toHaveLength(2)
  })
})

describe('runWikiBackup', () => {
  it('writes a snapshot that passes the importWiki validators', async () => {
    const { domain, workspaceDir } = await openDomain()
    await domain.table('papers').put(PAPER.arxivId, PAPER)
    const dir = join(workspaceDir, 'backups')
    const filePath = await runWikiBackup(domain, dir, 24, new Date('2026-08-21T12:00:00Z'))
    expect(filePath).toBe(join(dir, 'mimir-wiki-20260821-120000.json'))

    const snapshot = JSON.parse(await readFile(filePath, 'utf8')) as ResearchWikiSnapshot
    expect(snapshotEnvelopeError(snapshot)).toBeNull()
    for (const name of WIKI_TABLE_NAMES) {
      expect(tableRowsError(name, snapshot.tables[name])).toBeNull()
    }
    expect(snapshot.exportedAt).toBe('2026-08-21T12:00:00.000Z')
    expect(snapshot.tables.papers).toHaveLength(1)
    // No temp-file litter from the atomic write.
    expect((await readdir(dir)).filter(n => !isBackupFileName(n))).toEqual([])
  })

  it('prunes the oldest backups past the keep cap', async () => {
    const { domain, workspaceDir } = await openDomain()
    const dir = join(workspaceDir, 'backups')
    await runWikiBackup(domain, dir, 2, new Date('2026-08-21T00:00:01Z'))
    await runWikiBackup(domain, dir, 2, new Date('2026-08-21T00:00:02Z'))
    await runWikiBackup(domain, dir, 2, new Date('2026-08-21T00:00:03Z'))
    expect((await readdir(dir)).sort()).toEqual([
      'mimir-wiki-20260821-000002.json',
      'mimir-wiki-20260821-000003.json',
    ])
  })

  it('keeps foreign files in the directory untouched', async () => {
    const { domain, workspaceDir } = await openDomain()
    const dir = join(workspaceDir, 'backups')
    await runWikiBackup(domain, dir, 1, new Date('2026-08-21T00:00:01Z'))
    await writeFile(join(dir, 'notes.txt'), 'mine')
    await runWikiBackup(domain, dir, 1, new Date('2026-08-21T00:00:02Z'))
    expect((await readdir(dir)).sort()).toEqual([
      'mimir-wiki-20260821-000002.json',
      'notes.txt',
    ])
  })
})

describe('startWikiBackupLoop', () => {
  it('runs the first pass after firstDelayMs, then every intervalMs', async () => {
    const { domain, workspaceDir } = await openDomain()
    const dir = join(workspaceDir, 'backups')
    const stop = startWikiBackupLoop({
      domain, dir, intervalMs: 40, keep: 24, firstDelayMs: 10, onError: () => {},
    })
    try {
      // Race-safe: a pass may be mid atomic-write when readdir runs, so fold
      // the no-temp-litter check into the waitFor condition itself.
      await vi.waitFor(async () => {
        const names = await readdir(dir)
        expect(names.length).toBeGreaterThanOrEqual(2)
        expect(names.every(isBackupFileName)).toBe(true)
      }, { timeout: 5000, interval: 20 })
    } finally {
      stop()
    }
  })

  it('does not overlap an in-flight pass', async () => {
    const calls: Array<() => void> = []
    const runBackup = vi.fn(() => new Promise<string>(resolve => { calls.push(() => resolve('done')) }))
    const dir = await mkdtemp(join(tmpdir(), 'mimir-backup-loop-'))
    const stop = startWikiBackupLoop({
      domain: {} as never, dir, intervalMs: 5, keep: 24, firstDelayMs: 1, onError: () => {}, runBackup,
    })
    try {
      await vi.waitFor(() => { expect(runBackup).toHaveBeenCalledTimes(1) }, { timeout: 5000, interval: 5 })
      await new Promise(resolveTimer => setTimeout(resolveTimer, 30))
      expect(runBackup).toHaveBeenCalledTimes(1)
      calls[0]?.()
      await vi.waitFor(() => { expect(runBackup).toHaveBeenCalledTimes(2) }, { timeout: 5000, interval: 5 })
    } finally {
      stop()
      calls[1]?.()
    }
  })
  it('survives a failing pass and retries next cycle', async () => {
    const { domain, workspaceDir } = await openDomain()
    // A file where the directory should be: mkdir/readdir fail until removed.
    const blocker = join(workspaceDir, 'backups')
    await writeFile(blocker, 'occupied')
    const errors: unknown[] = []
    const stop = startWikiBackupLoop({
      domain, dir: blocker, intervalMs: 30, keep: 24, firstDelayMs: 5,
      onError: (error) => { errors.push(error) },
    })
    try {
      await vi.waitFor(() => { expect(errors.length).toBeGreaterThanOrEqual(1) }, { timeout: 5000, interval: 20 })
      // Still alive after the failure: the loop keeps its cadence.
      await vi.waitFor(() => { expect(errors.length).toBeGreaterThanOrEqual(2) }, { timeout: 5000, interval: 20 })
    } finally {
      stop()
    }
  })

  it('dispose before the first delay cancels the first pass', async () => {
    const { domain, workspaceDir } = await openDomain()
    const dir = join(workspaceDir, 'backups')
    const stop = startWikiBackupLoop({
      domain, dir, intervalMs: 20, keep: 24, firstDelayMs: 60_000, onError: () => {},
    })
    stop()
    await new Promise(resolveTimer => setTimeout(resolveTimer, 100))
    await expect(readdir(dir)).rejects.toThrow()
  })
})

describe('backup config', () => {
  it('defaults to enabled / 60 minutes / keep 24 / backups dir', () => {
    const config = Config({})
    expect(config.backup).toEqual({ enabled: true, intervalMinutes: 60, keep: 24, dir: 'backups' })
  })

  it('rejects non-integer or sub-1 cadence and keep values', () => {
    expect(() => Config({ backup: { intervalMinutes: 0 } })).toThrow()
    expect(() => Config({ backup: { intervalMinutes: 1.5 } })).toThrow()
    expect(() => Config({ backup: { keep: 0 } })).toThrow()
    expect(Config({ backup: { intervalMinutes: 1, keep: 1, dir: 'snapshots', enabled: false } }).backup)
      .toEqual({ enabled: false, intervalMinutes: 1, keep: 1, dir: 'snapshots' })
  })

  it('resolveConfig inside apply() rejects the same bad values without Loader normalization', async () => {
    const ctx = new Context()
    // resolveConfig runs first inside apply(), so the bad value throws before
    // any inject service is touched.
    await expect(apply(ctx, { backup: { intervalMinutes: 0 } })).rejects.toThrow(TypeError)
    await expect(apply(ctx, { backup: { keep: -1 } })).rejects.toThrow(TypeError)
    await expect(apply(ctx, { backup: { dir: '  ' } })).rejects.toThrow(TypeError)
  })
})

describe('listBackups', () => {
  it('reports the knobs plus the on-disk count and newest name', async () => {
    const { ctx, domain, workspaceDir } = await openDomain()
    const dir = join(workspaceDir, 'backups')
    const service = new ResearchService(ctx, {
      workspaceDir, domain, latex: { engine: 'auto', timeoutMs: 1000 },
      backup: { enabled: true, intervalMinutes: 60, keep: 24, dir },
    })
    // Before the first pass: directory absent reads as zero backups.
    const empty = await service.listBackups()
    expect(empty.ok && empty.value.backup).toEqual({
      enabled: true, intervalMinutes: 60, keep: 24, count: 0, latestName: null,
    })
    await runWikiBackup(domain, dir, 24, new Date('2026-08-21T00:00:01Z'))
    await runWikiBackup(domain, dir, 24, new Date('2026-08-21T00:00:02Z'))
    const settled = await service.listBackups()
    expect(settled.ok && settled.value.backup).toEqual({
      enabled: true, intervalMinutes: 60, keep: 24, count: 2,
      latestName: 'mimir-wiki-20260821-000002.json',
    })
  })

  it('reports disabled when the service was built without backup knobs', async () => {
    const { ctx, domain, workspaceDir } = await openDomain()
    const service = new ResearchService(ctx, {
      workspaceDir, domain, latex: { engine: 'auto', timeoutMs: 1000 },
    })
    const result = await service.listBackups()
    expect(result.ok && result.value.backup).toEqual({
      enabled: false, intervalMinutes: 0, keep: 0, count: 0, latestName: null,
    })
  })
})
