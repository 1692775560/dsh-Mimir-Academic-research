/**
 * Regression tests for the absolute-path redaction on failure boundaries
 * (CODE_STYLE §3: no absolute paths in error text). `redactDirs` exists
 * because raw engine/IO exception text used to carry the local workspace
 * layout to the wire; these cases pin both separator spellings, POSIX
 * paths, and the undefined-tolerance contract. The helper postdates the
 * fix, so "fails before the fix" here means the export itself was absent.
 * @module dsh-mimir/tests/paper-redaction
 */

import { describe, expect, it } from 'vitest'
import { redactDirs } from '../src/services/paper.ts'

describe('redactDirs', () => {
  it('masks workspace and paper dirs in both separator spellings', () => {
    const workspace = 'C:\\Users\\dev\\research-ws'
    const paper = 'D:\\paperstore\\main'
    const message = `spawn failed for ${workspace}\\papers\\p1 and ${workspace}/papers/p1 near ${paper}`
    const out = redactDirs(message, workspace, paper)
    expect(out).not.toContain(workspace)
    expect(out).not.toContain('C:/Users/dev/research-ws')
    expect(out).not.toContain(paper)
    expect(out).toContain('<workspace>')
    expect(out).toContain('<paper-dir>')
  })

  it('masks POSIX-style workspace directories', () => {
    const out = redactDirs('ENOENT: /home/dev/ws/main.tex missing', '/home/dev/ws', undefined)
    expect(out).toBe('ENOENT: <workspace>/main.tex missing')
  })

  it('passes through messages without the prefixes and tolerates undefined dirs', () => {
    expect(redactDirs('latex compile failed to run', undefined, undefined)).toBe('latex compile failed to run')
    expect(redactDirs('nothing to redact', 'C:\\ws', undefined)).toBe('nothing to redact')
  })
})
