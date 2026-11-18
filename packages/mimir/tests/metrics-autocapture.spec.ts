/**
 * Behavior tests for #152's automatic metrics capture: a successful job that
 * declares a `workdir` and a `projectId` seeds an experiment record from
 * `<workdir>/metrics.jsonl`.
 *
 * The three cases the issue names — a normal run, a missing file, a corrupt
 * file — all enter through the same seam (`deps.metrics.read`), because the
 * only difference between them is the text the server would have handed over.
 * The parser itself is covered by `metrics-summary.spec.ts`; what is asserted
 * here is the shell: that capture runs on success and only on success, that it
 * stays fail-open, and that it never creates a second record for a job the user
 * already linked to an experiment.
 */

import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { isActiveJobStatus } from '../src/job-lifecycle.ts'
import { ResearchService } from '../src/service.ts'
import type { ExperimentRecord, JobRecord, ProjectRecord, ServerRecord } from '../src/types.ts'

const SERVER_INPUT = { name: 'gpu01', host: '127.0.0.1', port: 22, username: 'ops', note: '' }

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'metric capture',
  stage: 'experiment',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-09-01T00:00:00.000Z',
}

/** The server record the harness registers; capture reads it back by job. */
const SERVER: ServerRecord = {
  id: 'srv-1',
  name: SERVER_INPUT.name,
  host: SERVER_INPUT.host,
  port: SERVER_INPUT.port,
  username: SERVER_INPUT.username,
  note: SERVER_INPUT.note,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

/** One `metrics.jsonl` line. */
function line(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

/** Boot a service whose metrics read is the supplied stub. */
async function harness(read: (server: ServerRecord, workdir: string) => Promise<string | undefined>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-metrics-'))
  await domain.table('projects').put(PROJECT.id, PROJECT)
  await domain.table('servers').put(SERVER.id, SERVER)
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
    metrics: { read },
  })
  return { domain, service }
}

/**
 * Shim a fake `ssh` onto PATH that exits 0 for every command (#152). The
 * capture tests never want a real session; the job itself just has to settle.
 * @param exitCode - the remote exit status the fake reports.
 */
async function stubFakeSsh(exitCode = 0): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), 'mimir-metrics-ssh-'))
  const script = `#!/bin/bash\nwhile [ $# -gt 1 ]; do shift; done\necho "run: $1"\nexit ${String(exitCode)}\n`
  await writeFile(join(binDir, 'ssh'), script)
  await chmod(join(binDir, 'ssh'), 0o755)
  vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)
}

/** Poll listJobs until one job reaches a terminal status. */
async function settleJob(service: ResearchService, id: string): Promise<JobRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const listed = await service.listJobs({})
    if (listed.ok) {
      const job = listed.value.jobs.find(record => record.id === id)
      if (job !== undefined && !isActiveJobStatus(job.status)) return job
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`job ${id} did not settle`)
}

/** Every experiment record in the wiki, for "did capture write anything" checks. */
function experimentsOf(domain: Awaited<ReturnType<typeof harness>>['domain']): ExperimentRecord[] {
  return [...domain.table('experiments').entries()].map(([, record]) => record)
}

afterEach(() => { vi.unstubAllEnvs() })

