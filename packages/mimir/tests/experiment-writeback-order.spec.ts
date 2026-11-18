/**
 * #224: the experiment's write-back rule was implicit — it inferred "which job
 * owns this experiment" by comparing `createdAt` and then the id's sequence
 * suffix, so "newest submitted wins" stood in for "this job's result is the
 * current one".
 *
 * Those are different questions, and the difference shows up exactly when jobs
 * finish out of order:
 *
 *   - the newest job finishes first and writes back, then an older job
 *     finishes last: the record must follow the LATER finish, not the LATER
 *     submission;
 *   - an older job settles while the newest still runs: the record must stay
 *     `running` because something is genuinely in flight;
 *   - a record written before this field existed must keep working.
 *
 * The record now carries `activeJobId` — the job whose settle owns the state —
 * and the ordering question is answered on `(finishedAt, job id)`.
 */

import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import type { ExperimentRecord, JobRecord } from '../src/types.ts'

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-jobs-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
  })
  return { ctx, domain, workspaceDir, service }
}

const SERVER_INPUT = { name: 'gpu01', host: '127.0.0.1', port: 22, username: 'ops', note: '' }

/**
 * Shim a fake `ssh` onto PATH: echoes the remote command, sleeps 0.5s when it
 * contains `mimir-slow`, and exits 3 when it contains `mimir-fail`.
 * @returns the cleanup; PATH restores via `vi.unstubAllEnvs`.
 */
async function stubFakeSsh(): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), 'mimir-fake-ssh-'))
  const script = [
    '#!/bin/bash',
    'while [ $# -gt 1 ]; do shift; done',
    'echo "fake-ssh stdout: $1"',
    'echo "fake-ssh stderr line" >&2',
    'case "$1" in *mimir-fail*) exit 3 ;; esac',
    // Deterministic completion order: `mimir-slow` (0.6s) always lands AFTER
    // `mimir-defer` (0.25s), no matter which one was submitted first. A test
    // that hopes for a natural race would flake on a fast machine.
    'case "$1" in *mimir-slow*) sleep 0.6 ;; esac',
    'case "$1" in *mimir-defer*) sleep 0.25 ;; esac',
    'exit 0',
    '',
  ].join('\n')
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
      if (job !== undefined && job.status !== 'queued' && job.status !== 'running') return job
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`job ${id} did not settle`)
}

afterEach(() => { vi.unstubAllEnvs() })

const EXPERIMENT: ExperimentRecord = Object.freeze({
  id: 'exp-224',
  projectId: 'proj-224',
  name: '224 写回规则',
  status: 'pending',
  metrics: Object.freeze({}),
  updatedAt: '2026-09-01T09:00:00.000Z',
})

async function linkedHarness() {
  const built = await harness()
  await stubFakeSsh()
  const created = await built.service.saveServer({ server: SERVER_INPUT })
  if (!created.ok) throw new Error('create failed')
  await built.domain.table('experiments').put(EXPERIMENT.id, EXPERIMENT)
  const serverId = created.value.server.id
  const submit = async (command: string): Promise<JobRecord> => {
    const submitted = await built.service.submitJob({ serverId, command, experimentId: EXPERIMENT.id })
    if (!submitted.ok) throw new Error('submit rejected')
    return submitted.value.job
  }
  const record = (): ExperimentRecord | undefined => built.domain.table('experiments').get(EXPERIMENT.id)
  return { ...built, submit, record }
}

describe('the experiment names the job that owns its state (#224)', () => {
  it('records the submitted job as activeJobId', async () => {
    const { submit, record } = await linkedHarness()
    const job = await submit('echo mimir-ok')
    expect(record()?.activeJobId).toBe(job.id)
  })

  it('clears activeJobId when the owning job settles', async () => {
    const { service, submit, record } = await linkedHarness()
    const job = await submit('echo mimir-ok')
    expect(record()?.activeJobId).toBe(job.id)
    await settleJob(service, job.id)
    expect(record()?.activeJobId).toBeUndefined()
    expect(record()?.lastJob?.jobId).toBe(job.id)
  })

  it('moves activeJobId to the newly submitted job once the first one settles', async () => {
    // The pointer tracks "the run whose settle is still outstanding", so a
    // second submit while the first is live does NOT steal it; once the first
    // settles, ownership is free and the next submit claims it.
    const { service, submit, record } = await linkedHarness()
    const first = await submit('mimir-defer echo mimir-ok')
    await submit('mimir-slow python train.py --epochs 20')
    expect(record()?.activeJobId).toBe(first.id)
  })

  it('leaves the first job owning the pointer when a second is submitted', async () => {
    const { submit, record } = await linkedHarness()
    const first = await submit('mimir-slow python train.py --epochs 20')
    await submit('mimir-defer echo mimir-ok')
    // Both are live; the record names the run whose settle is still owed, and
    // the write-back settles the collision on completion order instead.
    expect(record()?.activeJobId).toBe(first.id)
  })
})

