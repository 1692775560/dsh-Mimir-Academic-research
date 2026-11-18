/**
 * #236: what a stored server record may contain, and what a probe row may not.
 *
 * Two gaps were left after `c2596ef` added the character whitelist:
 *
 *  - the whitelist is a *shape* check, so `:` (the port separator in
 *    `user@host:port` and in an IPv6 literal) and a `.`/`-`-only token both
 *    pass a shape that ssh then has to diagnose for us — one level below where
 *    the user can act on it;
 *  - the GPU parser is fine on NaN/Infinity, but an empty field coerces to `0`,
 *    so `gpu0, , ,` stored a plausible-looking 0% / 0 MiB GPU.
 *
 * Both are `invalid-input` at the edge, or a skipped row — never a record that
 * becomes a mysterious ssh failure later.
 */

import { describe, expect, it } from 'vitest'
import { parseGpuLine, validateServerInput } from '../src/services/server.ts'

const VALID = {
  name: 'gpu01',
  host: '127.0.0.1',
  port: 22,
  username: 'ops',
  note: '',
} as const

/** The message for one payload, or null when it is accepted. */
function reject(patch: Record<string, unknown>): string | null {
  return validateServerInput({ ...VALID, ...patch } as never)
}

describe('server host validation (#236)', () => {
  it('accepts the shapes a compute server actually has', () => {
    for (const host of ['127.0.0.1', 'gpu-01', 'gpu01.lab.example.org', '::1', 'fe80::1c:2f']) {
      expect(reject({ host })).toBeNull()
    }
  })

  it('rejects control characters instead of letting ssh diagnose them', () => {
    for (const host of ['gpu\n01', 'gpu\t01', 'gpu\x0001', 'gpu01\r']) {
      expect(reject({ host })).toMatch(/plain hostname/)
    }
  })

  it('rejects an empty or whitespace-only host', () => {
    expect(reject({ host: '' })).toMatch(/non-empty/)
    expect(reject({ host: '   ' })).toMatch(/non-empty/)
    expect(reject({ host: ' \t ' })).toMatch(/non-empty/)
  })

  it('rejects a host that is only separators', () => {
    // `--`, `..` and `::` pass the character whitelist and mean nothing as a
    // destination; `-` first is already rejected by the option-injection guard.
    for (const host of ['..', '.', ':', '::', '-', '.-']) {
      expect(reject({ host })).toMatch(/plain hostname/)
    }
  })

  it('rejects a colon that would split the login target', () => {
    // `user@host:port` is parsed by ssh's own target grammar, so a colon inside
    // the stored host silently changes which port is dialled.
    // The message names the fix, not just the field: moving the port where it
    // belongs is an action, "not a plain hostname" is not.
    expect(reject({ host: 'gpu01:2222' })).toMatch(/must not contain a port/)
  })

  it('keeps rejecting the option-injection shape', () => {
    expect(reject({ host: '-oProxyCommand=evil' })).toMatch(/plain hostname/)
    expect(reject({ host: '-gpu01' })).toMatch(/plain hostname/)
  })

  it('rejects shell metacharacters and spaces', () => {
    for (const host of ['gpu01;id', 'gpu01 && id', 'gpu 01', 'gpu01|cat', '$(id)']) {
      expect(reject({ host })).toMatch(/plain hostname/)
    }
  })
})

describe('GPU rows (#236)', () => {
  it('skips a row whose empty fields would coerce to zero', () => {
    // `Number('')` is 0, so `gpu0, , ,` used to store a plausible-looking
    // 0% / 0 MiB card. The parser must refuse the coercion, not the value.
    expect(parseGpuLine('gpu0, , ,')).toBeNull()
    expect(parseGpuLine('gpu0, 12, , 8192')).toBeNull()
    expect(parseGpuLine('gpu0, 12, 1024, ')).toBeNull()
  })

  it('skips NaN and Infinity rather than storing them as a bar', () => {
    expect(parseGpuLine('gpu0, NaN, 1024, 8192')).toBeNull()
    expect(parseGpuLine('gpu0, 12, Infinity, 8192')).toBeNull()
    expect(parseGpuLine('gpu0, 12, -Infinity, 8192')).toBeNull()
  })

  it('keeps a well-formed row, including a 0% idle GPU', () => {
    expect(parseGpuLine('gpu0, 0, 0, 8192')).toEqual({
      name: 'gpu0', utilizationPct: 0, memoryUsedMb: 0, memoryTotalMb: 8192,
    })
  })
})

describe('server username validation (#236)', () => {
  it('accepts a plain login user, and an empty one (key auth without a user)', () => {
    expect(reject({ username: 'ops' })).toBeNull()
    expect(reject({ username: 'ops.team-1_2' })).toBeNull()
    expect(reject({ username: '' })).toBeNull()
    expect(reject({ username: undefined })).toBeNull()
  })

  it('rejects control characters', () => {
    for (const username of ['op\ns', 'ops\t', 'ops\x0001']) {
      expect(reject({ username })).toMatch(/plain ssh login user/)
    }
  })

  it('rejects a username that is only separators', () => {
    for (const username of ['.', '..', '-', '_', '...']) {
      expect(reject({ username })).toMatch(/plain ssh login user/)
    }
  })

  it('keeps rejecting the option-injection shape and shell punctuation', () => {
    expect(reject({ username: '-oProxyCommand=evil' })).toMatch(/plain ssh login user/)
    expect(reject({ username: 'ops@host' })).toMatch(/plain ssh login user/)
    expect(reject({ username: 'ops name' })).toMatch(/plain ssh login user/)
    expect(reject({ username: 'ops;id' })).toMatch(/plain ssh login user/)
  })
})
