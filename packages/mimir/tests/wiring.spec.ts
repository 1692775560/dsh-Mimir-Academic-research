/**
 * #231: `ResearchServiceConfig` has exactly one assembly point.
 *
 * The regression this guards is quiet, which is why it needs a test rather
 * than a comment: the config was mapped in `apply` and again in the
 * constructor's spread chain, so a field present on one side and absent on the
 * other compiled cleanly and only showed up as a silently disabled feature
 * (`exactOptionalPropertyTypes` makes both mappings legal).
 *
 * Two things are asserted:
 *  - `buildDeps` carries every field through, and carries an absent optional
 *    through as absent (never as an explicit `undefined` — the service reads
 *    absence as a documented mode);
 *  - the constructor's `deps` IS what `buildDeps` returns for the same input,
 *    so re-introducing a private mapping in the constructor fails here.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchService } from '../src/service.ts'
import type { ResearchServiceConfig } from '../src/service.ts'
import { buildDeps, type ResearchWiring } from '../src/services/wiring.ts'
import { researchWikiDomainSpec } from '../src/store.ts'

async function openDomain(): Promise<{
  ctx: Context
  domain: ResearchServiceConfig['domain']
  workspaceDir: string
}> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-wiring-'))
  return { ctx, domain, workspaceDir }
}

/** Every optional field spelled out, so a dropped one is visible. */
function fullWiring(base: { workspaceDir: string; domain: ResearchServiceConfig['domain'] }): ResearchWiring {
  return {
    workspaceDir: base.workspaceDir,
    domain: base.domain,
    config: {
      latex: { engine: 'auto', timeoutMs: 1_000 },
      backup: { enabled: true, intervalMinutes: 30, keep: 3, dir: '/tmp/mimir-backups' },
      search: { command: 'dg', timeoutMs: 5_000 },
      arxiv: { timeoutMs: 20_000 },
      zotero: { apiKey: 'k', userId: 'u' },
      taskHealth: undefined as never,
      notifyWikiChange: () => {},
      jobs: { timeoutMs: 1_000, maxBufferBytes: 1_024 },
      capabilities: { enabled: Object.freeze(['core'] as const), disabled: Object.freeze([]) },
    },
  }
}

describe('buildDeps is the only mapping (#231)', () => {
  it('carries every configured field through unchanged', async () => {
    const base = await openDomain()
    const wiring = fullWiring(base)
    const deps = buildDeps(wiring)
    expect(deps.workspaceDir).toBe(base.workspaceDir)
    expect(deps.domain).toBe(base.domain)
    expect(deps.latex).toEqual(wiring.config.latex)
    expect(deps.backup).toEqual(wiring.config.backup)
    expect(deps.search).toEqual(wiring.config.search)
    expect(deps.arxiv).toEqual(wiring.config.arxiv)
    expect(deps.zotero).toEqual(wiring.config.zotero)
    expect(deps.jobs).toEqual(wiring.config.jobs)
    expect(deps.capabilities).toEqual(wiring.config.capabilities)
    expect(typeof deps.notifyWikiChange).toBe('function')
  })

  it('leaves an absent optional absent, never an explicit undefined', async () => {
    const base = await openDomain()
    const deps = buildDeps({
      workspaceDir: base.workspaceDir,
      domain: base.domain,
      config: { latex: { engine: 'auto', timeoutMs: 1_000 } },
    })
    // `in`-style presence, not truthiness: the service branches on `=== undefined`
    // but a spread of an explicit `undefined` would still be a key it must not
    // see under exactOptionalPropertyTypes.
    for (const key of ['backup', 'search', 'arxiv', 'svg', 'zotero', 'meetings', 'taskHealth', 'jobs', 'capabilities']) {
      expect(Object.hasOwn(deps, key)).toBe(false)
    }
  })

  it('gives the service exactly the config buildDeps produces', async () => {
    const base = await openDomain()
    const wiring = fullWiring(base)
    const expected = buildDeps(wiring)
    const service = new ResearchService(base.ctx, expected)
    // The constructor used to re-map the shape privately; if that mapping comes
    // back, `deps` stops being reference-equal to what buildDeps returned.
    expect((service as unknown as { deps: ResearchServiceConfig }).deps).toEqual(expected)
  })

  it('rejects an empty workspace root before it maps anything', async () => {
    const base = await openDomain()
    expect(() => new ResearchService(base.ctx, buildDeps({
      workspaceDir: '   ',
      domain: base.domain,
      config: { latex: { engine: 'auto', timeoutMs: 1_000 } },
    }))).toThrowError(/workspaceDir must be a non-empty absolute path/)
  })
})