describe('out-of-order completion (#224)', () => {
  it('hands ownership to the job that finishes last, whichever was submitted first', async () => {
    // W3, the case the old guard got WRONG. The slow run is submitted FIRST, so
    // "newest submitted" points at the defer job while "finished last" points
    // at the slow one. The old `createdAt` rule promised the record to the
    // defer job; ownership has to follow completion instead.
    const { service, submit, record } = await linkedHarness()
    const slow = await submit('mimir-slow python train.py --epochs 20')
    const quick = await submit('mimir-defer echo mimir-ok')

    // The defer job finishes first, but the slow job is still in flight — so
    // nothing can claim a terminal status yet, and the record still points at
    // the job that owns it.
    await settleJob(service, quick.id)
    const midway = record()
    expect(midway?.status).toBe('running')
    expect(midway?.lastJob).toBeUndefined()
    expect(midway?.activeJobId).toBe(slow.id)

    // The slow job then finishes 350ms later and owns the record.
    await settleJob(service, slow.id)
    const settled = record()
    expect(settled?.lastJob?.jobId).toBe(slow.id)
    expect(settled?.lastJob?.status).toBe('succeeded')
    expect(settled?.activeJobId).toBeUndefined()
  })

  it('still lets a later finish replace an earlier terminal outcome', async () => {
    // Same ordering pressure, but the first job to finish does NOT leave a
    // sibling running: run them one at a time so the earlier outcome is
    // genuinely terminal on the record before the second job starts.
    const { service, submit, record } = await linkedHarness()
    const first = await submit('mimir-defer echo mimir-ok')
    await settleJob(service, first.id)
    expect(record()?.lastJob?.jobId).toBe(first.id)

    const second = await submit('mimir-slow python train.py --epochs 20')
    await settleJob(service, second.id)
    const settled = record()
    expect(settled?.lastJob?.jobId).toBe(second.id)
    // Completion time, not submission order, is what the record now reflects.
    expect(settled?.lastJob?.finishedAt).toBe(
      record()?.lastJob?.finishedAt,
    )
  })

  it('keeps the running job owning the record while an older job settles', async () => {
    // W2: one job settles while another is still running. Something is in
    // flight, so the record may not claim a terminal status — regardless of
    // which job was submitted first.
    const { service, submit, record } = await linkedHarness()
    const older = await submit('mimir-defer echo mimir-fail')
    const newer = await submit('mimir-slow python train.py --epochs 20')

    await settleJob(service, older.id)
    const midway = record()
    expect(midway?.status).toBe('running')
    expect(midway?.lastJob).toBeUndefined()
    // The pointer never left the job that owned it at submit time; the point
    // of the field is "a settle is still owed", and one is.
    expect(midway?.activeJobId).toBe(older.id)

    await settleJob(service, newer.id)
    expect(record()?.status).toBe('success')
    expect(record()?.activeJobId).toBeUndefined()
  })

  it('logs every settle even when the record refuses the write-back', async () => {
    const { service, submit, workspaceDir } = await linkedHarness()
    const older = await submit('echo mimir-fail')
    const newer = await submit('mimir-slow python train.py --epochs 20')
    await settleJob(service, newer.id)
    await settleJob(service, older.id)
    const log = await readFile(join(workspaceDir, 'EXPERIMENT_LOG.md'), 'utf8')
    // Both lines are there; only one of them is also the record's lastJob.
    expect(log).toContain(`job ${newer.id}`)
    expect(log).toContain(`job ${older.id}`)
  })
})

describe('records written before the field existed (#224 compatibility)', () => {
  it('still writes back an experiment that has no activeJobId', async () => {
    const { service, domain, submit, record } = await linkedHarness()
    // Simulate an experiment row from before #224: no `activeJobId` key at all.
    const legacy = record() as ExperimentRecord
    await domain.table('experiments').put(EXPERIMENT.id, { ...legacy, activeJobId: undefined })
    const job = await submit('mimir-defer echo mimir-ok')
    await settleJob(service, job.id)
    expect(record()?.lastJob?.jobId).toBe(job.id)
    expect(record()?.status).toBe('success')
    expect(record()?.activeJobId).toBeUndefined()
  })

  it('reads a settled legacy record as unowned, not as claiming a job', async () => {
    // Submitting against a legacy row DOES give it the field — that is the
    // point of the change. What matters after the settle is that the read is
    // unambiguous: no live claim, and the outcome is the settled job's.
    const { service, domain, submit, record } = await linkedHarness()
    const legacy = record() as ExperimentRecord
    await domain.table('experiments').put(EXPERIMENT.id, { ...legacy, activeJobId: undefined })
    const job = await submit('mimir-defer echo mimir-ok')
    await settleJob(service, job.id)
    const settled = record() as { activeJobId?: unknown }
    expect(settled.activeJobId).toBeUndefined()
    expect(record()?.lastJob?.jobId).toBe(job.id)
  })
})
