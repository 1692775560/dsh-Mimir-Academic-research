/**
 * Behavior tests for the paper snapshots: file-level capture/list/read/prune
 * (relative paths preserved, the 50-snapshot trim, manifest tamper checks),
 * the post-compile automatic capture (success captures, failure does not),
 * and the Remote surface — listing, reading, and reverting under
 * `savePaperSource`'s optimistic-concurrency semantics, with path-escape
 * guards on both the project id and the snapshot id. Real memory-backed
 * domain, real temp workspace, a fake latexmk executable — no mocks.
 */

import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import {
  capturePaperSnapshot, isValidSnapshotId, PAPER_SNAPSHOT_LIMIT, readPaperSnapshot,
  resolveSnapshotsRoot,
} from '../src/paper-snapshots.ts'
import type { ProjectRecord } from '../src/types.ts'

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function harness(engine: string, existingWorkspace?: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = existingWorkspace ?? await mkdtemp(join(tmpdir(), 'mimir-snapshots-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine, timeoutMs: 5000 },
  })
  return { ctx, domain, workspaceDir, service }
}

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Project',
  stage: 'writing',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

const MAIN_TEX = '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n'
const INTRO_TEX = '\\section{Intro}\n'
const REFERENCES_BIB = '@misc{doe2024, title={Paper}}\n'

/** Scaffold the default paper directory with a nested tex tree and a bib. */
async function scaffoldPaper(workspaceDir: string): Promise<void> {
  await mkdir(join(workspaceDir, 'paper', 'sections'), { recursive: true })
  await writeFile(join(workspaceDir, 'paper', 'main.tex'), MAIN_TEX, 'utf8')
  await writeFile(join(workspaceDir, 'paper', 'sections', 'intro.tex'), INTRO_TEX, 'utf8')
  await writeFile(join(workspaceDir, 'paper', 'references.bib'), REFERENCES_BIB, 'utf8')
  await writeFile(join(workspaceDir, 'paper', 'plot.png'), Buffer.from([0x89, 0x50]))
}

/**
 * Write a fake latexmk executable: the success variant "produces" main.pdf
 * and exits 0; the failure variant exits 1.
 */
async function fakeLatexmk(dir: string, succeed: boolean): Promise<string> {
  const binDir = join(dir, 'bin')
  await mkdir(binDir, { recursive: true })
  const executable = join(binDir, 'latexmk')
  const script = succeed
    ? '#!/bin/sh\nprintf %s fake-pdf > main.pdf\nexit 0\n'
    : '#!/bin/sh\necho "compilation failed"\nexit 1\n'
  await writeFile(executable, script, 'utf8')
  await chmod(executable, 0o755)
  return executable
}

/** Distinct capture instants a second apart, for deterministic id ordering. */
function captureTime(index: number): Date {
  return new Date(Date.UTC(2026, 0, 1) + index * 1000)
}

describe('paper snapshot guards', () => {
  it('accepts the compact timestamp id shape only', () => {
    expect(isValidSnapshotId('20260823T063755939Z')).toBe(true)
    expect(isValidSnapshotId('20260823T063755939Z-2')).toBe(true)
    expect(isValidSnapshotId('../../etc')).toBe(false)
    expect(isValidSnapshotId('20260823T063755939Z/../../x')).toBe(false)
    expect(isValidSnapshotId('')).toBe(false)
    expect(isValidSnapshotId('manifest.json')).toBe(false)
  })

  it('contains the snapshots root against project-id escapes', () => {
    const workspace = join(tmpdir(), 'research-ws')
    expect(resolveSnapshotsRoot(workspace, 'p1')).toBe(join(workspace, 'snapshots', 'p1'))
    expect(resolveSnapshotsRoot(workspace, '..')).toBeUndefined()
    expect(resolveSnapshotsRoot(workspace, '../outside')).toBeUndefined()
    expect(resolveSnapshotsRoot(workspace, 'a/b')).toBe(join(workspace, 'snapshots', 'a', 'b'))
    expect(resolveSnapshotsRoot(workspace, '/etc')).toBeUndefined()
  })
})

