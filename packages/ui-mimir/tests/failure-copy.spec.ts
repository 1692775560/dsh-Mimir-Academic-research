/**
 * Host failure codes reach the panel as `{ code, message }`; the message is
 * authored in English on the host, so a code the panel does not map leaks it
 * into a Chinese UI (#252). These cover the mapping, the deliberate
 * fall-through for context-bearing codes, and the zh/en key parity.
 */
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { failureCopy, FAILURE_CODE_KEYS, type ResearchT } from '../src/client/view-common.ts'

/** A `t` that resolves against one dictionary, so copy is asserted, not the key. */
const translatorFor = (dict: Record<string, string>): ResearchT =>
  (key => dict[key] ?? `MISSING:${key}`) as ResearchT

const tZh = translatorFor(zh)
const tEn = translatorFor(en)

describe('failureCopy', () => {
  it('renders no copy for the absence of a failure', () => {
    expect(failureCopy(tZh, null)).toBe('')
  })

  // The codes the host services reject with today. Pinning the list (rather
  // than only iterating the table) is what makes an unmapped code fail here
  // instead of silently passing a table that no longer holds it.
  const LOCALIZED_CODES = [
    'invalid-dir', 'project-not-found', 'paper-not-found', 'experiment-not-found',
    'figure-not-found', 'artifact-not-found', 'bib-not-found', 'job-not-found',
    'server-not-found', 'snapshot-not-found', 'subscription-not-found',
    'section-not-found', 'subsection-not-found', 'conflict', 'invalid-artifact',
    'invalid-content', 'invalid-name', 'invalid-path',
  ] as const

  it('localizes every host code that does not carry its own detail', () => {
    for (const code of LOCALIZED_CODES) {
      const failure = { code, message: 'english host message' }
      expect(failureCopy(tZh, failure), `${code} still leaks the host message`)
        .not.toBe('english host message')
      expect(FAILURE_CODE_KEYS[code], `${code} has no locale key`).toBeDefined()
    }
  })

  it('translates every mapped code in both dictionaries', () => {
    for (const [code, key] of Object.entries(FAILURE_CODE_KEYS)) {
      const failure = { code, message: 'english host message' }
      expect(failureCopy(tZh, failure), `zh copy of ${code}`).toBe(zh[key])
      expect(failureCopy(tEn, failure), `en copy of ${code}`).toBe(en[key])
      // The regression this guards: the host message must not survive.
      expect(failureCopy(tZh, failure), `zh leak on ${code}`).not.toBe('english host message')
    }
  })

  it('maps the not-found codes the services actually reject with', () => {
    // Spot-check the shape rather than trusting the table alone: these are
    // the codes a user meets most (a stale panel selecting a deleted row).
    expect(failureCopy(tZh, { code: 'project-not-found', message: 'unknown project' }))
      .toBe('项目不存在')
    expect(failureCopy(tZh, { code: 'conflict', message: '' })).toBe('内容已被其他改动更新，请重新加载后再试')
    expect(failureCopy(tEn, { code: 'paper-not-found', message: 'unknown paper' }))
      .toBe('No such paper')
  })

  it('keeps the host message for codes that carry the detail', () => {
    // `invalid-input` and `operation-failed` reject WITH a specific message
    // (the offending value, the failed step); a generic line would lose it.
    expect(failureCopy(tZh, { code: 'invalid-input', message: 'baseUrl must be an http(s) URL' }))
      .toBe('baseUrl must be an http(s) URL')
    expect(failureCopy(tZh, { code: 'operation-failed', message: 'the evidence profile could not be folded' }))
      .toBe('the evidence profile could not be folded')
  })

  it('falls back to a generic line when an unmapped code carries no message', () => {
    expect(failureCopy(tZh, { code: 'brand-new-code', message: '' })).toBe('操作失败')
    expect(failureCopy(tEn, { code: 'brand-new-code', message: '' })).toBe('The operation failed')
  })

  it('points every mapped code at a key both dictionaries define', () => {
    for (const [code, key] of Object.entries(FAILURE_CODE_KEYS)) {
      expect(zh[key], `zh is missing ${key} (for ${code})`).toBeTruthy()
      expect(en[key], `en is missing ${key} (for ${code})`).toBeTruthy()
    }
  })
})