describe('automatic metrics capture (#152)', () => {
  it('seeds a draft experiment from a normal metrics.jsonl', async () => {
    await stubFakeSsh()
    const seen: string[] = []
    const { domain, service } = await harness(async (_server, workdir) => {
      seen.push(workdir)
      return [
        line({ step: 1, loss: 2.5, accuracy: 0.61 }),
        line({ step: 2, loss: 1.9, accuracy: 0.70 }),
      ].join('\n')
    })
    const submitted = await service.submitJob({
      serverId: SERVER.id,
      command: 'python train.py',
      projectId: PROJECT.id,
      workdir: '/home/ops/run-1',
    })
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return
    const job = await settleJob(service, submitted.value.job.id)
    expect(job.status).toBe('succeeded')
    // The shell hands the parser the workdir it was given, unchanged.
    expect(seen).toEqual(['/home/ops/run-1'])
    const records = experimentsOf(domain)
    expect(records).toHaveLength(1)
    const draft = records[0] as ExperimentRecord
    expect(draft.draft).toBe(true)
    expect(draft.projectId).toBe(PROJECT.id)
    expect(draft.name).toBe('python train.py')
    expect(draft.status).toBe('success')
    // Last row's values, not the file's final line's.
    expect(draft.metrics).toEqual({ loss: 1.9, accuracy: 0.70 })
    expect(draft.metricDirections).toEqual({ loss: 'min', accuracy: 'max' })
    expect(draft.lastJob?.jobId).toBe(job.id)
  })

  it('creates nothing when the server has no metrics.jsonl (#152 missing case)', async () => {
    await stubFakeSsh()
    const { domain, service } = await harness(() => Promise.resolve(undefined))
    const submitted = await service.submitJob({
      serverId: SERVER.id,
      command: 'python train.py',
      projectId: PROJECT.id,
      workdir: '/home/ops/run-2',
    })
    if (!submitted.ok) throw new Error('submit failed')
    const job = await settleJob(service, submitted.value.job.id)
    expect(job.status).toBe('succeeded')
    expect(experimentsOf(domain)).toHaveLength(0)
  })

  it('creates nothing when metrics.jsonl holds no usable row (#152 corrupt case)', async () => {
    await stubFakeSsh()
    const { domain, service } = await harness(() => Promise.resolve('garbage\n{"step": '))
    const submitted = await service.submitJob({
      serverId: SERVER.id,
      command: 'python train.py',
      projectId: PROJECT.id,
      workdir: '/home/ops/run-3',
    })
    if (!submitted.ok) throw new Error('submit failed')
    const job = await settleJob(service, submitted.value.job.id)
    expect(job.status).toBe('succeeded')
    expect(experimentsOf(domain)).toHaveLength(0)
  })

  it('stays fail-open when the read itself throws', async () => {
    await stubFakeSsh()
    const { domain, service } = await harness(() => Promise.reject(new Error('ssh died')))
    const submitted = await service.submitJob({
      serverId: SERVER.id,
      command: 'python train.py',
      projectId: PROJECT.id,
      workdir: '/home/ops/run-4',
    })
    if (!submitted.ok) throw new Error('submit failed')
    const job = await settleJob(service, submitted.value.job.id)
    // A broken capture never turns a successful run into a failed one.
    expect(job.status).toBe('succeeded')
    expect(experimentsOf(domain)).toHaveLength(0)
  })

  it('does not read metrics for a failed job', async () => {
    await stubFakeSsh(3)
    let reads = 0
    const { domain, service } = await harness(() => {
      reads += 1
      return Promise.resolve(line({ step: 1, loss: 1 }))
    })
    const submitted = await service.submitJob({
      serverId: SERVER.id,
      command: 'python train.py',
      projectId: PROJECT.id,
      workdir: '/home/ops/run-5',
    })
    if (!submitted.ok) throw new Error('submit failed')
    const job = await settleJob(service, submitted.value.job.id)
    expect(job.status).toBe('failed')
    expect(reads).toBe(0)
    expect(experimentsOf(domain)).toHaveLength(0)
  })

  it('does not read metrics when the job declares no workdir', async () => {
    await stubFakeSsh()
    let reads = 0
    const { domain, service } = await harness(() => {
      reads += 1
      return Promise.resolve(line({ step: 1, loss: 1 }))
    })
    const submitted = await service.submitJob({
      serverId: SERVER.id,
      command: 'python train.py',
      projectId: PROJECT.id,
    })
    if (!submitted.ok) throw new Error('submit failed')
    await settleJob(service, submitted.value.job.id)
    expect(reads).toBe(0)
    expect(experimentsOf(domain)).toHaveLength(0)
  })

  it('merges into the linked experiment instead of creating a second record', async () => {
    await stubFakeSsh()
    const target: ExperimentRecord = {
      id: 'exp-linked',
      projectId: PROJECT.id,
      name: 'hand-written baseline',
      status: 'running',
      metrics: { note: 'kept' },
      updatedAt: '2026-09-01T00:00:00.000Z',
    }
    const { domain, service } = await harness(() => Promise.resolve(line({ step: 7, val_loss: 0.4 })))
    await domain.table('experiments').put(target.id, target)
    const submitted = await service.submitJob({
      serverId: SERVER.id,
      command: 'python train.py',
      projectId: PROJECT.id,
      experimentId: target.id,
      workdir: '/home/ops/run-6',
    })
    if (!submitted.ok) throw new Error('submit failed')
    await settleJob(service, submitted.value.job.id)
    const records = experimentsOf(domain)
    expect(records).toHaveLength(1)
    const merged = records[0] as ExperimentRecord
    expect(merged.id).toBe(target.id)
    // Hand-written metrics survive; the machine's land beside them.
    expect(merged.metrics).toEqual({ note: 'kept', val_loss: 0.4 })
    expect(merged.metricDirections).toEqual({ val_loss: 'min' })
    expect(merged.draft).toBeUndefined()
  })

  it('rejects a workdir ssh would have to interpret', async () => {
    await stubFakeSsh()
    const { service } = await harness(() => Promise.resolve(undefined))
    const reject = async (workdir: string): Promise<string> => {
      const result = await service.submitJob({
        serverId: SERVER.id, command: 'python train.py', projectId: PROJECT.id, workdir,
      })
      expect(result.ok, workdir).toBe(false)
      return result.ok ? '' : result.error.message
    }
    expect(await reject('run-1')).toContain('absolute')
    expect(await reject('/home/ops/../../etc')).toContain('..')
    expect(await reject('/home/ops/run; rm -rf /')).toContain('may only use')
    expect(await reject(`/home/ops/it's`)).toContain('may only use')
    expect(await reject(`/home/ops/${'a'.repeat(1100)}`)).toContain('at most')
  })

  it('rejects a project the wiki does not have', async () => {
    await stubFakeSsh()
    const { service } = await harness(() => Promise.resolve(undefined))
    const result = await service.submitJob({
      serverId: SERVER.id, command: 'python train.py', projectId: 'nope', workdir: '/home/ops/run',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('project-not-found')
  })

  it('drops the draft when the project was deleted while the job ran', async () => {
    await stubFakeSsh()
    let reads = 0
    const { domain, service } = await harness(() => {
      reads += 1
      return Promise.resolve(line({ step: 1, loss: 1 }))
    })
    const submitted = await service.submitJob({
      serverId: SERVER.id,
      command: 'python train.py',
      projectId: PROJECT.id,
      workdir: '/home/ops/run-7',
    })
    if (!submitted.ok) throw new Error('submit failed')
    // The project goes away between submit and settle (the delete unlinks the
    // stored job, but the settle reads the in-memory record).
    await domain.table('projects').delete(PROJECT.id)
    const job = await settleJob(service, submitted.value.job.id)
    expect(job.status).toBe('succeeded')
    // The capture never even reads the file once the project is gone.
    expect(reads).toBe(0)
    expect(experimentsOf(domain)).toHaveLength(0)
  })
})