describe('capturePaperSnapshot', () => {
  let dir: string

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('captures the tex/bib tree with relative paths and a manifest', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mimir-snap-capture-'))
    await scaffoldPaper(dir)
    const root = join(dir, 'snapshots', 'p1')
    const manifest = await capturePaperSnapshot(root, join(dir, 'paper'), captureTime(0))
    expect(manifest).not.toBeUndefined()
    expect(manifest?.files.map(file => file.path)).toEqual(['main.tex', 'references.bib', 'sections/intro.tex'])
    expect(manifest?.createdAt).toBe(captureTime(0).toISOString())
    const snapshotDir = join(root, manifest?.id ?? '')
    expect(await readFile(join(snapshotDir, 'main.tex'), 'utf8')).toBe(MAIN_TEX)
    expect(await readFile(join(snapshotDir, 'sections', 'intro.tex'), 'utf8')).toBe(INTRO_TEX)
    // Non-source files are never captured.
    await expect(stat(join(snapshotDir, 'plot.png'))).rejects.toMatchObject({ code: 'ENOENT' })
    // The manifest round-trips through the reader.
    const snapshot = await readPaperSnapshot(root, manifest?.id ?? '')
    expect(snapshot?.files).toEqual([
      { path: 'main.tex', content: MAIN_TEX },
      { path: 'references.bib', content: REFERENCES_BIB },
      { path: 'sections/intro.tex', content: INTRO_TEX },
    ])
  })

  it('returns undefined for an absent paper directory or one without sources', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mimir-snap-empty-'))
    const root = join(dir, 'snapshots', 'p1')
    expect(await capturePaperSnapshot(root, join(dir, 'paper'))).toBeUndefined()
    await mkdir(join(dir, 'paper'), { recursive: true })
    await writeFile(join(dir, 'paper', 'plot.png'), Buffer.from([0x89]))
    expect(await capturePaperSnapshot(root, join(dir, 'paper'))).toBeUndefined()
  })

  it('disambiguates same-millisecond captures and prunes to the newest 50', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mimir-snap-prune-'))
    await scaffoldPaper(dir)
    const root = join(dir, 'snapshots', 'p1')
    // Two captures at the same instant get distinct ids.
    const first = await capturePaperSnapshot(root, join(dir, 'paper'), captureTime(0))
    const second = await capturePaperSnapshot(root, join(dir, 'paper'), captureTime(0))
    expect(first?.id).not.toBe(second?.id)
    for (let index = 1; index <= PAPER_SNAPSHOT_LIMIT; index += 1) {
      await capturePaperSnapshot(root, join(dir, 'paper'), captureTime(index))
    }
    const kept = await readdir(root)
    expect(kept).toHaveLength(PAPER_SNAPSHOT_LIMIT)
    // The two oldest (both at instant 0) are gone; the newest survives.
    expect(kept).not.toContain(first?.id)
    expect(kept).not.toContain(second?.id)
    const newestId = captureTime(PAPER_SNAPSHOT_LIMIT).toISOString().replace(/[-:.]/g, '')
    expect(kept).toContain(newestId)
  })

  it('fails closed on a tampered manifest path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mimir-snap-tamper-'))
    await scaffoldPaper(dir)
    const root = join(dir, 'snapshots', 'p1')
    const manifest = await capturePaperSnapshot(root, join(dir, 'paper'), captureTime(0))
    await writeFile(
      join(root, manifest?.id ?? '', 'manifest.json'),
      JSON.stringify({ id: manifest?.id, createdAt: manifest?.createdAt, files: [{ path: '../../escape.tex', sizeBytes: 1 }] }),
      'utf8',
    )
    expect(await readPaperSnapshot(root, manifest?.id ?? '')).toBeUndefined()
    expect(await readPaperSnapshot(root, '../escape')).toBeUndefined()
    expect(await readPaperSnapshot(root, '29990101T000000000Z')).toBeUndefined()
  })
})

