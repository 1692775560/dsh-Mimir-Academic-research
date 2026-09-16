/**
 * Regression tests for #215: `srv-` / `exp-` record ids used to be a bare
 * `Date.now()` base-36 timestamp, so two creates landing in the same
 * millisecond shared one id and the second `table.put` silently overwrote
 * the first record. The ids now carry a per-instance monotonic suffix (the
 * job-id pattern), pinned here by freezing the clock across a create burst.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import type { ProjectRecord } from '../src/types.ts'

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Project',
  stage: 'writing',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

const SERVER_INPUT = { name: 'gpu01', host: '127.0.0.1', port: 22, username: 'ops', note: '' }
const EXPERIMENT_INPUT = { projectId: 'p1', name: 'baseline', status: 'running' as const, metrics: {} }

/** Boot a memory-backed domain plus a fresh temp workspace and the service. */
async function harness(): Promise<ResearchService> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  await domain.table('projects').put(PROJECT.id, PROJECT)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-record-ids-'))
  return new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
  })
}

describe('record id generation (#215)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T00:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives same-millisecond server creates distinct suffixed ids', async () => {
    const service = await harness()
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const created = await service.saveServer({ server: SERVER_INPUT })
      if (!created.ok) throw new Error('create failed')
      ids.push(created.value.server.id)
    }
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^srv-[0-9a-z]+-[1-9]\d*$/)
  })

  it('gives same-millisecond experiment creates distinct suffixed ids', async () => {
    const service = await harness()
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const created = await service.saveExperiment({ experiment: EXPERIMENT_INPUT })
      if (!created.ok) throw new Error('create failed')
      ids.push(created.value.experiment.id)
    }
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^exp-[0-9a-z]+-[1-9]\d*$/)
  })

  it('keeps every created record readable under its own id (no overwrite)', async () => {
    const service = await harness()
    for (let i = 0; i < 3; i += 1) {
      const created = await service.saveServer({ server: { ...SERVER_INPUT, name: `gpu0${String(i)}` } })
      if (!created.ok) throw new Error('create failed')
    }
    const listed = await service.listServers()
    if (!listed.ok) throw new Error('list failed')
    expect(listed.value.servers).toHaveLength(3)
  })
})
