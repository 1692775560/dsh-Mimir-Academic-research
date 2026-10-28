/**
 * Behavior tests for server password auth (#263): the saveServer password
 * semantics (set / keep / clear), the secret's confinement to the host
 * (stripped from RPC views, event payloads, and the wiki export), the input
 * validation bounds, and the ssh invocation hand-off — the password rides
 * the askpass helper's environment, never argv, and the helper dir is
 * deleted when the call settles. Real memory-backed domain; the ssh client
 * is a PATH-shimmed fake that captures its argv and the askpass env vars.
 */

import { chmod, mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import type { JobRecord, ServerInput } from '../src/types.ts'

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
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-server-password-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
  })
  return { ctx, domain, workspaceDir, service }
}

const SERVER_INPUT: ServerInput = { name: 'gpu01', host: '127.0.0.1', port: 22, username: 'ops', note: '' }
const PASSWORD = 'S3cret! with spaces & $hell'

afterEach(() => { vi.unstubAllEnvs() })

/** Create a server with the password; returns the stored record's id. */
async function createWithPassword(service: ResearchService, password = PASSWORD): Promise<string> {
  const created = await service.saveServer({ server: { ...SERVER_INPUT, password } })
  if (!created.ok) throw new Error('create failed')
  return created.value.server.id
}

