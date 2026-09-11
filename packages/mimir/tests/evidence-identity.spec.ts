/**
 * Golden cases for the evidence-identity pipeline (v1.1 §2.3): URL/DOI
 * normalization, the eight-step title fingerprint (CJK bigrams, English
 * stopwords, order invariance), the dedupKey hash, and the node-key shape
 * predicates. Every case is deterministic — the same input must hash to the
 * same identity forever, or two folds disagree about what a node IS.
 * @module dsh-mimir/tests/evidence-identity
 */

import { describe, expect, it } from 'vitest'
import {
  dedupKeyOf,
  isDedupKey,
  isTitleFingerprint,
  isValidNodeKey,
  nodeKeyOf,
  normalizeDoi,
  normalizeUrl,
  queryKeyOf,
  titleFingerprint,
} from '../src/evidence-identity.ts'

describe('normalizeUrl', () => {
  it('lowercases the protocol and host and drops the default port', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/a/B')).toBe('https://example.com/a/B')
    expect(normalizeUrl('http://example.com:80/x')).toBe('http://example.com/x')
    expect(normalizeUrl('http://example.com:8080/x')).toBe('http://example.com:8080/x')
  })

  it('drops the trailing slash, the fragment, and tracking parameters', () => {
    expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path')
    expect(normalizeUrl('https://example.com/path#section')).toBe('https://example.com/path')
    expect(normalizeUrl('https://example.com/p?utm_source=x&id=3')).toBe('https://example.com/p?id=3')
    expect(normalizeUrl('https://example.com/p?fbclid=1&gclid=2&keep=1')).toBe('https://example.com/p?keep=1')
  })

  it('sorts the remaining parameters by name so two orders collide', () => {
    expect(normalizeUrl('https://example.com/p?b=2&a=1'))
      .toBe(normalizeUrl('https://example.com/p?a=1&b=2'))
  })

  it('returns null instead of guessing on junk and non-http schemes', () => {
    expect(normalizeUrl('not a url')).toBeNull()
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl('ftp://example.com/x')).toBeNull()
  })
})

describe('normalizeDoi', () => {
  it('strips the resolver prefix and lowercases', () => {
    expect(normalizeDoi('https://doi.org/10.1234/ABC.def')).toBe('10.1234/abc.def')
    expect(normalizeDoi('10.1234/XYZ')).toBe('10.1234/xyz')
  })

  it('rejects anything that is not a 10.<registrant>/<suffix> shape', () => {
    expect(normalizeDoi('https://example.com/10.1234/x')).toBeNull()
    expect(normalizeDoi('11.1234/x')).toBeNull()
    expect(normalizeDoi('')).toBeNull()
  })
})

describe('titleFingerprint', () => {
  it('merges same-content Chinese titles in different token order (bigrams)', () => {
    // Same token multiset, different order → same bigram set → one fingerprint.
    const left = titleFingerprint('深度学习 方法 研究')
    const right = titleFingerprint('研究 深度学习 方法')
    expect(left).not.toBeNull()
    expect(left).toBe(right)
  })

  it('is invariant to punctuation and case (中英混排)', () => {
    expect(titleFingerprint('Attention Is All You Need!'))
      .toBe(titleFingerprint('attention is all you need'))
    expect(titleFingerprint('基于 Transformer 的摘要研究'))
      .toBe(titleFingerprint('基于transformer的摘要研究'))
  })

  it('drops the English stopwords and keeps the content words', () => {
    expect(titleFingerprint('A Study of the Transformer'))
      .toBe(titleFingerprint('study transformer'))
  })

  it('keeps a single-character Chinese title as itself', () => {
    const fp = titleFingerprint('光')
    expect(fp).not.toBeNull()
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    expect(fp).toBe(titleFingerprint(' 光 '))
  })

  it('returns null when no content token survives', () => {
    expect(titleFingerprint('')).toBeNull()
    expect(titleFingerprint('!!! ...')).toBeNull()
    expect(titleFingerprint('the of and')).toBeNull()
  })

  it('produces stable 16-hex fingerprints', () => {
    const fp = titleFingerprint('Deep Learning: A Survey')
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    expect(fp).toBe(titleFingerprint('deep learning a survey'))
  })
})

describe('isTitleFingerprint', () => {
  it('accepts only 16 lowercase hex digits', () => {
    expect(isTitleFingerprint(titleFingerprint('deep learning') ?? '')).toBe(true)
    expect(isTitleFingerprint('ABCDEF0123456789')).toBe(false)
    expect(isTitleFingerprint('abc')).toBe(false)
  })
})

describe('dedupKeyOf', () => {
  it('is stable per (rel, src, dst, scope) and 32 hex wide', () => {
    const key = dedupKeyOf('supports', 'lit:arxiv:2401.00001', 'claim:abc', 'proj-1//claim-9')
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(key).toBe(dedupKeyOf('supports', 'lit:arxiv:2401.00001', 'claim:abc', 'proj-1//claim-9'))
    expect(isDedupKey(key)).toBe(true)
  })

  it('separates scopes, directions, and relations', () => {
    const base = dedupKeyOf('supports', 'a:x', 'b:y', 's1')
    expect(base).not.toBe(dedupKeyOf('supports', 'a:x', 'b:y', 's2'))
    expect(base).not.toBe(dedupKeyOf('supports', 'b:y', 'a:x', 's1'))
    expect(base).not.toBe(dedupKeyOf('contradicts', 'a:x', 'b:y', 's1'))
  })
})

describe('nodeKeyOf / isValidNodeKey', () => {
  it('builds `<kind>:<raw>` keys and validates the shape', () => {
    expect(nodeKeyOf('claim', 'abc')).toBe('claim:abc')
    expect(nodeKeyOf('LIT', 'arxiv:2401.00001')).toBe('lit:arxiv:2401.00001')
    expect(isValidNodeKey('claim:abc')).toBe(true)
    expect(isValidNodeKey('lit:arxiv:2401.00001')).toBe(true)
  })

  it('rejects empty values, malformed kinds, and over-cap keys', () => {
    expect(() => nodeKeyOf('claim', '')).toThrow()
    expect(() => nodeKeyOf('bad kind', 'x')).toThrow()
    expect(isValidNodeKey('claim:')).toBe(false)
    expect(isValidNodeKey(':abc')).toBe(false)
    expect(isValidNodeKey('claim')).toBe(false)
    expect(isValidNodeKey(`claim:${'x'.repeat(200)}`)).toBe(false)
  })
})

describe('queryKeyOf', () => {
  it('is stable per query+scope and 12 hex wide', () => {
    const key = queryKeyOf('diffusion guidance', 'proj-1//')
    expect(key).toMatch(/^query:[0-9a-f]{12}$/)
    expect(key).toBe(queryKeyOf('diffusion guidance', 'proj-1//'))
    expect(key).not.toBe(queryKeyOf('diffusion guidance', ''))
  })
})
