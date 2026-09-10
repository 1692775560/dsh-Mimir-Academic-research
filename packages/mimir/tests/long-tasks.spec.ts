/**
 * Behavior tests for the long-task cancellation contract (#247): compiles
 * and meeting-deck generations register in the service's long-task registry
 * through `linkLongTask`, so the panel's cancel AND the host's dispose share
 * one abort path instead of each task growing its own. Covers the registry
 * unit rules, a dispose mid-compile, and a dispose mid-deck-generation.
 * Real memory-backed domain, real temp workspace, a fake latexmk — no mocks.
 */

import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
  abortLongTasks,
  linkLongTask,
  type ServiceState,
} from '../src/services/common.ts'
import type { PaperRecord, ProjectRecord } from '../src/types.ts'

/** A fresh mutable service state, same shape the service constructor builds. */
function freshState(): ServiceState {
  return {
    compileStatus: new Map(),
    jobSeq: 0,
    jobAborts: new Map(),
    jobStopStatus: new Map(),
    longTasks: new Set(),
  }
}

describe('linkLongTask', () => {
  it('propagates the caller abort into the linked signal', () => {
    const state = freshState()
    const caller = new AbortController()
    const task = linkLongTask(state, caller.signal)
    expect(state.longTasks.size).toBe(1)
    caller.abort()
    expect(task.signal.aborted).toBe(true)
    task.done()
    expect(state.longTasks.size).toBe(0)
  })

  it('starts aborted when the caller signal already is', () => {
    const state = freshState()
    const task = linkLongTask(state, AbortSignal.abort())
    expect(task.signal.aborted).toBe(true)
    task.done()
  })

  it('stops listening to the caller once done (a late caller abort is inert)', () => {
    const state = freshState()
    const caller = new AbortController()
    const task = linkLongTask(state, caller.signal)
    task.done()
    caller.abort()
    expect(task.signal.aborted).toBe(false)
    // done() is idempotent.
    task.done()
  })

  it('aborts every registered task on dispose and clears the registry', () => {
    const state = freshState()
    const first = linkLongTask(state, new AbortController().signal)
    const second = linkLongTask(state) // no caller signal: dispose still reaches it
    abortLongTasks(state)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(state.longTasks.size).toBe(0)
    // A settle after dispose finds an empty registry — harmless.
    first.done()
    second.done()
  })
})

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function harness(engine: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-long-tasks-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine, timeoutMs: 30_000 },
    // No network in tests: the PDF warm-up seam is a slow no-op so the deck
    // generation is still in flight when the dispose lands.
    meetings: { fetchPdf: async () => { await new Promise(resolve => setTimeout(resolve, 300)) } },
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

/** One library paper linked to the project. */
function paperOf(arxivId: string): PaperRecord {
  return {
    arxivId,
    title: `Paper ${arxivId}`,
    authors: ['Alice'],
    summary: 'A summary long enough to be a fallback bullet.',
    url: `https://arxiv.org/abs/${arxivId}`,
    notes: '',
    tags: [],
    projectIds: ['p1'],
    addedAt: '2026-08-19T00:00:00.000Z',
  }
}

const MAIN_TEX = '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n'

/** Write a fake latexmk that sleeps instead of compiling (abort-visible). */
async function slowLatexmk(dir: string): Promise<string> {
  const binDir = join(dir, 'bin')
  await mkdir(binDir, { recursive: true })
  const executable = join(binDir, 'latexmk')
  await writeFile(executable, '#!/bin/sh\nsleep 30\n', 'utf8')
  await chmod(executable, 0o755)
  return executable
}

describe('long-task cancellation through the service (#247)', () => {
  let workspaceDir: string

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('aborts an in-flight compile when the host service is disposed', async () => {
    const engine = await slowLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')))
    const env = await harness(engine)
    workspaceDir = env.workspaceDir
    await env.domain.table('projects').put(PROJECT.id, PROJECT)
    await mkdir(join(workspaceDir, 'paper'), { recursive: true })
    await writeFile(join(workspaceDir, 'paper', 'main.tex'), MAIN_TEX, 'utf8')

    const compiling = env.service.compile({ projectId: 'p1' }, new AbortController().signal)
    // Let the engine process spawn before the dispose lands.
    await new Promise(resolve => setTimeout(resolve, 150))
    await env.ctx.fiber.dispose()

    const settled = await compiling
    expect(settled).toMatchObject({
      ok: false,
      error: { code: 'operation-failed', message: expect.stringContaining('cancelled') },
    })
    // The settle still recorded an observed terminal status.
    const status = await env.service.getCompileStatus({ projectId: 'p1' })
    expect(status).toMatchObject({ ok: true, value: { state: 'error', observed: true } })
  })

  it('aborts an in-flight compile when the caller cancels', async () => {
    const engine = await slowLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')))
    const env = await harness(engine)
    workspaceDir = env.workspaceDir
    await env.domain.table('projects').put(PROJECT.id, PROJECT)
    await mkdir(join(workspaceDir, 'paper'), { recursive: true })
    await writeFile(join(workspaceDir, 'paper', 'main.tex'), MAIN_TEX, 'utf8')

    const caller = new AbortController()
    const compiling = env.service.compile({ projectId: 'p1' }, caller.signal)
    await new Promise(resolve => setTimeout(resolve, 150))
    caller.abort()

    const settled = await compiling
    expect(settled.ok).toBe(false)
    if (!settled.ok) expect(settled.error.message).toContain('cancelled')
  })

  it('aborts an in-flight deck generation when the host service is disposed', async () => {
    const engine = await slowLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')))
    const env = await harness(engine)
    workspaceDir = env.workspaceDir
    await env.domain.table('projects').put(PROJECT.id, PROJECT)
    await env.domain.table('papers').put('a1', paperOf('2103.00020'))
    await env.domain.table('papers').put('a2', paperOf('2103.00021'))

    const generating = env.service.generateMeetingDeck({ projectId: 'p1' }, new AbortController().signal)
    // The first paper's slow warm-up is in flight; the dispose must reach the
    // second loop iteration's throwIfAborted.
    await new Promise(resolve => setTimeout(resolve, 150))
    await env.ctx.fiber.dispose()

    await expect(generating).rejects.toThrow(/abort/i)
  })
})
