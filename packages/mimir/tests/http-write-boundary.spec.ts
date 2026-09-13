import { describe, expect, it } from 'vitest'
import { isSameOriginWrite, isTrustedRead, projectPaperDir } from '../src/http-write-boundary.ts'

describe('isSameOriginWrite', () => {
  it('accepts an exact HTTP or HTTPS origin-host match', () => {
    expect(isSameOriginWrite({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })).toBe(true)
    expect(isSameOriginWrite({ origin: 'https://research.example.test', host: 'research.example.test' })).toBe(true)
  })

  it('rejects absent, malformed, cross-origin, and non-web origins', () => {
    expect(isSameOriginWrite({ host: '127.0.0.1:3080' })).toBe(false)
    expect(isSameOriginWrite({ origin: 'not a URL', host: '127.0.0.1:3080' })).toBe(false)
    expect(isSameOriginWrite({ origin: 'http://attacker.test', host: '127.0.0.1:3080' })).toBe(false)
    expect(isSameOriginWrite({ origin: 'file://', host: '127.0.0.1:3080' })).toBe(false)
  })
})

describe('isTrustedRead (#210)', () => {
  it('admits loopback hosts on any port when no Origin is present', () => {
    expect(isTrustedRead({ host: 'localhost:3080' })).toBe(true)
    expect(isTrustedRead({ host: '127.0.0.1:9999' })).toBe(true)
    expect(isTrustedRead({ host: '[::1]:3080' })).toBe(true)
    expect(isTrustedRead({ host: 'LOCALHOST:3080' })).toBe(true)
  })

  it('rejects absent, non-loopback, and loopback-suffix host names', () => {
    expect(isTrustedRead({})).toBe(false)
    expect(isTrustedRead({ host: 'evil.com' })).toBe(false)
    // DNS rebinding: an attacker-controlled name must never pass.
    expect(isTrustedRead({ host: 'localhost.evil.com' })).toBe(false)
    expect(isTrustedRead({ host: '127.0.0.1.evil.com' })).toBe(false)
  })

  it('applies the same-origin rule when an Origin header is present', () => {
    expect(isTrustedRead({ host: 'localhost:3080', origin: 'http://localhost:3080' })).toBe(true)
    expect(isTrustedRead({ host: 'localhost:3080', origin: 'http://evil.com' })).toBe(false)
    expect(isTrustedRead({ host: 'localhost:3080', origin: 'not a URL' })).toBe(false)
  })
})

describe('projectPaperDir', () => {
  it('uses the project directory and never accepts a request-selected override', () => {
    expect(projectPaperDir('/research', 'projects/p1')).toBe('/research/projects/p1')
    expect(projectPaperDir('/research', undefined)).toBe('/research/paper')
  })

  it('rejects invalid project paper directories', () => {
    expect(projectPaperDir('/research', '../other-project')).toBeUndefined()
    expect(projectPaperDir('/research', '/tmp/paper')).toBeUndefined()
  })
})
