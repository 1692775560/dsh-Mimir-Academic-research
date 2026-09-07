/**
 * Behavior tests for the model-callable `server_*` tools: `server_list`,
 * `server_check`, `server_submit_job`, and `server_list_jobs`. The tools are
 * thin forwards to the live `ResearchService` (the same namespace the Servers
 * panel drives), so the domain behavior itself is covered by the ssh-jobs and
 * service suites; here we pin the tool surface — argument mapping (snake_case
 * → camelCase), failure shaping (a rejected Remote call is returned as a
 * business failure, not thrown), and that a job the tools submit is the very
 * job `server_list_jobs` observes settling. The fake-`ssh` PATH shim is
 * reused from the ssh-jobs harness so no real ssh runs.
 */

import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import {
  createServerCheckTool,
  createServerListJobsTool,
  createServerListTool,
  createServerSubmitJobTool,
} from '../src/tools/server.ts'
import type { ResearchServiceResolver } from '../src/tools/server.ts'
import { ResearchService } from '../src/service.ts'
import type { JobRecord, ServerRecord } from '../src/types.ts'

/** Boot a memory-backed domain plus a fresh temp workspace and the four tools. */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-server-tools-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
  })
  // In apply() the resolver reads ctx.research; a direct service is the unit
  // under test here, so the resolver returns the constructed instance.
  const getResearch: ResearchServiceResolver = () => service
  return {
    domain,
    workspaceDir,
    service,
    serverList: createServerListTool(getResearch),
    serverCheck: createServerCheckTool(getResearch),
    serverSubmit: createServerSubmitJobTool(getResearch),
    serverListJobs: createServerListJobsTool(getResearch),
  }
}

/** The tool execute() needs a ToolRunContext it never reads in these paths. */
const NO_EXEC = {} as ToolRunContext

/** One saved ssh-capable server (the fake ssh answers it). */
const SERVER_INPUT = { name: 'gpu01', host: '127.0.0.1', port: 22, username: 'ops', note: '' }

/** Save one server and return its record. */
async function saveServer(service: ResearchService, input = SERVER_INPUT): Promise<ServerRecord> {
  const created = await service.saveServer({ server: input })
  if (!created.ok) throw new Error('create failed')
  return created.value.server
}

/**
 * Shim a fake `ssh` onto PATH: echoes its remote command (its last argument)
 * to stdout and settles; `mimir-slow` sleeps briefly, `mimir-fail` exits 3.
 */
async function stubFakeSsh(): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), 'mimir-fake-ssh-'))
  const script = [
    '#!/bin/bash',
    'while [ $# -gt 1 ]; do shift; done',
    'echo "fake-ssh stdout: $1"',
    'echo "fake-ssh stderr line" >&2',
    'case "$1" in *mimir-fail*) exit 3 ;; esac',
    'case "$1" in *mimir-slow*) sleep 0.5 ;; esac',
    'exit 0',
    '',
  ].join('\n')
  await writeFile(join(binDir, 'ssh'), script)
  await chmod(join(binDir, 'ssh'), 0o755)
  vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)
}

/** Poll server_list_jobs until one job reaches a terminal status. */
async function settleJob(
  tool: ReturnType<typeof createServerListJobsTool>,
  id: string,
): Promise<JobRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const outcome = await tool.execute({}, NO_EXEC)
    const value = (outcome as { jobs: JobRecord[] }).jobs
    const job = value.find(record => record.id === id)
    if (job !== undefined && (job.status === 'succeeded' || job.status === 'failed')) return job
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`job ${id} did not settle`)
}

afterEach(() => { vi.unstubAllEnvs() })

describe('server_list', () => {
  it('lists the saved servers, most recently updated first', async () => {
    const { service, serverList } = await harness()
    await saveServer(service, { ...SERVER_INPUT, name: 'gpu01' })
    await new Promise(resolve => setTimeout(resolve, 2))
    await saveServer(service, { ...SERVER_INPUT, name: 'gpu02' })
    const value = await serverList.execute({}, NO_EXEC) as { servers: ServerRecord[] }
    expect(value.servers.map(server => server.name)).toEqual(['gpu02', 'gpu01'])
    expect(value.servers[0]).toMatchObject({ host: '127.0.0.1', port: 22, username: 'ops' })
  })

  it('detail=false returns only ids and names', async () => {
    const { service, serverList } = await harness()
    await saveServer(service)
    const value = await serverList.execute({ detail: false }, NO_EXEC) as { servers: { server_id: string; name: string }[] }
    expect(value.servers).toEqual([{ server_id: expect.any(String), name: 'gpu01' }])
  })
})

