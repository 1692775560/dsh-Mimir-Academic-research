/**
 * Behavior tests for the ResearchService Remote methods added with the
 * figures/servers workbench: deleteFigure path confinement, the server CRUD
 * upsert rules, and the two-stage checkServer probe (TCP, then best-effort
 * ssh GPU readout) — plus the literature-workbench round: searchArxiv input
 * validation and stubbed-fetch outcomes, importPaper upsert idempotence, and
 * removePaper — plus the experiments-workbench round: deleteExperiment. Real
 * memory-backed domain, real temp workspace, real loopback
 * sockets — no mocks (the arXiv API itself is stubbed at `fetch`).
 */

import { chmod, mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import type { ResearchServiceConfig } from '../src/service.ts'
import { ARXIV_PDF_MAX_BYTES, paperPdfFileName, parseArxivFeed } from '../src/tools/arxiv.ts'
import type { ProjectRecord } from '../src/types.ts'

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function harness(svg?: ResearchServiceConfig['svg']) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-service-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
    ...(svg === undefined ? {} : { svg }),
  })
  return { ctx, domain, workspaceDir, service }
}

/** Boot the same stack without pre-building the service (a second service on a fresh context). */
async function harnessFresh(): Promise<{ ctx: Context; domain: Awaited<ReturnType<DomainFacility['open']>>; workspaceDir: string }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-service-'))
  return { ctx, domain, workspaceDir }
}

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Project',
  stage: 'writing',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