describe('ResearchService paper snapshots', () => {
  // These drive a compile through a fake latexmk written as a POSIX shell
  // fixture; Windows cannot exec it (EFTYPE). The compile orchestration is
  // covered on POSIX by these and the latex-engine suites.
  const canFakeLatexmk = process.platform !== 'win32'
  let workspaceDir: string

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it.skipIf(!canFakeLatexmk)('captures a snapshot after a successful compile, never after a failure', async () => {
    const engine = await fakeLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')), true)
    const env = await harness(engine)
    workspaceDir = env.workspaceDir
    await env.domain.table('projects').put(PROJECT.id, PROJECT)
    await scaffoldPaper(workspaceDir)
    const compiled = await env.service.compile({ projectId: 'p1' }, new AbortController().signal)
    expect(compiled.ok && compiled.value.state).toBe('ok')
    const listed = await env.service.listPaperSnapshots({ projectId: 'p1' })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.value.snapshots).toHaveLength(1)
    const view = listed.value.snapshots[0]
    expect(view?.files.map(file => file.path)).toEqual(['main.tex', 'references.bib', 'sections/intro.tex'])
    expect(view?.sizeBytes).toBe(MAIN_TEX.length + REFERENCES_BIB.length + INTRO_TEX.length)
    const snapshot = await env.service.getPaperSnapshot({ projectId: 'p1', id: view?.id ?? '' })
    expect(snapshot.ok && snapshot.value.files.find(file => file.path === 'main.tex')?.content).toBe(MAIN_TEX)

    // A failing compile captures nothing.
    const failEngine = await fakeLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')), false)
    const failing = await harness(failEngine, workspaceDir)
    await failing.domain.table('projects').put(PROJECT.id, PROJECT)
    await writeFile(join(workspaceDir, 'paper', 'main.tex'), `${MAIN_TEX}\\broken\n`, 'utf8')
    const failed = await failing.service.compile({ projectId: 'p1' }, new AbortController().signal)
    expect(failed.ok && failed.value.state).toBe('error')
    const after = await env.service.listPaperSnapshots({ projectId: 'p1' })
    expect(after.ok && after.value.snapshots).toHaveLength(1)
  })

  it.skipIf(!canFakeLatexmk)('reverts a snapshot under optimistic concurrency', async () => {
    const engine = await fakeLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')), true)
    const env = await harness(engine)
    workspaceDir = env.workspaceDir
    await env.domain.table('projects').put(PROJECT.id, PROJECT)
    await scaffoldPaper(workspaceDir)
    await env.service.compile({ projectId: 'p1' }, new AbortController().signal)
    const listed = await env.service.listPaperSnapshots({ projectId: 'p1' })
    const id = listed.ok ? listed.value.snapshots[0]?.id ?? '' : ''

    // The paper moves on: a save lands, and the nested file is replaced.
    const source = await env.service.getPaperSource({ projectId: 'p1' })
    const base = source.ok ? source.value.mtimeMs : 0
    const edited = `${MAIN_TEX}\\section{New}\n`
    const saved = await env.service.savePaperSource({ projectId: 'p1', content: edited, baseMtimeMs: base })
    expect(saved.ok).toBe(true)

    // A stale base reports the mtime that displaced it and writes nothing.
    const conflict = await env.service.revertPaperSnapshot({ projectId: 'p1', id, baseMtimeMs: base })
    expect(conflict).toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(await readFile(join(workspaceDir, 'paper', 'main.tex'), 'utf8')).toBe(edited)

    // The fresh base commits: main.tex and the rest of the snapshot land.
    const current = await env.service.getPaperSource({ projectId: 'p1' })
    const reverted = await env.service.revertPaperSnapshot({
      projectId: 'p1', id, baseMtimeMs: current.ok ? current.value.mtimeMs : 0,
    })
    expect(reverted.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'paper', 'main.tex'), 'utf8')).toBe(MAIN_TEX)
    expect(await readFile(join(workspaceDir, 'paper', 'sections', 'intro.tex'), 'utf8')).toBe(INTRO_TEX)
    // The committed mtime is the next save's base.
    if (reverted.ok) {
      const followUp = await env.service.savePaperSource({
        projectId: 'p1', content: `${MAIN_TEX}% after revert\n`, baseMtimeMs: reverted.value.mtimeMs,
      })
      expect(followUp.ok).toBe(true)
    }
  })

  it.skipIf(!canFakeLatexmk)('recreates a file the snapshot carries but the paper lost', async () => {
    const engine = await fakeLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')), true)
    const env = await harness(engine)
    workspaceDir = env.workspaceDir
    await env.domain.table('projects').put(PROJECT.id, PROJECT)
    await scaffoldPaper(workspaceDir)
    await env.service.compile({ projectId: 'p1' }, new AbortController().signal)
    const listed = await env.service.listPaperSnapshots({ projectId: 'p1' })
    const id = listed.ok ? listed.value.snapshots[0]?.id ?? '' : ''
    await rm(join(workspaceDir, 'paper', 'sections'), { recursive: true })
    const current = await env.service.getPaperSource({ projectId: 'p1' })
    const reverted = await env.service.revertPaperSnapshot({
      projectId: 'p1', id, baseMtimeMs: current.ok ? current.value.mtimeMs : 0,
    })
    expect(reverted.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'paper', 'sections', 'intro.tex'), 'utf8')).toBe(INTRO_TEX)
  })

  it('rejects unknown projects, escaping project ids, and bad snapshot ids', async () => {
    const engine = await fakeLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')), true)
    const env = await harness(engine)
    workspaceDir = env.workspaceDir
    await env.domain.table('projects').put(PROJECT.id, PROJECT)
    // A record whose id would escape the snapshots root.
    await env.domain.table('projects').put('../escape', { ...PROJECT, id: '../escape' })
    await expect(env.service.listPaperSnapshots({ projectId: 'missing' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
    await expect(env.service.listPaperSnapshots({ projectId: '../escape' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(env.service.getPaperSnapshot({ projectId: 'p1', id: '../../etc' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(env.service.getPaperSnapshot({ projectId: 'p1', id: '29990101T000000000Z' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'snapshot-not-found', id: '29990101T000000000Z' } })
    await expect(env.service.revertPaperSnapshot({ projectId: 'p1', id: '29990101T000000000Z', baseMtimeMs: 0 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'snapshot-not-found' } })
  })
})
