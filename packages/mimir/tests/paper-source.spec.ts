/**
 * Behavior tests for the paper-source file operations: snapshot reads with
 * their mtime, optimistic-concurrency saves (success, conflict, missing),
 * and the atomic commit preserving content and permission bits.
 */

import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPaperSource, resolvePaperDir, resolvePaperDirReal, savePaperSourceFile } from '../src/paper-source.ts'

describe('resolvePaperDir', () => {
  const root = join(tmpdir(), 'research-ws')

  it('falls back to the default paper directory', () => {
    expect(resolvePaperDir(root)).toBe(join(root, 'paper'))
  })

  it('prefers the project record paperDir over the default', () => {
    expect(resolvePaperDir(root, undefined, 'ego-wholebody-paper'))
      .toBe(join(root, 'ego-wholebody-paper'))
  })

  it('prefers an explicit request dir over the project record', () => {
    expect(resolvePaperDir(root, 'other-paper', 'ego-wholebody-paper'))
      .toBe(join(root, 'other-paper'))
  })

  it('rejects a .. escape and an absolute path', () => {
    expect(resolvePaperDir(root, '../outside')).toBeUndefined()
    expect(resolvePaperDir(root, 'a/../../outside')).toBeUndefined()
    expect(resolvePaperDir(root, '/etc/passwd')).toBeUndefined()
    expect(resolvePaperDir(root, undefined, '../../outside')).toBeUndefined()
  })

  it('rejects an empty candidate', () => {
    expect(resolvePaperDir(root, '')).toBeUndefined()
    expect(resolvePaperDir(root, '   ')).toBeUndefined()
  })
})

describe('resolvePaperDirReal (#213)', () => {
  let workspace: string
  let outside: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'mimir-realpath-ws-'))
    outside = await mkdtemp(join(tmpdir(), 'mimir-realpath-out-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('resolves a real in-workspace directory', async () => {
    await mkdir(join(workspace, 'paper'))
    expect(await resolvePaperDirReal(workspace, undefined, 'paper')).toBe(join(workspace, 'paper'))
  })

  it('rejects a symlinked directory escaping the workspace', async () => {
    // Lexically 'paper' is fine, but workspace/paper → outside must fail.
    await symlink(outside, join(workspace, 'paper'), 'dir')
    expect(await resolvePaperDirReal(workspace, undefined, 'paper')).toBeUndefined()
  })

  it('accepts a symlink staying inside the workspace', async () => {
    await mkdir(join(workspace, 'real-paper'))
    await symlink(join(workspace, 'real-paper'), join(workspace, 'paper'), 'dir')
    expect(await resolvePaperDirReal(workspace, undefined, 'paper')).toBe(join(workspace, 'paper'))
  })

  it('accepts a directory that does not exist yet when the parent chain is clean', async () => {
    expect(await resolvePaperDirReal(workspace, undefined, 'fresh-paper')).toBe(join(workspace, 'fresh-paper'))
  })

  it('still rejects lexical escapes', async () => {
    expect(await resolvePaperDirReal(workspace, '../outside')).toBeUndefined()
    expect(await resolvePaperDirReal(workspace, '/etc')).toBeUndefined()
  })
})

describe('paper-source', () => {
  let dir: string
  let texPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'research-paper-source-'))
    texPath = join(dir, 'main.tex')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('readPaperSource', () => {
    it('returns undefined when the file does not exist', async () => {
      expect(await readPaperSource(texPath)).toBeUndefined()
    })

    it('returns the content with the mtime it was read from', async () => {
      await writeFile(texPath, '\\documentclass{article}\n', 'utf8')
      const snapshot = await readPaperSource(texPath)
      expect(snapshot?.content).toBe('\\documentclass{article}\n')
      expect(snapshot?.mtimeMs).toBe((await stat(texPath)).mtimeMs)
    })
  })

  describe('read/save coherence (R01)', () => {
    it('never pairs new content with a stale mtime while a save is mid-commit', async () => {
      await writeFile(texPath, 'v1\n', 'utf8')
      // Rewrite under a pinned timestamp on the SAME inode: with a coarse
      // clock (ms resolution on WSL2/ext4) two writes can share one mtime,
      // so the file can change while its mtime does not. A lock-free reader
      // could then read the new content but carry the old mtime as its base
      // — a base that wrongly passes the optimistic check and overwrites.
      const stamp = new Date(1_700_000_000_000)
      await utimes(texPath, stamp, stamp)
      const staleBase = (await stat(texPath)).mtimeMs
      await writeFile(texPath, 'v2\n', 'utf8')
      const snapshot = await readPaperSource(texPath)
      // The read+stat both happened under the writer lock, so the snapshot
      // is coherent: it reports the content it actually read. If the read
      // had been lock-free it could carry `staleBase` while returning v2.
      expect(snapshot?.content).toBe('v2\n')
      expect(snapshot?.mtimeMs).toBe((await stat(texPath)).mtimeMs)
      // The reported base must NOT accept a save of stale content over v2.
      expect(snapshot?.mtimeMs).not.toBe(staleBase)
      const staleSave = await savePaperSourceFile(texPath, 'stale draft\n', staleBase)
      expect(staleSave).toEqual({ kind: 'conflict', currentMtimeMs: snapshot?.mtimeMs })
      expect(await readFile(texPath, 'utf8')).toBe('v2\n')
    })
  })

  describe('savePaperSourceFile', () => {
    it('reports missing when the file does not exist', async () => {
      expect(await savePaperSourceFile(texPath, 'x', 0)).toEqual({ kind: 'missing' })
    })

    it('commits the content and returns the new mtime when the base matches', async () => {
      await writeFile(texPath, 'before\n', 'utf8')
      const base = (await stat(texPath)).mtimeMs
      const outcome = await savePaperSourceFile(texPath, 'after\n', base)
      expect(outcome.kind).toBe('saved')
      expect(await readFile(texPath, 'utf8')).toBe('after\n')
      expect((await stat(texPath)).mtimeMs).toBe((outcome as { mtimeMs: number }).mtimeMs)
    })

    it('reports a conflict and leaves the file untouched when the mtime moved', async () => {
      await writeFile(texPath, 'v1\n', 'utf8')
      const base = (await stat(texPath)).mtimeMs
      // A third party (the agent's file tools) lands a change the draft never
      // saw. The mtime is moved EXPLICITLY: on filesystems with coarse mtime
      // granularity (or pinned timestamps, as in some sandboxes) two quick
      // writes can share one mtime and the conflict would be unobservable.
      await writeFile(texPath, 'v2\n', 'utf8')
      const displacedAt = new Date(base + 10_000)
      await utimes(texPath, displacedAt, displacedAt)
      const displaced = (await stat(texPath)).mtimeMs
      expect(displaced).not.toBe(base)
      const outcome = await savePaperSourceFile(texPath, 'stale draft\n', base)
      expect(outcome).toEqual({ kind: 'conflict', currentMtimeMs: displaced })
      expect(await readFile(texPath, 'utf8')).toBe('v2\n')
    })

    it('accepts a follow-up save based on the mtime a conflict reported', async () => {
      await writeFile(texPath, 'v1\n', 'utf8')
      const first = await savePaperSourceFile(texPath, 'v2\n', (await stat(texPath)).mtimeMs)
      expect(first.kind).toBe('saved')
      const second = await savePaperSourceFile(
        texPath, 'v3\n', (first as { mtimeMs: number }).mtimeMs,
      )
      expect(second.kind).toBe('saved')
      expect(await readFile(texPath, 'utf8')).toBe('v3\n')
    })
  })
})
