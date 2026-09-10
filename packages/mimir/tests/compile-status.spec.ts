/**
 * Behavior tests for compile-status restart semantics (#221): the status map
 * is process-local, so after a restart a project whose `main.pdf` still sits
 * on disk must read as "compiled in a previous session" (`ok`, unobserved)
 * instead of "not compiled", a project without any PDF stays `idle`, and a
 * live compile settles with `observed: true`, overriding the backfill.
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
  const workspaceDir = existingWorkspace ?? await mkdtemp(join(tmpdir(), 'mimir-compile-status-'))
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

/** Write a fake latexmk that "produces" main.pdf and exits 0. */
async function fakeLatexmk(dir: string): Promise<string> {
  const binDir = join(dir, 'bin')
  await mkdir(binDir, { recursive: true })
  const executable = join(binDir, 'latexmk')
  await writeFile(executable, '#!/bin/sh\nprintf %s fake-pdf > main.pdf\nexit 0\n', 'utf8')
  await chmod(executable, 0o755)
  return executable
}

describe('compile status across restarts (#221)', () => {
  let workspaceDir: string

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('reports idle for a project with no PDF and no observed compile', async () => {
    const engine = await fakeLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')))
    const env = await harness(engine)
    workspaceDir = env.workspaceDir
    await env.domain.table('projects').put(PROJECT.id, PROJECT)

    const status = await env.service.getCompileStatus({ projectId: 'p1' })

    expect(status).toMatchObject({
      ok: true,
      value: { state: 'idle', pdfUpdatedAt: null, observed: false },
    })
  })

  it('backfills an unobserved ok view from an on-disk PDF after a restart', async () => {
    const engine = await fakeLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')))
    const first = await harness(engine)
    workspaceDir = first.workspaceDir
    await first.domain.table('projects').put(PROJECT.id, PROJECT)
    await mkdir(join(workspaceDir, 'paper'), { recursive: true })
    await writeFile(join(workspaceDir, 'paper', 'main.pdf'), '%PDF-1.7')
    // Simulate a restart: a fresh service instance over the same workspace
    // starts with an empty process-local status map. The domain is
    // memory-backed per harness, so the project record is re-registered.
    const restarted = await harness(engine, workspaceDir)
    await restarted.domain.table('projects').put(PROJECT.id, PROJECT)

    const status = await restarted.service.getCompileStatus({ projectId: 'p1' })

    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value.state).toBe('ok')
    expect(status.value.observed).toBe(false)
    expect(status.value.pdfUpdatedAt).not.toBeNull()
    // The backfill is cached: a repeated read returns the same view.
    const again = await restarted.service.getCompileStatus({ projectId: 'p1' })
    expect(again.ok && again.value).toEqual(status.value)
  })

  it('marks a compile settled in this process as observed, overriding the backfill', async () => {
    const engine = await fakeLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')))
    const env = await harness(engine)
    workspaceDir = env.workspaceDir
    await env.domain.table('projects').put(PROJECT.id, PROJECT)
    await mkdir(join(workspaceDir, 'paper'), { recursive: true })
    await writeFile(join(workspaceDir, 'paper', 'main.tex'), MAIN_TEX, 'utf8')

    const compiled = await env.service.compile({ projectId: 'p1' }, new AbortController().signal)
    expect(compiled.ok && compiled.value.state).toBe('ok')
    if (compiled.ok) expect(compiled.value.observed).toBe(true)

    const status = await env.service.getCompileStatus({ projectId: 'p1' })
    expect(status).toMatchObject({ ok: true, value: { state: 'ok', observed: true, engine: 'latexmk' } })
  })

  it('still rejects unknown projects without touching the status map', async () => {
    const engine = await fakeLatexmk(await mkdtemp(join(tmpdir(), 'mimir-fake-bin-')))
    const env = await harness(engine)
    workspaceDir = env.workspaceDir
    await expect(env.service.getCompileStatus({ projectId: 'missing' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
  })
})