describe('saveServer password semantics (#263)', () => {
  it('stores a create-time password and returns only the stripped view', async () => {
    const { domain, service } = await harness()
    const created = await service.saveServer({ server: { ...SERVER_INPUT, password: PASSWORD } })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // The RPC view carries the marker, never the secret.
    expect(created.value.server.hasPassword).toBe(true)
    expect(created.value.server).not.toHaveProperty('password')
    // …while the stored record keeps it.
    expect(domain.table('servers').get(created.value.server.id)?.password).toBe(PASSWORD)
    const listed = await service.listServers()
    if (!listed.ok) throw new Error('list failed')
    expect(listed.value.servers[0]?.hasPassword).toBe(true)
    expect(JSON.stringify(listed.value.servers)).not.toContain(PASSWORD)
  })

  it('omitted keeps the stored password on update; empty clears; a value replaces', async () => {
    const { domain, service } = await harness()
    const id = await createWithPassword(service)
    // Omitted password: keep.
    const kept = await service.saveServer({ server: { ...SERVER_INPUT, id, note: 'rack 4' } })
    if (!kept.ok) throw new Error('keep failed')
    expect(kept.value.server.hasPassword).toBe(true)
    expect(domain.table('servers').get(id)?.password).toBe(PASSWORD)
    // A new value: replace.
    const replaced = await service.saveServer({ server: { ...SERVER_INPUT, id, password: 'n3w-pw' } })
    if (!replaced.ok) throw new Error('replace failed')
    expect(domain.table('servers').get(id)?.password).toBe('n3w-pw')
    // Empty string: clear back to key auth.
    const cleared = await service.saveServer({ server: { ...SERVER_INPUT, id, password: '' } })
    if (!cleared.ok) throw new Error('clear failed')
    expect(cleared.value.server.hasPassword).toBe(false)
    expect(cleared.value.server).not.toHaveProperty('password')
    expect(domain.table('servers').get(id)).not.toHaveProperty('password')
  })

  it('rejects overlong and control-character passwords as invalid-input', async () => {
    const { service } = await harness()
    await expect(service.saveServer({ server: { ...SERVER_INPUT, password: 'x'.repeat(257) } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.saveServer({ server: { ...SERVER_INPUT, password: 'line\nbreak' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    // The boundary itself is fine.
    await expect(service.saveServer({ server: { ...SERVER_INPUT, password: 'x'.repeat(256) } }))
      .resolves.toMatchObject({ ok: true })
  })

  it('keeps the password out of the compute.server.saved event payload', async () => {
    const { domain, service } = await harness()
    await createWithPassword(service)
    const events = [...domain.table('events').entries()].map(([, record]) => record)
    const saved = events.filter(event => event.action === 'compute.server.saved')
    expect(saved.length).toBeGreaterThan(0)
    expect(JSON.stringify(saved)).not.toContain(PASSWORD)
  })

  it('strips the password from the wiki export (and backups share the builder)', async () => {
    const { service } = await harness()
    await createWithPassword(service)
    const outcome = await service.exportWiki()
    if (!outcome.ok) throw new Error('export failed')
    expect(JSON.stringify(outcome.value.snapshot)).not.toContain(PASSWORD)
    expect(outcome.value.snapshot.tables.servers[0]).not.toHaveProperty('password')
    expect(outcome.value.snapshot.tables.servers[0]).toMatchObject({ name: 'gpu01' })
  })
})

/**
 * Shim a fake `ssh` onto PATH that captures its full argv plus the askpass
 * hand-off env vars to `$MIMIR_SSH_CAPTURE`, then succeeds. PATH restores
 * via `vi.unstubAllEnvs`.
 */
async function stubCapturingSsh(capturePath: string): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), 'mimir-fake-ssh-pw-'))
  const script = [
    '#!/bin/bash',
    '{',
    '  echo "argv:"',
    '  printf \'%s\\n\' "$@"',
    '  echo "env:"',
    '  printf \'SSH_ASKPASS=%s\\n\' "${SSH_ASKPASS-unset}"',
    '  printf \'SSH_ASKPASS_REQUIRE=%s\\n\' "${SSH_ASKPASS_REQUIRE-unset}"',
    '  printf \'MIMIR_SSH_ASKPASS_PASSWORD=%s\\n\' "${MIMIR_SSH_ASKPASS_PASSWORD-unset}"',
    `} > ${JSON.stringify(capturePath)}`,
    'echo "fake-ssh stdout"',
    'exit 0',
    '',
  ].join('\n')
  await writeFile(join(binDir, 'ssh'), script)
  await chmod(join(binDir, 'ssh'), 0o755)
  vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)
}

/** Submit one job and wait for its terminal record; returns it. */
async function runToSettled(service: ResearchService, serverId: string, command: string): Promise<JobRecord> {
  const submitted = await service.submitJob({ serverId, command })
  if (!submitted.ok) throw new Error('submit failed')
  const id = submitted.value.job.id
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listed = await service.listJobs({})
    if (!listed.ok) throw new Error('list failed')
    const job = listed.value.jobs.find(record => record.id === id)
    if (job !== undefined && job.status !== 'queued' && job.status !== 'running') return job
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('job never settled')
}

describe('ssh password hand-off (#263)', () => {
  it('passes the password through the askpass environment, never argv, and cleans the helper up', async () => {
    const capture = join(await mkdtemp(join(tmpdir(), 'mimir-ssh-capture-')), 'capture.txt')
    await stubCapturingSsh(capture)
    const { service } = await harness()
    const id = await createWithPassword(service)
    const job = await runToSettled(service, id, 'echo hello')
    expect(job.status).toBe('succeeded')
    const captured = await readFile(capture, 'utf8')
    const [argvSection, envSection] = captured.split('env:\n')
    // The secret is confined to the environment hand-off…
    expect(argvSection).not.toContain(PASSWORD)
    expect(envSection).toContain(`MIMIR_SSH_ASKPASS_PASSWORD=${PASSWORD}`)
    expect(envSection).toContain('SSH_ASKPASS_REQUIRE=force')
    // …the session is pinned to a single password prompt…
    expect(argvSection).toContain('BatchMode=no')
    expect(argvSection).toContain('PreferredAuthentications=password')
    expect(argvSection).toContain('PubkeyAuthentication=no')
    // …and the helper dir is gone once the call settles.
    const helper = /^SSH_ASKPASS=(.+)$/m.exec(envSection ?? '')?.[1]
    expect(helper).toBeTruthy()
    await expect(access(helper as string)).rejects.toThrow()
  })

  it('keeps the batch-mode key-auth call untouched when no password is stored', async () => {
    const capture = join(await mkdtemp(join(tmpdir(), 'mimir-ssh-capture-')), 'capture.txt')
    await stubCapturingSsh(capture)
    const { service } = await harness()
    const created = await service.saveServer({ server: SERVER_INPUT })
    if (!created.ok) throw new Error('create failed')
    expect(created.value.server.hasPassword).toBe(false)
    const job = await runToSettled(service, created.value.server.id, 'echo hello')
    expect(job.status).toBe('succeeded')
    const captured = await readFile(capture, 'utf8')
    expect(captured).toContain('BatchMode=yes')
    expect(captured).toContain('SSH_ASKPASS_REQUIRE=unset')
    expect(captured).toContain('MIMIR_SSH_ASKPASS_PASSWORD=unset')
  })
})
