import { describe, expect, it } from 'vitest'
import { isSameOriginWrite, projectPaperDir } from '../src/http-write-boundary.ts'

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
