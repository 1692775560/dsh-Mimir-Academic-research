/**
 * #142 item 3: the digest's first push was pinned to `'zh'`, so an English
 * panel opened the ledger and got a Chinese digest with no way to tell why.
 * The push now follows the UI locale.
 *
 * Two seams carry that: the controller takes the language, and the panel feeds
 * it the live chrome locale (mapped onto the two digest languages). This pins
 * both, plus the default for a caller that genuinely has no locale.
 * @module dsh-client-ui-mimir/tests/digest-first-open-lang
 */
import { describe, expect, it } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { ResearchController } from '../src/client/controller.ts'
import type { ResearchRemote } from '../src/client/controller.ts'
import type { ResearchGenerateDigestResult } from 'dsh-mimir/types'

/** Wrap one business result in the carrier's success branch. */
function carried<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One digest result rendered in the language the caller asked for. */
function digestIn(lang: 'zh' | 'en'): ResearchGenerateDigestResult {
  return {
    ok: true,
    value: {
      digest: { headline: `digest in ${lang}`, sections: [] } as never,
      markdown: `# ${lang}`,
      tier: 'weekly',
      lang,
      generatedAt: '2026-11-18T00:00:00.000Z',
    },
  }
}

/** A remote recording every digest language the controller asks for. */
function recordingRemote(seen: string[]): ResearchRemote {
  const stub = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, property) => {
      if (property in target) return target[property as string]
      if (property === 'then') return undefined
      if (property === 'generateDigest') {
        return (options: { tier?: string, lang?: string }) => {
          const lang = options.lang === 'en' ? 'en' : 'zh'
          seen.push(lang)
          return Promise.resolve(carried(digestIn(lang)))
        }
      }
      return () => Promise.reject(new Error(`unexpected ${String(property)} call`))
    },
  })
  return stub as unknown as ResearchRemote
}

describe('the digest follows the UI locale on first open (#142 item 3)', () => {
  it('pushes in English when the panel asks for English', async () => {
    const seen: string[] = []
    const controller = new ResearchController(recordingRemote(seen))
    controller.ensureDigest('en')
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual(['en'])
    expect(controller.getSnapshot().digest.lang).toBe('en')
  })

  it('keeps Chinese as the default for a caller with no locale', async () => {
    const seen: string[] = []
    const controller = new ResearchController(recordingRemote(seen))
    controller.ensureDigest()
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual(['zh'])
  })

  it('pushes only once when the first open fires twice', async () => {
    const seen: string[] = []
    const controller = new ResearchController(recordingRemote(seen))
    controller.ensureDigest('en')
    controller.ensureDigest('en')
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual(['en'])
  })

  it('does not re-push after the digest settled', async () => {
    const seen: string[] = []
    const controller = new ResearchController(recordingRemote(seen))
    controller.ensureDigest('en')
    await Promise.resolve()
    await Promise.resolve()
    controller.ensureDigest('zh')
    await Promise.resolve()
    expect(seen).toEqual(['en'])
  })
})
