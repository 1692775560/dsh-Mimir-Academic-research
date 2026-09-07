/**
 * Composition test for the `server_*` tools' real wiring: the full `apply()`
 * entry is invoked over a composed context that mounts every service the
 * plugin injects (`commands`, `tools`, `subagents`, `storageDomain`,
 * `webServer`), and the four tools are then observed through the live tool
 * registry — `ctx.tools.schemas()` proves they are model-visible, and
 * `ctx.tools.execute()` drives a real submit whose queued record lands in the
 * same domain the registered resolver reaches. This is the test that would
 * fail if a future refactor stopped registering the tools in `apply()` or
 * forwarded them to the wrong service instance.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { ServerRecord } from '../src/types.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { apply, Config } from '../src/index.ts'
import { ResearchService } from '../src/service.ts'

/** Shim a fake `ssh` that echoes its command and settles. */
async function stubFakeSsh(): Promise<void> {
  const { chmod, mkdtemp: mkd, writeFile } = await import('node:fs/promises')
  const binDir = await mkd(join(tmpdir(), 'mimir-fake-ssh-'))
  const script = [
    '#!/bin/bash',
    'while [ $# -gt 1 ]; do shift; done',
    'echo "fake-ssh stdout: $1"',
    'exit 0',
    '',
  ].join('\n')
  await writeFile(join(binDir, 'ssh'), script)
  await chmod(join(binDir, 'ssh'), 0o755)
  vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)
}

afterEach(() => { vi.unstubAllEnvs() })

/**
 * Boot the full plugin over the services `apply()` touches. The plugin
 * declares `['commands', 'tools', 'subagents', 'storageDomain', 'webServer']`
 * as injects; of these, `webServer` is used only for route registration and
 * `subagents`/`skills` only inside command bodies and the optional skill
 * mount, so a context providing `commands`, `tools` (+ its `systemPrompt`
 * dependency), `storageDomain`, and `webServer` covers every line `apply()`
 * actually runs. `webServer` is satisfied by a minimal route-register stub
 * rather than the real network carrier.
 */
async function bootComposition(): Promise<{ ctx: Context; service: ResearchService }> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  // The only `apply()` use of webServer is ctx.webServer.register(...) route
  // effects; a stub that accepts and disposes routes is enough.
  ctx.provide('webServer', { register: () => () => {} })
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-apply-'))
  await apply(ctx, {
    workspaceDir,
    latex: { engine: 'auto', timeoutMs: 1000 },
    backup: { enabled: false },
    subscriptions: { enabled: false },
  } satisfies Config)
  // apply() fires ctx.plugin(ResearchService) without awaiting it, so the
  // service mounts a beat after apply resolves; wait for it to appear. The
  // registered tools resolve it lazily at execute time either way.
  let service: ResearchService | undefined
  for (let attempt = 0; attempt < 100 && service === undefined; attempt += 1) {
    service = ctx.get('research') as ResearchService | undefined
    if (service === undefined) await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (service === undefined) throw new Error('research service never mounted')
  return { ctx, service }
}

describe('server_* tools registered by apply()', () => {
  it('exposes all four tools to the model registry', async () => {
    const { ctx } = await bootComposition()
    const names = ctx.tools.schemas().map(tool => tool.name)
    for (const expected of ['server_list', 'server_check', 'server_submit_job', 'server_list_jobs']) {
      expect(names).toContain(expected)
    }
  })

  it('dispatches a real submit through the registry to the shared domain', async () => {
    const { ctx, service } = await bootComposition()
    await stubFakeSsh()
    const created = await service.saveServer({
      server: { name: 'gpu01', host: '127.0.0.1', port: 22, username: 'ops', note: '' },
    })
    if (!created.ok) throw new Error('create failed')
    const serverId = created.value.server.id

    const submit = await ctx.tools.execute({
      callId: 'server-tools-test:submit',
      name: 'server_submit_job',
      arguments: { server_id: serverId, command: 'hostname' },
      signal: new AbortController().signal,
    })
    expect(submit.isError).toBe(false)
    const text = submit.content.map(block => (block as { text?: string }).text ?? '').join('')
    const jobId = (JSON.parse(text) as { job?: { id: string } }).job?.id
    expect(jobId).toBeTruthy()

    const listed = await service.listJobs({})
    if (!listed.ok) throw new Error('list rejected')
    expect(listed.value.jobs.find(job => job.id === jobId)).toMatchObject({ serverId })
  })

  it('server_list resolves the same servers the service holds', async () => {
    const { ctx, service } = await bootComposition()
    const created = await service.saveServer({
      server: { name: 'gpu02', host: '10.0.0.2', port: 22, username: 'ops', note: '', tags: ['a'] },
    })
    if (!created.ok) throw new Error('create failed')
    const list = await ctx.tools.execute({
      callId: 'server-tools-test:list',
      name: 'server_list',
      arguments: {},
      signal: new AbortController().signal,
    })
    expect(list.isError).toBe(false)
    const text = list.content.map(block => (block as { text?: string }).text ?? '').join('')
    const servers = (JSON.parse(text) as { servers: ServerRecord[] }).servers
    expect(servers.map(server => server.name)).toEqual(['gpu02'])
  })
})