/** Scaffold the default paper directory with one figure in `figures/`. */
async function scaffoldPaper(workspaceDir: string): Promise<void> {
  const figuresDir = join(workspaceDir, 'paper', 'figures')
  await mkdir(figuresDir, { recursive: true })
  await writeFile(join(figuresDir, 'plot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
}

const SERVER_INPUT = { name: 'gpu01', host: '127.0.0.1', port: 22, username: 'ops', note: 'rack 3' }

describe('ResearchService.deleteFigure', () => {
  it('deletes one figure and reports its relative path', async () => {
    const { domain, workspaceDir, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await scaffoldPaper(workspaceDir)
    const outcome = await service.deleteFigure({ projectId: 'p1', relPath: 'figures/plot.png' })
    expect(outcome).toEqual({ ok: true, value: { relPath: 'figures/plot.png' } })
    const listed = await service.listFigures({ projectId: 'p1' })
    expect(listed).toEqual({ ok: true, value: { figures: [] } })
  })

  it('rejects traversal and non-figure paths without touching the disk', async () => {
    const { domain, workspaceDir, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await scaffoldPaper(workspaceDir)
    await writeFile(join(workspaceDir, 'paper', 'main.tex'), '\\documentclass{article}')
    await expect(service.deleteFigure({ projectId: 'p1', relPath: '../outside.png' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-path' } })
    await expect(service.deleteFigure({ projectId: 'p1', relPath: 'main.tex' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-path' } })
    await expect(service.deleteFigure({ projectId: 'p1', relPath: 'main.pdf' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-path' } })
    // main.tex survived the rejections.
    const source = await service.getPaperSource({ projectId: 'p1' })
    expect(source.ok).toBe(true)
  })

  it('reports figure-not-found for an absent file and project-not-found for an unknown id', async () => {
    const { domain, workspaceDir, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await scaffoldPaper(workspaceDir)
    await expect(service.deleteFigure({ projectId: 'p1', relPath: 'figures/missing.png' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'figure-not-found', relPath: 'figures/missing.png' } })
    await expect(service.deleteFigure({ projectId: 'missing', relPath: 'figures/plot.png' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found', projectId: 'missing' } })
  })
})

describe('ResearchService.saveFigure', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="110"><title>mpjpe</title></svg>\n'

  /** A fake rsvg-convert that writes a marker PDF at the -o target. */
  const FAKE_CONVERTER = {
    probe: (command: string) => Promise.resolve(command === 'rsvg-convert' ? '/fake/bin/rsvg-convert' : null),
    run: async (_executable: string, args: readonly string[]) => {
      await writeFile(String(args[args.indexOf('-o') + 1]), '%PDF-fake')
      return { ok: true as const, message: '' }
    },
  }

  it('writes the SVG, registers the caption, lists the artifact, and converts', async () => {
    const { domain, workspaceDir, service } = await harness(FAKE_CONVERTER)
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await scaffoldPaper(workspaceDir)
    const outcome = await service.saveFigure({
      projectId: 'p1', name: 'metric-mpjpe.svg', content: SVG,
      caption: 'Comparison of mpjpe across experiments.',
    })
    expect(outcome).toEqual({
      ok: true,
      value: {
        relPath: 'figures/metric-mpjpe.svg',
        caption: 'Comparison of mpjpe across experiments.',
        converted: { relPath: 'figures/metric-mpjpe.pdf', converter: 'rsvg-convert' },
      },
    })
    expect(await readFile(join(workspaceDir, 'paper', 'figures', 'metric-mpjpe.svg'), 'utf8')).toBe(SVG)
    expect(await readFile(join(workspaceDir, 'paper', 'figures', 'metric-mpjpe.pdf'), 'utf8')).toBe('%PDF-fake')
    expect(domain.table('figures').get('p1:figures/metric-mpjpe.svg'))
      .toMatchObject({ caption: 'Comparison of mpjpe across experiments.' })
    expect(domain.table('projects').get('p1')?.artifacts).toContain('paper/figures/metric-mpjpe.svg')
    // The figures view's scan merges the registered caption.
    const listed = await service.listFigures({ projectId: 'p1' })
    expect(listed.ok && listed.value.figures.some(
      entry => entry.relPath === 'figures/metric-mpjpe.svg' && entry.caption === 'Comparison of mpjpe across experiments.',
    )).toBe(true)
  })

  it('still saves and registers with a warning when no converter is available', async () => {
    const { domain, workspaceDir, service } = await harness({ probe: () => Promise.resolve(null) })
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await scaffoldPaper(workspaceDir)
    const outcome = await service.saveFigure({ projectId: 'p1', name: 'm.svg', content: SVG, caption: 'c' })
    expect(outcome).toMatchObject({ ok: true, value: { relPath: 'figures/m.svg', caption: 'c' } })
    expect(outcome.ok && outcome.value.warning).toContain('No SVG converter found')
    expect(await readFile(join(workspaceDir, 'paper', 'figures', 'm.svg'), 'utf8')).toBe(SVG)
    expect(domain.table('figures').get('p1:figures/m.svg')).toMatchObject({ caption: 'c' })
  })

  it('rejects non-SVG names, traversal, and empty content without writing', async () => {
    const { domain, workspaceDir, service } = await harness(FAKE_CONVERTER)
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await scaffoldPaper(workspaceDir)
    await expect(service.saveFigure({ projectId: 'p1', name: 'plot.png', content: SVG }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-name' } })
    await expect(service.saveFigure({ projectId: 'p1', name: '../escape.svg', content: SVG }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-name' } })
    await expect(service.saveFigure({ projectId: 'p1', name: 'm.svg', content: '  \n' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-content' } })
    await expect(service.saveFigure({ projectId: 'missing', name: 'm.svg', content: SVG }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
    expect([...domain.table('figures').entries()]).toEqual([])
  })
})

describe('ResearchService server CRUD', () => {
  it('creates a server with a generated id and lists it back', async () => {
    const { service } = await harness()
    const created = await service.saveServer({ server: SERVER_INPUT })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.server).toMatchObject(SERVER_INPUT)
    expect(created.value.server.id).toMatch(/^srv-/)
    expect(created.value.server.createdAt).toBe(created.value.server.updatedAt)
    const listed = await service.listServers()
    expect(listed).toEqual({ ok: true, value: { servers: [created.value.server] } })
  })

  it('updates keep createdAt and refresh updatedAt', async () => {
    const { service } = await harness()
    const created = await service.saveServer({ server: SERVER_INPUT })
    if (!created.ok) throw new Error('create failed')
    const updated = await service.saveServer({
      server: { ...SERVER_INPUT, id: created.value.server.id, note: 'rack 4' },
    })
    if (!updated.ok) throw new Error('update failed')
    expect(updated.value.server.id).toBe(created.value.server.id)
    expect(updated.value.server.note).toBe('rack 4')
    expect(updated.value.server.createdAt).toBe(created.value.server.createdAt)
    expect(Date.parse(updated.value.server.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(created.value.server.updatedAt),
    )
  })

  it('rejects invalid input and unknown update ids as business failures', async () => {
    const { service } = await harness()
    for (const server of [
      { ...SERVER_INPUT, name: ' ' },
      { ...SERVER_INPUT, host: '' },
      { ...SERVER_INPUT, port: 0 },
      { ...SERVER_INPUT, port: 65536 },
      { ...SERVER_INPUT, port: 22.5 },
    ]) {
      await expect(service.saveServer({ server })).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      })
    }
    await expect(service.saveServer({ server: { ...SERVER_INPUT, id: 'srv-missing' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'server-not-found', id: 'srv-missing' } })
  })

  it('rejects hosts and usernames that could inject ssh options', async () => {
    const { service } = await harness()
    for (const server of [
      { ...SERVER_INPUT, host: '-oProxyCommand=evil' },
      { ...SERVER_INPUT, host: 'gpu 01' },
      { ...SERVER_INPUT, host: 'gpu01;rm' },
      { ...SERVER_INPUT, host: '../escape' },
      { ...SERVER_INPUT, username: '-oProxyCommand=evil' },
      { ...SERVER_INPUT, username: 'root; whoami' },
      { ...SERVER_INPUT, username: '--' },
    ]) {
      await expect(service.saveServer({ server })).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      })
    }
    // Legitimate forms still pass: an ipv6 host, a dotted username.
    await expect(service.saveServer({
      server: { ...SERVER_INPUT, host: 'fe80::1', username: 'ops.deploy' },
    })).resolves.toMatchObject({ ok: true })
  })

  it('deletes a server and reports server-not-found on a repeat', async () => {
    const { service } = await harness()
    const created = await service.saveServer({ server: SERVER_INPUT })
    if (!created.ok) throw new Error('create failed')
    const id = created.value.server.id
    await expect(service.deleteServer({ id })).resolves.toEqual({ ok: true, value: { id } })
    await expect(service.deleteServer({ id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'server-not-found', id } })
    await expect(service.listServers()).resolves.toEqual({ ok: true, value: { servers: [] } })
  })

  it('cleans tags on save: trimmed, emptied out, deduped; omitted keeps them', async () => {
    const { service } = await harness()
    const created = await service.saveServer({
      server: { ...SERVER_INPUT, tags: [' gpu-cluster ', '', 'dev', 'gpu-cluster', '  '] },
    })
    if (!created.ok) throw new Error('create failed')
    expect(created.value.server.tags).toEqual(['gpu-cluster', 'dev'])
    // An update without tags keeps the stored list.
    const renamed = await service.saveServer({
      server: { ...SERVER_INPUT, id: created.value.server.id, note: 'rack 4' },
    })
    if (!renamed.ok) throw new Error('update failed')
    expect(renamed.value.server.tags).toEqual(['gpu-cluster', 'dev'])
    // An explicit list replaces; an empty list clears.
    const cleared = await service.saveServer({
      server: { ...SERVER_INPUT, id: created.value.server.id, tags: [] },
    })
    if (!cleared.ok) throw new Error('update failed')
    expect(cleared.value.server.tags).toEqual([])
  })
})

describe('ResearchService.checkServer', () => {
  it('settles an unreachable address as offline with the socket message, stopped at the tcp stage', async () => {
    const { service } = await harness()
    const created = await service.saveServer({
      server: { ...SERVER_INPUT, host: '127.0.0.1', port: 19999 },
    })
    if (!created.ok) throw new Error('create failed')
    const checked = await service.checkServer({ id: created.value.server.id })
    if (!checked.ok) throw new Error('check rejected')
    expect(checked.value.state).toBe('offline')
    expect(checked.value.latencyMs).toBeNull()
    expect(checked.value.gpus).toEqual([])
    expect(checked.value.message).toBeTruthy()
    expect(checked.value.stage).toBe('tcp')
    expect(checked.value.tcpLatencyMs).toBeUndefined()
    expect(checked.value.gpuLatencyMs).toBeUndefined()
    expect(Date.parse(checked.value.checkedAt)).not.toBeNaN()
  })

  it('reports server-not-found for an unknown id', async () => {
    const { service } = await harness()
    await expect(service.checkServer({ id: 'srv-missing' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'server-not-found', id: 'srv-missing' } })
  })

  it('settles a listening address as online with latency, TCP-only without a username', async () => {
    const listener = createServer()
    await new Promise<void>((resolveListen) => { listener.listen(0, '127.0.0.1', resolveListen) })
    try {
      const port = (listener.address() as AddressInfo).port
      const { service } = await harness()
      const created = await service.saveServer({
        server: { ...SERVER_INPUT, host: '127.0.0.1', port, username: '' },
      })
      if (!created.ok) throw new Error('create failed')
      const checked = await service.checkServer({ id: created.value.server.id })
      if (!checked.ok) throw new Error('check rejected')
      expect(checked.value.state).toBe('online')
      expect(checked.value.latencyMs).toBeGreaterThanOrEqual(0)
      expect(checked.value.gpus).toEqual([])
      expect(checked.value.message).toBeNull()
      expect(checked.value.stage).toBe('tcp')
      expect(checked.value.tcpLatencyMs).toBeGreaterThanOrEqual(0)
      expect(checked.value.gpuLatencyMs).toBeUndefined()
    } finally {
      await new Promise<void>((resolveClose) => { listener.close(() => { resolveClose() }) })
    }
  })

  it('keeps a reachable server online when the ssh session itself fails, stopped at the ssh stage', async () => {
    const listener = createServer((socket) => { socket.destroy() })
    await new Promise<void>((resolveListen) => { listener.listen(0, '127.0.0.1', resolveListen) })
    try {
      const port = (listener.address() as AddressInfo).port
      const { service } = await harness()
      // A username is set, so the probe attempts ssh against a socket that is
      // not an sshd: the readout fails (ssh exits 255, a session failure) but
      // the server stays online.
      const created = await service.saveServer({
        server: { ...SERVER_INPUT, host: '127.0.0.1', port },
      })
      if (!created.ok) throw new Error('create failed')
      const checked = await service.checkServer({ id: created.value.server.id })
      if (!checked.ok) throw new Error('check rejected')
      expect(checked.value.state).toBe('online')
      expect(checked.value.gpus).toEqual([])
      expect(checked.value.message).toContain('gpu probe failed')
      expect(checked.value.stage).toBe('ssh')
      expect(checked.value.tcpLatencyMs).toBeGreaterThanOrEqual(0)
      expect(checked.value.gpuLatencyMs).toBeGreaterThanOrEqual(0)
    } finally {
      await new Promise<void>((resolveClose) => { listener.close(() => { resolveClose() }) })
    }
  }, 20_000)

  it('lands a remote nvidia-smi failure on the gpu stage (non-255 exit)', async () => {
    const listener = createServer()
    await new Promise<void>((resolveListen) => { listener.listen(0, '127.0.0.1', resolveListen) })
    try {
      const port = (listener.address() as AddressInfo).port
      await stubFakeSshForGpuProbe()
      const { service } = await harness()
      // The fake ssh exits 3 (a remote command failure, not a session
      // failure) when the login user names the gpu-fail marker.
      const created = await service.saveServer({
        server: { ...SERVER_INPUT, host: '127.0.0.1', port, username: 'gpu-fail' },
      })
      if (!created.ok) throw new Error('create failed')
      const checked = await service.checkServer({ id: created.value.server.id })
      if (!checked.ok) throw new Error('check rejected')
      expect(checked.value.state).toBe('online')
      expect(checked.value.gpus).toEqual([])
      expect(checked.value.message).toContain('gpu probe failed')
      expect(checked.value.stage).toBe('gpu')
      expect(checked.value.tcpLatencyMs).toBeGreaterThanOrEqual(0)
      expect(checked.value.gpuLatencyMs).toBeGreaterThanOrEqual(0)
    } finally {
      await new Promise<void>((resolveClose) => { listener.close(() => { resolveClose() }) })
    }
  })

  it('reaches the gpu stage with the parsed table when the readout succeeds', async () => {
    const listener = createServer()
    await new Promise<void>((resolveListen) => { listener.listen(0, '127.0.0.1', resolveListen) })
    try {
      const port = (listener.address() as AddressInfo).port
      await stubFakeSshForGpuProbe()
      const { service } = await harness()
      const created = await service.saveServer({
        server: { ...SERVER_INPUT, host: '127.0.0.1', port },
      })
      if (!created.ok) throw new Error('create failed')
      const checked = await service.checkServer({ id: created.value.server.id })
      if (!checked.ok) throw new Error('check rejected')
      expect(checked.value.state).toBe('online')
      expect(checked.value.message).toBeNull()
      expect(checked.value.stage).toBe('gpu')
      expect(checked.value.gpus).toEqual([
        { name: 'Fake GPU 0', utilizationPct: 37, memoryUsedMb: 2048, memoryTotalMb: 24576 },
      ])
      expect(checked.value.tcpLatencyMs).toBeGreaterThanOrEqual(0)
      expect(checked.value.gpuLatencyMs).toBeGreaterThanOrEqual(0)
    } finally {
      await new Promise<void>((resolveClose) => { listener.close(() => { resolveClose() }) })
    }
  })
})

/**
 * Shim a fake `ssh` onto PATH for the GPU-stage checkServer tests: it prints
 * one `nvidia-smi` CSV row, or exits 3 (a remote command failure, distinct
 * from the ssh session's own 255) when the login user names `gpu-fail`.
 * PATH restores via `vi.unstubAllEnvs`.
 */
async function stubFakeSshForGpuProbe(): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), 'mimir-fake-ssh-gpu-'))
  const script = [
    '#!/bin/bash',
    'for arg in "$@"; do',
    '  case "$arg" in *gpu-fail@*) echo "nvidia-smi exploded" >&2; exit 3 ;; esac',
    'done',
    'echo "Fake GPU 0, 37, 2048, 24576"',
    'exit 0',
    '',
  ].join('\n')
  await writeFile(join(binDir, 'ssh'), script)
  await chmod(join(binDir, 'ssh'), 0o755)
  vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`)
}

const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2103.00020v2</id>
    <title>EgoSync &amp; Friends: A Study</title>
    <author><name>Doe, Jane</name></author>
    <author><name>Roe, John</name></author>
    <summary>  Multi
   line &lt;abstract&gt; body. </summary>
    <published>2021-03-01T00:00:00Z</published>
  </entry>
</feed>`

const ARXIV_ENTRY = {
  id: '2103.00020v2',
  title: 'EgoSync & Friends: A Study',
  authors: ['Doe, Jane', 'Roe, John'],
  summary: 'Multi line <abstract> body.',
  published: '2021-03-01T00:00:00Z',
  url: 'https://arxiv.org/abs/2103.00020v2',
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('parseArxivFeed', () => {
  it('parses entries, unescapes entities, and derives abs urls', () => {
    expect(parseArxivFeed(ARXIV_FEED)).toEqual([ARXIV_ENTRY])
    expect(parseArxivFeed('<feed xmlns="http://www.w3.org/2005/Atom"></feed>')).toEqual([])
  })
})

describe('ResearchService.searchArxiv', () => {
  it('rejects an empty query and a bad maxResults as invalid-input', async () => {
    const { service } = await harness()
    await expect(service.searchArxiv({ query: '   ' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.searchArxiv({ query: 'mesh', maxResults: 0 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.searchArxiv({ query: 'mesh', maxResults: 51 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.searchArxiv({ query: 'mesh', maxResults: 2.5 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('returns parsed results from a stubbed arXiv feed', async () => {
    let requestedUrl = ''
    vi.stubGlobal('fetch', async (url: string) => {
      requestedUrl = url
      return new Response(ARXIV_FEED, { status: 200 })
    })
    const { service } = await harness()
    const outcome = await service.searchArxiv({ query: 'egocentric whole body', maxResults: 5 })
    expect(outcome).toEqual({ ok: true, value: { results: [ARXIV_ENTRY] } })
    expect(requestedUrl).toContain('search_query=all:egocentric%20whole%20body')
    expect(requestedUrl).toContain('max_results=5')
  })

  it('settles transport and HTTP failures as operation-failed', async () => {
    const { service } = await harness()
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 500 }))
    await expect(service.searchArxiv({ query: 'mesh' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', message: expect.stringContaining('HTTP 500') } })
    vi.stubGlobal('fetch', async () => { throw new Error('socket hangup') })
    await expect(service.searchArxiv({ query: 'mesh' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', message: 'socket hangup' } })
  })
})

describe('ResearchService.searchWeb', () => {
  const SXNG_OK = JSON.stringify({
    status: 'ok',
    data: {
      query: 'q',
      totalResults: 1,
      results: [{
        title: 'A page', url: 'https://example.com/', content: 'Snippet.',
        engine: 'brave', category: 'general', publishedDate: '', thumbnail: '', score: 1,
      }],
    },
  })

  /** A service whose web search runs through an injected fake CLI, on a fresh context. */
  async function serviceWithSearch(stdout: string, calls: string[][] = []) {
    const built = await harnessFresh()
    return new ResearchService(built.ctx, {
      workspaceDir: built.workspaceDir,
      domain: built.domain,
      latex: { engine: 'auto', timeoutMs: 1000 },
      search: {
        command: 'sxng',
        timeoutMs: 5_000,
        run: (_command, args) => { calls.push([...args]); return Promise.resolve(stdout) },
      },
    })
  }

  it('is unavailable when no search command is configured', async () => {
    const { service } = await harness()
    await expect(service.searchWeb({ query: 'mesh' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', message: expect.stringContaining('not configured') } })
  })

  it('rejects an empty query and a bad maxResults as invalid-input', async () => {
    const service = await serviceWithSearch(SXNG_OK)
    await expect(service.searchWeb({ query: '   ' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.searchWeb({ query: 'mesh', maxResults: 0 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.searchWeb({ query: 'mesh', maxResults: 51 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('runs the configured CLI and returns parsed rows', async () => {
    const calls: string[][] = []
    const service = await serviceWithSearch(SXNG_OK, calls)
    const outcome = await service.searchWeb({ query: 'mesh recovery', maxResults: 3 })
    expect(outcome).toEqual({
      ok: true,
      value: { results: [{ title: 'A page', url: 'https://example.com/', content: 'Snippet.', engine: 'brave', category: 'general', publishedDate: '' }] },
    })
    expect(calls[0]).toContain('mesh recovery')
  })

  it('settles CLI failures as operation-failed', async () => {
    const failureBody = JSON.stringify({
      status: 'error', data: null,
      error: { code: 'SEARCH_FAILED', message: 'connect ECONNREFUSED 127.0.0.1:3668' },
    })
    const service = await serviceWithSearch(failureBody)
    await expect(service.searchWeb({ query: 'mesh' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', message: expect.stringContaining('ECONNREFUSED') } })
  })
})

describe('ResearchService.importPaper / removePaper', () => {
  it('imports once and treats a re-import as a refresh preserving notes and addedAt', async () => {
    const { domain, service } = await harness()
    const existing = {
      arxivId: ARXIV_ENTRY.id,
      title: 'Old Title',
      authors: ['Doe, Jane'],
      summary: 'old',
      url: 'https://arxiv.org/abs/2103.00020v2',
      notes: 'keep me',
      tags: [],
      projectIds: [],
      addedAt: '2026-01-01T00:00:00.000Z',
    }
    await domain.table('papers').put(existing.arxivId, existing)
    const refresh = await service.importPaper({ entry: ARXIV_ENTRY })
    expect(refresh).toEqual({ ok: true, value: { imported: false } })
    expect(domain.table('papers').get(ARXIV_ENTRY.id)).toMatchObject({
      title: ARXIV_ENTRY.title,
      notes: 'keep me',
      addedAt: '2026-01-01T00:00:00.000Z',
    })
    const fresh = await service.importPaper({ entry: { ...ARXIV_ENTRY, id: '2608.00001v1' } })
    expect(fresh).toEqual({ ok: true, value: { imported: true } })
    const listed = await service.listPapers()
    expect(listed.ok && listed.value.papers.length).toBe(2)
  })

  it('rejects an entry with an empty id or title as invalid-input', async () => {
    const { service } = await harness()
    await expect(service.importPaper({ entry: { ...ARXIV_ENTRY, id: '  ' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.importPaper({ entry: { ...ARXIV_ENTRY, title: '' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('rejects an entry whose id could escape the pdf cache directory', async () => {
    const { service } = await harness()
    for (const id of ['../escape', '/abs/path', 'a b', '..', 'id;rm']) {
      await expect(service.importPaper({ entry: { ...ARXIV_ENTRY, id } }))
        .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    }
  })

  it('removes a remembered paper and reports paper-not-found on a repeat', async () => {
    const { service } = await harness()
    await service.importPaper({ entry: ARXIV_ENTRY })
    await expect(service.removePaper({ arxivId: ARXIV_ENTRY.id }))
      .resolves.toEqual({ ok: true, value: { arxivId: ARXIV_ENTRY.id } })
    const listed = await service.listPapers()
    expect(listed).toEqual({ ok: true, value: { papers: [] } })
    await expect(service.removePaper({ arxivId: ARXIV_ENTRY.id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'paper-not-found' } })
  })
})

describe('ResearchService.fetchPaperPdf', () => {
  /** Minimal PDF-ish payload for the stubbed download. */
  const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

  it('downloads the PDF into the workspace and links it on the record', async () => {
    let requestedUrl = ''
    vi.stubGlobal('fetch', async (url: string) => {
      requestedUrl = url
      return new Response(PDF_BYTES, { status: 200 })
    })
    const { domain, workspaceDir, service } = await harness()
    await service.importPaper({ entry: ARXIV_ENTRY })
    const outcome = await service.fetchPaperPdf({ arxivId: ARXIV_ENTRY.id })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(requestedUrl).toBe(`https://arxiv.org/pdf/${ARXIV_ENTRY.id}`)
    expect(outcome.value.paper.pdfPath).toBe('papers/2103.00020v2.pdf')
    const stored = await readFile(join(workspaceDir, 'papers', '2103.00020v2.pdf'))
    expect(new Uint8Array(stored)).toEqual(PDF_BYTES)
    expect(domain.table('papers').get(ARXIV_ENTRY.id)?.pdfPath).toBe('papers/2103.00020v2.pdf')
  })

  it('reports paper-not-found for an unknown id and never fetches', async () => {
    let fetches = 0
    vi.stubGlobal('fetch', async () => {
      fetches += 1
      return new Response(PDF_BYTES, { status: 200 })
    })
    const { service } = await harness()
    await expect(service.fetchPaperPdf({ arxivId: 'nope' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'paper-not-found' } })
    expect(fetches).toBe(0)
  })

  it('rejects a traversal id as invalid-input before the lookup and any fetch', async () => {
    let fetches = 0
    vi.stubGlobal('fetch', async () => {
      fetches += 1
      return new Response(PDF_BYTES, { status: 200 })
    })
    const { service } = await harness()
    // encodeURIComponent does not encode '.', so '..' would slip past the
    // filename mapping — the id itself must be validated first.
    await expect(service.fetchPaperPdf({ arxivId: '../../etc/passwd' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fetches).toBe(0)
  })

  it('settles HTTP and transport failures as operation-failed without touching the record', async () => {
    const { domain, service } = await harness()
    await service.importPaper({ entry: ARXIV_ENTRY })
    vi.stubGlobal('fetch', async () => new Response('busy', { status: 404 }))
    await expect(service.fetchPaperPdf({ arxivId: ARXIV_ENTRY.id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', message: expect.stringContaining('HTTP 404') } })
    vi.stubGlobal('fetch', async () => { throw new Error('socket hangup') })
    await expect(service.fetchPaperPdf({ arxivId: ARXIV_ENTRY.id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', message: 'socket hangup' } })
    expect(domain.table('papers').get(ARXIV_ENTRY.id)?.pdfPath).toBeUndefined()
  })

  it('rejects non-PDF and declared over-cap bodies without touching the record', async () => {
    const { domain, service } = await harness()
    await service.importPaper({ entry: ARXIV_ENTRY })
    vi.stubGlobal('fetch', async () => new Response('<html>rate limited</html>', { status: 200 }))
    await expect(service.fetchPaperPdf({ arxivId: ARXIV_ENTRY.id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', message: expect.stringContaining('non-PDF') } })
    vi.stubGlobal('fetch', async () => new Response(PDF_BYTES, {
      status: 200,
      headers: { 'content-length': String(ARXIV_PDF_MAX_BYTES + 1) },
    }))
    await expect(service.fetchPaperPdf({ arxivId: ARXIV_ENTRY.id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'operation-failed', message: expect.stringContaining('exceeds') } })
    expect(domain.table('papers').get(ARXIV_ENTRY.id)?.pdfPath).toBeUndefined()
  })

  it('rejects an unsafe arXiv id before any request', async () => {
    let fetches = 0
    vi.stubGlobal('fetch', async () => {
      fetches += 1
      return new Response(PDF_BYTES, { status: 200 })
    })
    const { domain, service } = await harness()
    await domain.table('papers').put('bad id', {
      arxivId: 'bad id',
      title: 'Bad',
      authors: [],
      summary: '',
      url: '',
      notes: '',
      tags: [],
      projectIds: [],
      addedAt: '2026-08-20T00:00:00.000Z',
    })
    // A space-bearing id fails the safety check before any URL conversion.
    await expect(service.fetchPaperPdf({ arxivId: 'bad id' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: expect.stringContaining('unsafe arXiv id') } })
    expect(fetches).toBe(0)
  })
})

describe('paperPdfFileName', () => {
  it('keeps old-style slash ids distinct from ids containing underscores', () => {
    expect(paperPdfFileName('hep-th/9901001')).toBe('hep-th%2F9901001.pdf')
    expect(paperPdfFileName('hep-th_9901001')).toBe('hep-th_9901001.pdf')
    expect(paperPdfFileName('hep-th/9901001')).not.toBe(paperPdfFileName('hep-th_9901001'))
  })
})

describe('ResearchService.deleteExperiment', () => {
  it('deletes one experiment and reports experiment-not-found on a repeat', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('experiments').put('e1', {
      id: 'e1',
      projectId: PROJECT.id,
      name: 'bhx-base',
      status: 'success',
      metrics: { mpjpe: 92.4 },
      updatedAt: '2026-08-10T00:00:00.000Z',
    })
    await expect(service.deleteExperiment({ id: 'e1' })).resolves.toEqual({ ok: true, value: { id: 'e1' } })
    await expect(service.listExperiments({ projectId: PROJECT.id }))
      .resolves.toEqual({ ok: true, value: { experiments: [] } })
    await expect(service.deleteExperiment({ id: 'e1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'experiment-not-found', id: 'e1' } })
  })

  it('does not touch other projects\u2019 experiments', async () => {
    const { domain, service } = await harness()
    await domain.table('experiments').put('e1', {
      id: 'e1',
      projectId: 'other',
      name: 'keep-me',
      status: 'running',
      metrics: {},
      updatedAt: '2026-08-10T00:00:00.000Z',
    })
    await expect(service.deleteExperiment({ id: 'missing' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'experiment-not-found', id: 'missing' } })
    const listed = await service.listExperiments({})
    expect(listed).toMatchObject({ ok: true, value: { experiments: [{ id: 'e1' }] } })
  })
})

describe('ResearchService.listProjects', () => {
  /**
   * Mirror of the typert gateway's `assertJsonValue` boundary check (it is
   * not exported from `@deepseek-ai/dsh-api-gateway`, and that package is
   * not a dependency of this one): rejects undefined values, non-finite
   * numbers, cyclic graphs, sparse/decorated arrays, and non-plain objects.
   * A view passing this survives the gateway's post-schema JSON validation.
   */
  function assertJsonSafe(value: unknown, ancestors = new Set<object>()): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number') {
      if (Number.isFinite(value)) return
      throw new TypeError('non-finite number is not JSON-safe')
    }
    if (typeof value !== 'object') throw new TypeError(`${typeof value} is not JSON-safe`)
    if (ancestors.has(value)) throw new TypeError('cyclic value is not JSON-safe')
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        if (Object.getOwnPropertySymbols(value).length > 0 || Object.keys(value).length !== value.length) {
          throw new TypeError('sparse or decorated array is not JSON-safe')
        }
        for (let index = 0; index < value.length; index += 1) assertJsonSafe(value[index], ancestors)
        return
      }
      const prototype = Object.getPrototypeOf(value) as object | null
      if (prototype !== null && prototype !== Object.prototype) throw new TypeError('non-plain object is not JSON-safe')
      if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('symbol property is not JSON-safe')
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('non-data property is not JSON-safe')
        }
        assertJsonSafe(descriptor.value, ancestors)
      }
    } finally {
      ancestors.delete(value)
    }
  }

  it('produces gateway-JSON-safe views for records with unset optional keys', async () => {
    const { domain, service } = await harness()
    // The boundary failure mode behind "business result failed boundary
    // validation": key absence must hold for EVERY optional view field, so
    // simulate the gateway's own check rather than asserting one key.
    await domain.table('projects').put('p-bare', {
      id: 'p-bare',
      title: 'Bare idea-stage project',
      stage: 'idea',
      artifacts: [],
      reviewRounds: 0,
      updatedAt: '2026-08-28T00:00:00.000Z',
    })
    const listed = await service.listProjects()
    if (!listed.ok) throw new Error('list failed')
    const bare = listed.value.projects.find(project => project.id === 'p-bare')
    expect(bare).toBeDefined()
    expect('paperDir' in bare!).toBe(false)
    expect('venue' in bare!).toBe(false)
    expect(() => { assertJsonSafe(listed.value) }).not.toThrow()
    // Sanity: the mirror actually rejects the regression shape.
    expect(() => { assertJsonSafe({ projects: [{ id: 'x', paperDir: undefined }] }) }).toThrow(/not JSON-safe/)
  })

  it('omits paperDir from a project view when the record never set one', async () => {
    const { domain, service } = await harness()
    // A project created by research-idea has no paperDir yet. The view must
    // OMIT the key: an explicit `undefined` trips the gateway's JSON
    // boundary validation and fails the whole list call (observed as
    // "项目列表加载失败" in the panel).
    await domain.table('projects').put('p-no-dir', {
      id: 'p-no-dir',
      title: 'Idea-stage project',
      stage: 'idea',
      artifacts: ['IDEA_REPORT.md'],
      reviewRounds: 0,
      updatedAt: '2026-08-24T00:00:00.000Z',
    })
    await domain.table('projects').put('p-with-dir', {
      id: 'p-with-dir',
      title: 'Writing-stage project',
      stage: 'writing',
      paperDir: 'paper',
      artifacts: ['paper/main.tex'],
      reviewRounds: 1,
      updatedAt: '2026-08-20T00:00:00.000Z',
    })
    const listed = await service.listProjects()
    if (!listed.ok) throw new Error('list failed')
    expect(listed.value.projects.length).toBe(2)
    const idea = listed.value.projects.find(project => project.id === 'p-no-dir')
    expect(idea).toBeDefined()
    expect('paperDir' in idea!).toBe(false)
    const writing = listed.value.projects.find(project => project.id === 'p-with-dir')
    expect(writing?.paperDir).toBe('paper')
  })
})

describe('ResearchService.updateExperiment', () => {
  /** Seed one experiment and one server. */
  async function seed(h: Awaited<ReturnType<typeof harness>>) {
    await h.domain.table('experiments').put('e1', {
      id: 'e1',
      projectId: PROJECT.id,
      name: 'bhx-base',
      status: 'success',
      metrics: { mpjpe: 92.4 },
      updatedAt: '2026-08-10T00:00:00.000Z',
    })
    const created = await h.service.saveServer({ server: SERVER_INPUT })
    if (!created.ok) throw new Error('create failed')
    return created.value.server.id
  }

  it('links, relinks, and clears the server of one experiment', async () => {
    const h = await harness()
    const serverId = await seed(h)
    const linked = await h.service.updateExperiment({ id: 'e1', serverId })
    expect(linked).toMatchObject({ ok: true, value: { experiment: { id: 'e1', serverId } } })
    const cleared = await h.service.updateExperiment({ id: 'e1', serverId: null })
    expect(cleared).toMatchObject({ ok: true, value: { experiment: { id: 'e1' } } })
    if (cleared.ok) expect(cleared.value.experiment.serverId).toBeUndefined()
    // The stored record carries no serverId key after a clear.
    expect('serverId' in h.domain.table('experiments').get('e1')!).toBe(false)
    // An omitted serverId is a no-op.
    const untouched = await h.service.updateExperiment({ id: 'e1' })
    expect(untouched).toMatchObject({ ok: true, value: { experiment: { id: 'e1', name: 'bhx-base' } } })
  })

  it('rejects an unknown server as invalid-input and keeps the old link', async () => {
    const h = await harness()
    const serverId = await seed(h)
    await h.service.updateExperiment({ id: 'e1', serverId })
    await expect(h.service.updateExperiment({ id: 'e1', serverId: 'srv-missing' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(h.domain.table('experiments').get('e1')?.serverId).toBe(serverId)
  })

  it('reports experiment-not-found for an unknown id', async () => {
    const h = await harness()
    await expect(h.service.updateExperiment({ id: 'missing', serverId: null }))
      .resolves.toMatchObject({ ok: false, error: { code: 'experiment-not-found', id: 'missing' } })
  })
})

describe('ResearchService.updatePaper', () => {
  /** Seed one paper with organization fields already set. */
  async function seedPaper(domain: Awaited<ReturnType<typeof harness>>['domain']) {
    await domain.table('papers').put(ARXIV_ENTRY.id, {
      arxivId: ARXIV_ENTRY.id,
      title: ARXIV_ENTRY.title,
      authors: [...ARXIV_ENTRY.authors],
      summary: ARXIV_ENTRY.summary,
      url: ARXIV_ENTRY.url,
      notes: 'existing notes',
      tags: ['baseline'],
      projectIds: [],
      addedAt: '2026-08-01T00:00:00.000Z',
    })
  }

  it('replaces only the provided fields and cleans tags up', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await seedPaper(domain)
    const outcome = await service.updatePaper({
      arxivId: ARXIV_ENTRY.id,
      tags: [' mesh-recovery ', 'baseline', '', 'mesh-recovery'],
      projectIds: [PROJECT.id],
    })
    expect(outcome).toMatchObject({
      ok: true,
      value: { paper: { tags: ['mesh-recovery', 'baseline'], projectIds: ['p1'], notes: 'existing notes' } },
    })
    expect(domain.table('papers').get(ARXIV_ENTRY.id)?.tags).toEqual(['mesh-recovery', 'baseline'])
    // Notes untouched by a partial update that omits them.
    const notesOnly = await service.updatePaper({ arxivId: ARXIV_ENTRY.id, notes: 'new notes' })
    expect(notesOnly).toMatchObject({ ok: true, value: { paper: { notes: 'new notes', tags: ['mesh-recovery', 'baseline'] } } })
  })

  it('reports paper-not-found for an unknown arXiv id', async () => {
    const { service } = await harness()
    await expect(service.updatePaper({ arxivId: 'nope', tags: ['x'] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'paper-not-found' } })
  })

  it('rejects links to unknown projects without touching the record', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await seedPaper(domain)
    await expect(service.updatePaper({ arxivId: ARXIV_ENTRY.id, projectIds: [PROJECT.id, 'ghost'] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'unknown project: ghost' } })
    expect(domain.table('papers').get(ARXIV_ENTRY.id)?.projectIds).toEqual([])
  })

  it('re-import refreshes metadata but preserves tags, projectIds, and notes', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await service.importPaper({ entry: ARXIV_ENTRY })
    await service.updatePaper({ arxivId: ARXIV_ENTRY.id, tags: ['egocentric'], projectIds: [PROJECT.id], notes: 'read it' })
    const again = await service.importPaper({ entry: { ...ARXIV_ENTRY, title: 'New Title' } })
    expect(again).toEqual({ ok: true, value: { imported: false } })
    const stored = domain.table('papers').get(ARXIV_ENTRY.id)
    expect(stored).toMatchObject({ title: 'New Title', tags: ['egocentric'], projectIds: ['p1'], notes: 'read it' })
  })
})

describe('ResearchService bibliography remotes', () => {
  /** Seed two remembered papers and the scaffolded paper directory. */
  async function seedBibFixture(domain: Awaited<ReturnType<typeof harness>>['domain'], workspaceDir: string) {
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await mkdir(join(workspaceDir, 'paper'), { recursive: true })
    await domain.table('papers').put(ARXIV_ENTRY.id, {
      arxivId: ARXIV_ENTRY.id,
      title: ARXIV_ENTRY.title,
      authors: [...ARXIV_ENTRY.authors],
      summary: ARXIV_ENTRY.summary,
      url: ARXIV_ENTRY.url,
      notes: 'baseline notes',
      tags: [],
      projectIds: [],
      addedAt: '2026-08-01T00:00:00.000Z',
    })
    await domain.table('papers').put('1812.01187v1', {
      arxivId: '1812.01187v1',
      title: 'EgoHMR',
      authors: ['Zhang, Wei'],
      summary: '…',
      url: '',
      notes: '',
      tags: [],
      projectIds: [],
      addedAt: '2026-08-02T00:00:00.000Z',
    })
  }

  const BIB_TEXT = '@article{vaswani2017,\n  title = {Attention Is All You Need},\n  year = {2017},\n}\n'

  it('getBibliography reads an absent file as a successful empty list with a null mtime', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedBibFixture(domain, workspaceDir)
    const outcome = await service.getBibliography({ projectId: 'p1' })
    expect(outcome).toEqual({ ok: true, value: { entries: [], mtimeMs: null } })
    await expect(service.getBibliography({ projectId: 'ghost' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
  })

  it('getBibliography parses an existing file and carries its mtime', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedBibFixture(domain, workspaceDir)
    await writeFile(join(workspaceDir, 'paper', 'references.bib'), BIB_TEXT)
    const outcome = await service.getBibliography({ projectId: 'p1' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.entries).toEqual([
      { key: 'vaswani2017', type: 'article', fields: { title: 'Attention Is All You Need', year: '2017' } },
    ])
    expect(outcome.value.mtimeMs).toBe((await stat(join(workspaceDir, 'paper', 'references.bib'))).mtimeMs)
  })

  it('saveBibliography creates an absent file only with a null base, else conflicts', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedBibFixture(domain, workspaceDir)
    const bibPath = join(workspaceDir, 'paper', 'references.bib')
    const created = await service.saveBibliography({
      projectId: 'p1',
      entries: [{ key: 'a', type: 'misc', fields: { title: 'T' } }],
      baseMtimeMs: null,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const text = await readFile(bibPath, 'utf8')
    expect(text).toBe('@misc{a,\n  title = {T},\n}\n')
    // A second create-only save now conflicts (the file exists).
    await expect(service.saveBibliography({ projectId: 'p1', entries: [], baseMtimeMs: null }))
      .resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
    // Saving on the committed base works; a stale base conflicts.
    const saved = await service.saveBibliography({ projectId: 'p1', entries: [], baseMtimeMs: created.value.mtimeMs })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(await readFile(bibPath, 'utf8')).toBe('')
    // A third party writes after the base: the mtime is moved EXPLICITLY,
    // because on coarse-granularity filesystems (and some sandboxes with
    // pinned timestamps) two quick commits share one mtime, which would make
    // the stale base indistinguishable from a fresh one.
    const displacedAt = new Date(created.value.mtimeMs + 20_000)
    await utimes(bibPath, displacedAt, displacedAt)
    const displaced = (await stat(bibPath)).mtimeMs
    expect(displaced).not.toBe(created.value.mtimeMs)
    await expect(service.saveBibliography({ projectId: 'p1', entries: [], baseMtimeMs: created.value.mtimeMs }))
      .resolves.toMatchObject({ ok: false, error: { code: 'conflict', currentMtimeMs: displaced } })
  })

  it('saveBibliography reports bib-not-found when a based-on file is gone', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedBibFixture(domain, workspaceDir)
    await expect(service.saveBibliography({ projectId: 'p1', entries: [], baseMtimeMs: 12345 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bib-not-found' } })
    // And the paper directory itself must exist.
    const { domain: domain2, service: service2 } = await harness()
    await domain2.table('projects').put(PROJECT.id, PROJECT)
    await expect(service2.saveBibliography({ projectId: 'p1', entries: [], baseMtimeMs: null }))
      .resolves.toMatchObject({ ok: false, error: { code: 'paper-not-found' } })
  })

  it('importPapersToBib appends new keys, skips existing ones, and round-trips the file', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedBibFixture(domain, workspaceDir)
    const first = await service.importPapersToBib({ projectId: 'p1', arxivIds: [ARXIV_ENTRY.id, '1812.01187v1'] })
    expect(first).toEqual({ ok: true, value: { added: ['210300020v2', '181201187v1'], skipped: [] } })
    const text = await readFile(join(workspaceDir, 'paper', 'references.bib'), 'utf8')
    expect(text).toContain('@misc{210300020v2,')
    expect(text).toContain('eprint = {2103.00020v2}')
    expect(text).toContain('note = {baseline notes}')
    // url falls back to the arXiv abs page when the record carries none.
    expect(text).toContain('url = {https://arxiv.org/abs/1812.01187v1}')
    // A repeat import skips both; a mix adds only the new one.
    const again = await service.importPapersToBib({ projectId: 'p1', arxivIds: [ARXIV_ENTRY.id] })
    expect(again).toEqual({ ok: true, value: { added: [], skipped: ['210300020v2'] } })
    const listed = await service.getBibliography({ projectId: 'p1' })
    expect(listed.ok && listed.value.entries.map(entry => entry.key)).toEqual(['210300020v2', '181201187v1'])
  })

  it('importPapersToBib rejects an unknown arXiv id without writing anything', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedBibFixture(domain, workspaceDir)
    await expect(service.importPapersToBib({ projectId: 'p1', arxivIds: [ARXIV_ENTRY.id, 'ghost'] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'paper-not-found' } })
    await expect(service.getBibliography({ projectId: 'p1' }))
      .resolves.toEqual({ ok: true, value: { entries: [], mtimeMs: null } })
  })
})

describe('ResearchService.reorderPaperSections', () => {
  const TEX = [
    '\\documentclass{article}',
    '',
    '\\begin{document}',
    '',
    '\\section{Introduction}',
    'Intro.',
    '',
    '\\section{Method}',
    '\\subsection{Arch}',
    'Method body.',
    '',
    '\\section{Experiments}',
    'Experiments body.',
    '',
    '\\end{document}',
    '',
  ].join('\n')

  /** Seed the project and write the fixture main.tex. */
  async function seedPaper(domain: Awaited<ReturnType<typeof harness>>['domain'], workspaceDir: string) {
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await mkdir(join(workspaceDir, 'paper'), { recursive: true })
    await writeFile(join(workspaceDir, 'paper', 'main.tex'), TEX)
  }

  it('moves one section, rewrites the file, and returns the new mtime', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedPaper(domain, workspaceDir)
    const outcome = await service.reorderPaperSections({
      projectId: 'p1',
      moves: [{ title: 'Method', targetIndex: 0 }],
      baseOutline: ['Introduction', 'Method', 'Experiments'],
    })
    expect(outcome.ok).toBe(true)
    const text = await readFile(join(workspaceDir, 'paper', 'main.tex'), 'utf8')
    const methodAt = text.indexOf('\\section{Method}')
    expect(methodAt).toBeLessThan(text.indexOf('\\section{Introduction}'))
    // The subsection rode along; the preamble and the tail are untouched.
    expect(text).toContain('\\subsection{Arch}')
    expect(text.startsWith('\\documentclass{article}\n\n\\begin{document}\n\n')).toBe(true)
    expect(text.endsWith('\\end{document}\n')).toBe(true)
  })

  it('rejects with conflict when the file outline drifted from baseOutline', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedPaper(domain, workspaceDir)
    await expect(service.reorderPaperSections({
      projectId: 'p1',
      moves: [{ title: 'Method', targetIndex: 0 }],
      baseOutline: ['Introduction', 'Method'],
    })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
    // Nothing was written.
    expect(await readFile(join(workspaceDir, 'paper', 'main.tex'), 'utf8')).toBe(TEX)
  })

  it('rejects an unknown section title and a bad target index', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedPaper(domain, workspaceDir)
    const base = ['Introduction', 'Method', 'Experiments']
    await expect(service.reorderPaperSections({
      projectId: 'p1', moves: [{ title: 'Ghost', targetIndex: 0 }], baseOutline: base,
    })).resolves.toMatchObject({ ok: false, error: { code: 'section-not-found', title: 'Ghost' } })
    await expect(service.reorderPaperSections({
      projectId: 'p1', moves: [{ title: 'Method', targetIndex: 9 }], baseOutline: base,
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(await readFile(join(workspaceDir, 'paper', 'main.tex'), 'utf8')).toBe(TEX)
  })

  it('reports paper-not-found and project-not-found', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedPaper(domain, workspaceDir)
    await expect(service.reorderPaperSections({
      projectId: 'ghost', moves: [], baseOutline: [],
    })).resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
    await domain.table('projects').put('p2', { ...PROJECT, id: 'p2', paperDir: 'paper-p2' })
    await expect(service.reorderPaperSections({
      projectId: 'p2', moves: [], baseOutline: [],
    })).resolves.toMatchObject({ ok: false, error: { code: 'paper-not-found' } })
  })
})

describe('ResearchService.reorderPaperSubsections', () => {
  const TEX = [
    '\\documentclass{article}',
    '',
    '\\begin{document}',
    '',
    '\\section{Introduction}',
    'Intro.',
    '\\subsection{Background}',
    'Background body.',
    '',
    '\\section{Method}',
    '\\subsection{Arch}',
    'Arch body.',
    '\\subsection{Training}',
    'Training body.',
    '',
    '\\section{Experiments}',
    'Experiments body.',
    '',
    '\\end{document}',
    '',
  ].join('\n')

  const BASE = [
    { title: 'Introduction', subsections: ['Background'] },
    { title: 'Method', subsections: ['Arch', 'Training'] },
    { title: 'Experiments', subsections: [] },
  ]

  /** Seed the project and write the fixture main.tex. */
  async function seedPaper(domain: Awaited<ReturnType<typeof harness>>['domain'], workspaceDir: string) {
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await mkdir(join(workspaceDir, 'paper'), { recursive: true })
    await writeFile(join(workspaceDir, 'paper', 'main.tex'), TEX)
  }

  it('moves a subsection within its section and across sections', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedPaper(domain, workspaceDir)
    const within = await service.reorderPaperSubsections({
      projectId: 'p1',
      moves: [{ sectionTitle: 'Method', title: 'Training', targetSectionTitle: 'Method', targetIndex: 0 }],
      baseOutline: BASE,
    })
    expect(within.ok).toBe(true)
    let text = await readFile(join(workspaceDir, 'paper', 'main.tex'), 'utf8')
    expect(text.indexOf('\\subsection{Training}')).toBeLessThan(text.indexOf('\\subsection{Arch}'))

    const across = await service.reorderPaperSubsections({
      projectId: 'p1',
      moves: [{ sectionTitle: 'Method', title: 'Arch', targetSectionTitle: 'Introduction', targetIndex: 1 }],
      baseOutline: [
        { title: 'Introduction', subsections: ['Background'] },
        { title: 'Method', subsections: ['Training', 'Arch'] },
        { title: 'Experiments', subsections: [] },
      ],
    })
    expect(across.ok).toBe(true)
    text = await readFile(join(workspaceDir, 'paper', 'main.tex'), 'utf8')
    const introAt = text.indexOf('\\section{Introduction}')
    const methodAt = text.indexOf('\\section{Method}')
    expect(text.indexOf('\\subsection{Arch}')).toBeGreaterThan(introAt)
    expect(text.indexOf('\\subsection{Arch}')).toBeLessThan(methodAt)
    // The preamble and the document tail are untouched.
    expect(text.startsWith('\\documentclass{article}\n\n\\begin{document}\n\n')).toBe(true)
    expect(text.endsWith('\\end{document}\n')).toBe(true)
  })

  it('rejects with conflict when the file tree drifted from baseOutline', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedPaper(domain, workspaceDir)
    // A stale subsection list (Training missing) must conflict.
    await expect(service.reorderPaperSubsections({
      projectId: 'p1',
      moves: [{ sectionTitle: 'Method', title: 'Training', targetSectionTitle: 'Method', targetIndex: 0 }],
      baseOutline: [
        { title: 'Introduction', subsections: ['Background'] },
        { title: 'Method', subsections: ['Arch'] },
        { title: 'Experiments', subsections: [] },
      ],
    })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } })
    expect(await readFile(join(workspaceDir, 'paper', 'main.tex'), 'utf8')).toBe(TEX)
  })

  it('rejects unknown sections, unknown subsections, and bad target indices', async () => {
    const { domain, workspaceDir, service } = await harness()
    await seedPaper(domain, workspaceDir)
    await expect(service.reorderPaperSubsections({
      projectId: 'p1',
      moves: [{ sectionTitle: 'Ghost', title: 'X', targetSectionTitle: 'Method', targetIndex: 0 }],
      baseOutline: BASE,
    })).resolves.toMatchObject({ ok: false, error: { code: 'section-not-found', title: 'Ghost' } })
    // With a matching baseOutline the move itself fails closed.
    await expect(service.reorderPaperSubsections({
      projectId: 'p1',
      moves: [{ sectionTitle: 'Method', title: 'Ghost', targetSectionTitle: 'Method', targetIndex: 0 }],
      baseOutline: BASE,
    })).resolves.toMatchObject({ ok: false, error: { code: 'subsection-not-found', sectionTitle: 'Method', title: 'Ghost' } })
    await expect(service.reorderPaperSubsections({
      projectId: 'p1',
      moves: [{ sectionTitle: 'Method', title: 'Arch', targetSectionTitle: 'Method', targetIndex: 9 }],
      baseOutline: BASE,
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(await readFile(join(workspaceDir, 'paper', 'main.tex'), 'utf8')).toBe(TEX)
  })
})

describe('ResearchService.saveExperiment', () => {
  /** Seed the owning project and one server; returns the server id. */
  async function seed(h: Awaited<ReturnType<typeof harness>>) {
    await h.domain.table('projects').put(PROJECT.id, PROJECT)
    const created = await h.service.saveServer({ server: SERVER_INPUT })
    if (!created.ok) throw new Error('create failed')
    return created.value.server.id
  }

  it('creates with a fresh exp- id and stores the full payload', async () => {
    const h = await harness()
    const serverId = await seed(h)
    const created = await h.service.saveExperiment({
      experiment: {
        projectId: PROJECT.id,
        name: 'bhx-v2',
        status: 'running',
        metrics: { mpjpe: 88.1, note: 'warmup' },
        serverId,
      },
    })
    expect(created).toMatchObject({
      ok: true,
      value: {
        experiment: {
          projectId: PROJECT.id, name: 'bhx-v2', status: 'running',
          metrics: { mpjpe: 88.1, note: 'warmup' }, serverId,
        },
      },
    })
    if (!created.ok) throw new Error('unreachable')
    expect(created.value.experiment.id).toMatch(/^exp-/)
    expect(typeof created.value.experiment.updatedAt).toBe('string')
    const listed = await h.service.listExperiments({ projectId: PROJECT.id })
    expect(listed).toMatchObject({ ok: true, value: { experiments: [{ id: created.value.experiment.id }] } })
  })

  it('updates an existing record in place and refreshes updatedAt', async () => {
    const h = await harness()
    await seed(h)
    await h.domain.table('experiments').put('e1', {
      id: 'e1',
      projectId: PROJECT.id,
      name: 'bhx-base',
      status: 'running',
      metrics: { mpjpe: 99 },
      updatedAt: '2026-08-10T00:00:00.000Z',
    })
    const updated = await h.service.saveExperiment({
      experiment: { id: 'e1', projectId: PROJECT.id, name: 'bhx-base-v2', status: 'success', metrics: { mpjpe: 92.4 } },
    })
    expect(updated).toMatchObject({
      ok: true,
      value: { experiment: { id: 'e1', name: 'bhx-base-v2', status: 'success', metrics: { mpjpe: 92.4 } } },
    })
    if (!updated.ok) throw new Error('unreachable')
    expect(updated.value.experiment.updatedAt > '2026-08-10T00:00:00.000Z').toBe(true)
    expect(h.domain.table('experiments').get('e1')?.name).toBe('bhx-base-v2')
  })

  it('rejects an unknown project as project-not-found', async () => {
    const h = await harness()
    await expect(h.service.saveExperiment({
      experiment: { projectId: 'missing', name: 'run', status: 'running', metrics: {} },
    })).resolves.toMatchObject({ ok: false, error: { code: 'project-not-found', projectId: 'missing' } })
  })

  it('rejects an empty name, a bad status, and bad metrics as invalid-input', async () => {
    const h = await harness()
    await seed(h)
    await expect(h.service.saveExperiment({
      experiment: { projectId: PROJECT.id, name: '  ', status: 'running', metrics: {} },
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(h.service.saveExperiment({
      experiment: { projectId: PROJECT.id, name: 'run', status: 'done' as 'running', metrics: {} },
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(h.service.saveExperiment({
      experiment: { projectId: PROJECT.id, name: 'run', status: 'running', metrics: { '': 1 } },
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(h.service.saveExperiment({
      experiment: { projectId: PROJECT.id, name: 'run', status: 'running', metrics: { acc: true as unknown as number } },
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('rejects an unknown serverId as invalid-input', async () => {
    const h = await harness()
    await seed(h)
    await expect(h.service.saveExperiment({
      experiment: { projectId: PROJECT.id, name: 'run', status: 'running', metrics: {}, serverId: 'srv-missing' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(h.domain.table('experiments').get('exp-missing')).toBeUndefined()
  })

  it('reports experiment-not-found when updating an unknown id', async () => {
    const h = await harness()
    await seed(h)
    await expect(h.service.saveExperiment({
      experiment: { id: 'missing', projectId: PROJECT.id, name: 'run', status: 'running', metrics: {} },
    })).resolves.toMatchObject({ ok: false, error: { code: 'experiment-not-found', id: 'missing' } })
  })

  it('omits unset optional keys instead of writing undefined values', async () => {
    const h = await harness()
    await seed(h)
    // `undefined` values would trip the gateway's JSON boundary validation and
    // pollute the stored record, so optional fields must be absent, not undefined.
    const created = await h.service.saveExperiment({
      experiment: { projectId: PROJECT.id, name: 'local-run', status: 'running', metrics: {} },
    })
    if (!created.ok) throw new Error('create failed')
    expect('logPath' in created.value.experiment).toBe(false)
    expect('serverId' in created.value.experiment).toBe(false)
    expect('logPath' in h.domain.table('experiments').get(created.value.experiment.id)!).toBe(false)
  })

  it('keeps the existing serverId when an update does not pass one', async () => {
    const h = await harness()
    const serverId = await seed(h)
    await h.domain.table('experiments').put('e1', {
      id: 'e1',
      projectId: PROJECT.id,
      name: 'bhx-base',
      status: 'running',
      metrics: {},
      serverId,
      updatedAt: '2026-08-10T00:00:00.000Z',
    })
    const updated = await h.service.saveExperiment({
      experiment: { id: 'e1', projectId: PROJECT.id, name: 'bhx-base', status: 'success', metrics: {} },
    })
    if (!updated.ok) throw new Error('unreachable')
    expect(updated.value.experiment.serverId).toBe(serverId)
  })
})

describe('ResearchService arXiv subscriptions (facade)', () => {
  it('saves, checks (baseline seeding over a stubbed feed), lists, and deletes', async () => {
    let requestedUrl = ''
    vi.stubGlobal('fetch', async (url: string) => {
      requestedUrl = url
      return new Response(ARXIV_FEED, { status: 200 })
    })
    const { service } = await harness()
    await expect(service.saveArxivSubscription({ query: '  ' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    const saved = await service.saveArxivSubscription({ query: 'egocentric whole body' })
    if (!saved.ok) throw new Error('unreachable')
    const id = saved.value.subscription.id
    // The first check only seeds the baseline: seen, but nothing new.
    const checked = await service.checkArxivSubscriptions({ id })
    if (!checked.ok) throw new Error('unreachable')
    expect(checked.value.checks).toHaveLength(1)
    expect(checked.value.checks[0]).toMatchObject({ added: [], error: null })
    expect(checked.value.checks[0]?.subscription.lastCheckedAt).not.toBeNull()
    expect(requestedUrl).toContain('sortBy=submittedDate&sortOrder=descending')
    const listed = await service.listArxivSubscriptions()
    if (!listed.ok) throw new Error('unreachable')
    expect(listed.value.subscriptions).toMatchObject([{ id, query: 'egocentric whole body', newEntries: [] }])
    await expect(service.checkArxivSubscriptions({ id: 'nope' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'subscription-not-found' } })
    await expect(service.deleteArxivSubscription({ id })).resolves.toEqual({ ok: true, value: { id } })
    const empty = await service.listArxivSubscriptions()
    expect(empty.ok && empty.value.subscriptions.length).toBe(0)
  })

  it('surfaces a newly published entry with its details on the second check', async () => {
    const { service } = await harness()
    const saved = await service.saveArxivSubscription({ query: 'mesh' })
    if (!saved.ok) throw new Error('unreachable')
    const id = saved.value.subscription.id
    // First check seeds the baseline (empty feed), the second surfaces one.
    vi.stubGlobal('fetch', async () => new Response(
      '<feed xmlns="http://www.w3.org/2005/Atom"></feed>', { status: 200 },
    ))
    await service.checkArxivSubscriptions({ id })
    vi.stubGlobal('fetch', async () => new Response(ARXIV_FEED, { status: 200 }))
    const checked = await service.checkArxivSubscriptions({ id })
    if (!checked.ok) throw new Error('unreachable')
    expect(checked.value.checks[0]?.added).toEqual([ARXIV_ENTRY])
    const listed = await service.listArxivSubscriptions()
    if (!listed.ok) throw new Error('unreachable')
    expect(listed.value.subscriptions[0]?.newEntries).toEqual([ARXIV_ENTRY])
  })
})


describe('ResearchService.importPaper project link', () => {
  it('links a new import to the given project and keeps the link on re-import', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const first = await service.importPaper({ entry: ARXIV_ENTRY, projectId: 'p1' })
    expect(first).toEqual({ ok: true, value: { imported: true } })
    expect(domain.table('papers').get(ARXIV_ENTRY.id)?.projectIds).toEqual(['p1'])
    // A re-import without the project keeps the existing link and relevance.
    await service.updatePaper({
      arxivId: ARXIV_ENTRY.id,
      relevance: { projectId: 'p1', score: 8, reason: 'central' },
    })
    const again = await service.importPaper({ entry: ARXIV_ENTRY })
    expect(again).toEqual({ ok: true, value: { imported: false } })
    const stored = domain.table('papers').get(ARXIV_ENTRY.id)
    expect(stored?.projectIds).toEqual(['p1'])
    expect(stored?.relevance?.['p1']?.score).toBe(8)
  })

  it('rejects an unknown project id', async () => {
    const { service } = await harness()
    await expect(service.importPaper({ entry: ARXIV_ENTRY, projectId: 'nope' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
  })
})

describe('ResearchService.updatePaper relevance', () => {
  it('scores a paper against one project without touching other verdicts', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('projects').put('p2', { ...PROJECT, id: 'p2' })
    await service.importPaper({ entry: ARXIV_ENTRY })
    const scored = await service.updatePaper({
      arxivId: ARXIV_ENTRY.id,
      relevance: { projectId: 'p1', score: 8.5, reason: 'central to the direction' },
    })
    if (!scored.ok) throw new Error('unreachable')
    expect(scored.value.paper.relevance?.['p1']?.score).toBe(8.5)
    const rescored = await service.updatePaper({
      arxivId: ARXIV_ENTRY.id,
      relevance: { projectId: 'p2', score: 2, reason: 'peripheral there' },
    })
    if (!rescored.ok) throw new Error('unreachable')
    expect(rescored.value.paper.relevance?.['p1']?.score).toBe(8.5)
    expect(rescored.value.paper.relevance?.['p2']?.score).toBe(2)
  })

  it('rejects an out-of-range score and an unknown project', async () => {
    const { service } = await harness()
    await service.importPaper({ entry: ARXIV_ENTRY })
    await expect(service.updatePaper({
      arxivId: ARXIV_ENTRY.id,
      relevance: { projectId: 'p1', score: 11, reason: 'too high' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
    const { domain, service: service2 } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await service2.importPaper({ entry: ARXIV_ENTRY })
    await expect(service2.updatePaper({
      arxivId: ARXIV_ENTRY.id,
      relevance: { projectId: 'p1', score: 11, reason: 'too high' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service2.updatePaper({
      arxivId: ARXIV_ENTRY.id,
      relevance: { projectId: 'p1', score: Number.NaN, reason: 'not a number' },
    })).resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })
})

describe('ResearchService.renameFigure', () => {
  /** Scaffold a paper dir whose main.tex references the seeded figure. */
  async function scaffoldWithReference(workspaceDir: string): Promise<void> {
    await scaffoldPaper(workspaceDir)
    await mkdir(join(workspaceDir, 'paper', 'sections'), { recursive: true })
    await writeFile(
      join(workspaceDir, 'paper', 'main.tex'),
      '\\documentclass{article}\n\\begin{document}\n\\includegraphics[width=\\linewidth]{figures/plot.png}\n\\end{document}\n',
    )
    await writeFile(
      join(workspaceDir, 'paper', 'sections', 'results.tex'),
      '\\includegraphics{figures/plot}\n',
    )
  }

  it('renames the file, moves the metadata row, and rewrites .tex references', async () => {
    const { domain, workspaceDir, service } = await harness()
    await domain.table('projects').put(PROJECT.id, { ...PROJECT, artifacts: ['paper/figures/plot.png'] })
    await scaffoldWithReference(workspaceDir)
    await service.updateFigure({ projectId: 'p1', relPath: 'figures/plot.png', caption: 'Training loss' })
    const outcome = await service.renameFigure({ projectId: 'p1', relPath: 'figures/plot.png', newName: 'loss-curve.png' })
    expect(outcome).toEqual({ ok: true, value: { relPath: 'figures/loss-curve.png', references: 2 } })
    // The file moved, the caption followed, and the references point at the new name.
    await stat(join(workspaceDir, 'paper', 'figures', 'loss-curve.png'))
    expect(domain.table('figures').get('p1:figures/plot.png')).toBeUndefined()
    expect(domain.table('figures').get('p1:figures/loss-curve.png')?.caption).toBe('Training loss')
    await expect(readFile(join(workspaceDir, 'paper', 'main.tex'), 'utf8'))
      .resolves.toContain('figures/loss-curve.png')
    await expect(readFile(join(workspaceDir, 'paper', 'sections', 'results.tex'), 'utf8'))
      .resolves.toContain('{figures/loss-curve}')
    expect(domain.table('projects').get('p1')?.artifacts).toEqual(['paper/figures/loss-curve.png'])
  })

  it('rejects an extension change, an existing target, and a missing source', async () => {
    const { domain, workspaceDir, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await scaffoldWithReference(workspaceDir)
    await writeFile(join(workspaceDir, 'paper', 'figures', 'taken.png'), Buffer.from([1]))
    await expect(service.renameFigure({ projectId: 'p1', relPath: 'figures/plot.png', newName: 'plot.svg' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.renameFigure({ projectId: 'p1', relPath: 'figures/plot.png', newName: 'taken.png' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.renameFigure({ projectId: 'p1', relPath: 'figures/gone.png', newName: 'x.png' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'figure-not-found' } })
    await expect(service.renameFigure({ projectId: 'p1', relPath: 'figures/plot.png', newName: 'sub/plot.png' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-name' } })
  })

  it('treats a same-name rename as a no-op', async () => {
    const { domain, service, workspaceDir } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await scaffoldPaper(workspaceDir)
    await expect(service.renameFigure({ projectId: 'p1', relPath: 'figures/plot.png', newName: 'plot.png' }))
      .resolves.toEqual({ ok: true, value: { relPath: 'figures/plot.png', references: 0 } })
  })
})

describe('ResearchService.updateFigure', () => {
  it('upserts the caption and preserves the experiment link', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const created = await service.updateFigure({ projectId: 'p1', relPath: 'figures/plot.png', caption: 'first' })
    expect(created).toEqual({ ok: true, value: { relPath: 'figures/plot.png', caption: 'first' } })
    // Seed an experiment link, then confirm a caption update preserves it.
    await domain.table('figures').update('p1:figures/plot.png', current => ({ ...current, experimentId: 'exp-1' }))
    const updated = await service.updateFigure({ projectId: 'p1', relPath: 'figures/plot.png', caption: 'second' })
    expect(updated).toEqual({ ok: true, value: { relPath: 'figures/plot.png', caption: 'second' } })
    expect(domain.table('figures').get('p1:figures/plot.png')?.experimentId).toBe('exp-1')
  })

  it('rejects an unknown project and a non-figure path', async () => {
    const { domain, service } = await harness()
    await expect(service.updateFigure({ projectId: 'nope', relPath: 'figures/x.png', caption: '' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await expect(service.updateFigure({ projectId: 'p1', relPath: '../x.png', caption: '' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-path' } })
    await expect(service.updateFigure({ projectId: 'p1', relPath: 'figures/x.txt', caption: '' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-path' } })
  })
})