describe('server_check', () => {
  it('probes an offline server to an offline view', async () => {
    const { service, serverCheck } = await harness()
    const server = await saveServer(service, { ...SERVER_INPUT, host: '127.0.0.1', port: 19999 })
    const outcome = await serverCheck.execute({ server_id: server.id }, NO_EXEC) as { state: string }
    expect(outcome.state).toBe('offline')
  }, 20_000)

  it('reports an unknown server id as a failure, not a thrown error', async () => {
    const { serverCheck } = await harness()
    const value = await serverCheck.execute({ server_id: 'srv-missing' }, NO_EXEC)
    expect(value).toEqual({ ok: false, error: { code: 'server-not-found', id: 'srv-missing' } })
  })
})

describe('server_submit_job / server_list_jobs', () => {
  it('maps snake_case args, returns the queued record, and the job settles to succeeded', async () => {
    const { domain, service, serverSubmit, serverListJobs } = await harness()
    await stubFakeSsh()
    const server = await saveServer(service)

    const submitted = await serverSubmit.execute(
      { server_id: server.id, command: 'python train.py --epochs 1' },
      NO_EXEC,
    ) as { job: JobRecord }
    expect(submitted.job).toMatchObject({ serverId: server.id, status: 'queued' })
    // The job is durable in the shared domain, and listJobs observes it.
    expect(domain.table('jobs').get(submitted.job.id)).toMatchObject({ command: 'python train.py --epochs 1' })

    const settled = await settleJob(serverListJobs, submitted.job.id)
    expect(settled.status).toBe('succeeded')
    expect(settled.exitCode).toBe(0)
    expect(settled.stdoutTail).toContain('fake-ssh stdout: python train.py --epochs 1')
  })

  it('returns submit rejections as failures and lists by server', async () => {
    const { service, serverSubmit, serverListJobs } = await harness()
    await stubFakeSsh()
    const server = await saveServer(service)

    await expect(serverSubmit.execute({ server_id: 'srv-missing', command: 'hostname' }, NO_EXEC))
      .resolves.toEqual({ ok: false, error: { code: 'server-not-found', id: 'srv-missing' } })
    await expect(serverSubmit.execute({ server_id: server.id, command: '   ' }, NO_EXEC))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    // A rejected submit queues nothing.
    const listed = await serverListJobs.execute({}, NO_EXEC) as { jobs: JobRecord[] }
    expect(listed.jobs).toEqual([])

    const submitted = await serverSubmit.execute({ server_id: server.id, command: 'hostname' }, NO_EXEC) as { job: JobRecord }
    const byServer = await serverListJobs.execute({ server_id: server.id }, NO_EXEC) as { jobs: JobRecord[] }
    expect(byServer.jobs.map(job => job.id)).toEqual([submitted.job.id])
    const byOther = await serverListJobs.execute({ server_id: 'srv-other' }, NO_EXEC)
    expect(byOther).toEqual({ ok: false, error: { code: 'server-not-found', id: 'srv-other' } })
  })

  it('forwards a linked experiment_id through to the job record', async () => {
    const { domain, service, serverSubmit } = await harness()
    await stubFakeSsh()
    const server = await saveServer(service)
    await domain.table('experiments').put('exp-1', {
      id: 'exp-1', projectId: 'p1', name: 'baseline', status: 'failed',
      metrics: {}, updatedAt: '2026-08-20T00:00:00.000Z',
    })

    const submitted = await serverSubmit.execute(
      { server_id: server.id, command: 'hostname', experiment_id: 'exp-1' },
      NO_EXEC,
    ) as { job: JobRecord }
    expect(submitted.job.experimentId).toBe('exp-1')
    expect(domain.table('experiments').get('exp-1')).toMatchObject({ status: 'running' })
    await expect(serverSubmit.execute(
      { server_id: server.id, command: 'hostname', experiment_id: 'exp-missing' },
      NO_EXEC,
    )).resolves.toEqual({ ok: false, error: { code: 'experiment-not-found', id: 'exp-missing' } })
  })
})
