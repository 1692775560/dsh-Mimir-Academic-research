/**
 * Contract tests for the host/client protocol handshake (#250): the verdict
 * helper's version boundaries, and the `getProtocolVersion` Remote reporting
 * the build's own version so a drifted pair fails loudly at mount instead of
 * at a random later call. Memory-backed domain, no mocks.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import { protocolVerdict, RESEARCH_PROTOCOL_VERSION } from '../src/protocol.ts'

describe('protocolVerdict', () => {
  it('accepts only an exact version match', () => {
    expect(protocolVerdict(1, 1)).toBe('compatible')
    expect(protocolVerdict(2, 2)).toBe('compatible')
  })

  it('names the side that must upgrade on a mismatch', () => {
    // The older side upgrades: host ahead → client upgrades, and vice versa.
    expect(protocolVerdict(2, 1)).toBe('host-ahead')
    expect(protocolVerdict(1, 2)).toBe('client-ahead')
  })
})

describe('getProtocolVersion', () => {
  it('reports the build’s protocol version', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    ctx.storage.backend.register('memory', backend)
    ctx.provide(storageBackendServiceKey('memory'), backend)
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    const domain = await facility.open(researchWikiDomainSpec)
    const service = new ResearchService(ctx, {
      workspaceDir: await mkdtemp(join(tmpdir(), 'mimir-protocol-')),
      domain,
      latex: { engine: 'auto', timeoutMs: 1000 },
    })
    const outcome = await service.getProtocolVersion()
    expect(outcome).toEqual({ ok: true, value: { version: RESEARCH_PROTOCOL_VERSION } })
  })
})
