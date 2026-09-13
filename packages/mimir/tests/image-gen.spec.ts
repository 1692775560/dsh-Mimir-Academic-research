/**
 * Behavior tests for the image-gen service: config persistence with a masked
 * panel view (an omitted apiKey keeps the stored one), the generation client
 * over an injected fetch (b64_json and url payloads, HTTP failure), and
 * saveDeckIllustration filing the image + caption row under figures/ai-deck/.
 */

import { mkdtemp } from 'node:fs/promises'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import {
  IMAGE_GEN_DEFAULT_BASE_URL,
  coverPrompt,
  generateImage,
  getImageGenConfig,
  paperArtPrompt,
  readImageGenConfig,
  saveDeckIllustration,
  setImageGenConfig,
  type ImageGenFetch,
} from '../src/services/image-gen.ts'

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mimir-imagegen-'))
}

describe('image-gen config', () => {
  it('reads defaults when unset, round-trips a set, and masks the key', async () => {
    const dir = await workspace()
    expect((await readImageGenConfig(dir)).apiKey).toBe('')
    const initial = await getImageGenConfig(dir)
    expect(initial.ok && initial.value.configured).toBe(false)
    expect(initial.ok && initial.value.baseUrl).toBe(IMAGE_GEN_DEFAULT_BASE_URL)

    const saved = await setImageGenConfig(dir, { baseUrl: 'https://example.com/v1', apiKey: 'sk-abcdefgh1234', model: 'doubao-seedream', size: '1024x1024' })
    expect(saved.ok).toBe(true)
    if (saved.ok) {
      expect(saved.value.configured).toBe(true)
      expect(saved.value.apiKeyPreview).toBe('sk-ab…34')
      expect(saved.value.apiKeyPreview).not.toContain('abcdefgh')
    }

    // An omitted apiKey keeps the stored one; an explicit '' clears it.
    const kept = await setImageGenConfig(dir, { model: 'other-model' })
    expect(kept.ok && kept.value.configured).toBe(true)
    expect((await readImageGenConfig(dir)).apiKey).toBe('sk-abcdefgh1234')
    expect((await readImageGenConfig(dir)).model).toBe('other-model')
    const cleared = await setImageGenConfig(dir, { apiKey: '' })
    expect(cleared.ok && cleared.value.configured).toBe(false)

    const invalid = await setImageGenConfig(dir, { baseUrl: 'not-a-url' })
    expect(invalid.ok).toBe(false)
  })
})

describe('generateImage', () => {
  const config = { baseUrl: 'https://example.com/v1/', apiKey: 'sk-x', model: 'm', size: '1024x1024' }

  it('decodes a b64_json payload and normalizes the base URL slash', async () => {
    const requests: { url: string; body: string }[] = []
    const fetcher: ImageGenFetch = async (url, init) => {
      requests.push({ url, body: init.body })
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }) }
    }
    const image = await generateImage(config, 'a cover', fetcher)
    expect(image.toString()).toBe('png')
    expect(requests[0]?.url).toBe('https://example.com/v1/images/generations')
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: 'm', prompt: 'a cover', response_format: 'b64_json' })
  })

  it('throws on an HTTP failure so the caller can skip the illustration', async () => {
    const fetcher: ImageGenFetch = async () => ({ ok: false, status: 401, json: async () => ({}) })
    await expect(generateImage(config, 'x', fetcher)).rejects.toThrow('401')
  })

  it('races the caller signal against the per-request timeout (#247)', async () => {
    let seen: AbortSignal | undefined
    const fetcher: ImageGenFetch = async (_url, init) => {
      seen = init.signal
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }) }
    }
    const caller = new AbortController()
    await generateImage(config, 'a cover', fetcher, caller.signal)
    expect(seen).toBeDefined()
    expect(seen?.aborted).toBe(false)
    caller.abort()
    // The combined signal follows the caller's abort.
    expect(seen?.aborted).toBe(true)
    // Without a caller signal the bare timeout rides alone (unchanged default).
    let bare: AbortSignal | undefined
    const bareFetcher: ImageGenFetch = async (_url, init) => {
      bare = init.signal
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }) }
    }
    await generateImage(config, 'a cover', bareFetcher)
    expect(bare?.aborted).toBe(false)
  })
})

describe('prompts', () => {
  it('forbid rendered text (garbled labels ruin slides)', () => {
    expect(coverPrompt('量化')).toContain('no text')
    expect(paperArtPrompt('AWQ', 'Activation-aware weight quantization '.repeat(30))).toContain('no text')
  })
})

describe('saveDeckIllustration', () => {
  it('writes the png under figures/ai-deck/ and upserts the caption row', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    ctx.storage.backend.register('memory', backend)
    ctx.provide(storageBackendServiceKey('memory'), backend)
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    const domain = await facility.open(researchWikiDomainSpec)
    const dir = await workspace()

    const relPath = await saveDeckIllustration(
      { workspaceDir: dir, domain }, 'p1', 'paper', 'cover', 'AI 配图 · 组会封面', Buffer.from('png-bytes'),
    )
    expect(relPath).toBe('figures/ai-deck/cover.png')
    expect((await stat(join(dir, 'paper', relPath))).isFile()).toBe(true)
    expect((await readFile(join(dir, 'paper', relPath))).toString()).toBe('png-bytes')
    const row = domain.table('figures').get('p1:figures/ai-deck/cover.png')
    expect(row?.caption).toBe('AI 配图 · 组会封面')
  })
})
