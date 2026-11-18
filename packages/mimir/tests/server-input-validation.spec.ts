/**
 * #236: what a stored server record may contain.
 *
 * Two gaps were left once `c2596ef` added the character whitelist:
 *
 *  - the whitelist is a *shape* check, so a token made only of separators
 *    (`..`, `::`, `-`) and a host carrying its own `:port` both pass it, and
 *    ssh then has to diagnose them one layer below where the user can act;
 *  - the GPU parser tolerates NaN/Infinity, but an empty field coerces to `0`,
 *    so `gpu0, , ,` stored a plausible-looking 0% / 0 MiB GPU.
 *
 * Every case here is either `invalid-input` at the edge or a skipped row —
 * never a record that turns into a mysterious ssh failure later.
 */

import { describe, expect, it } from 'vitest'
import { validateServerInput } from '../src/services/server.ts'

const VALID = {
  name: 'gpu01',
  host: '127.0.0.1',
  port: 22,
  username: 'ops',
  note: '',
} as const

/** The rejection message for one payload, or null when it is accepted. */
function reject(patch: Record<string, unknown>): string | null {
  return validateServerInput({ ...VALID, ...patch } as never)
}

const HOST_MESSAGE = /plain hostname/
const USER_MESSAGE = /plain ssh login user/

describe('server host validation (#236)', () => {
  it('accepts the shapes a compute server actually has', () => {
    for (const host of ['127.0.0.1', 'gpu-01', 'gpu01.lab.example.org', '::1', 'fe80::1c:2f', 'gpu_01.internal']) {
      expect(reject({ host })).toBeNull()
    }
  })

  it('rejects control characters instead of letting ssh diagnose them', () => {
    for (const host of ['gpu\n01', 'gpu\t01', 'gpu\x0001', 'gpu01\r']) {
      expect(reject({ host })).toMatch(HOST_MESSAGE)
    }
  })

  it('rejects an empty or whitespace-only host', () => {
    expect(reject({ host: '' })).toMatch(/non-empty/)
    expect(reject({ host: '   ' })).toMatch(/non-empty/)
    expect(reject({ host: ' \t ' })).toMatch(/non-empty/)
  })

  it('rejects a host that is only separators', () => {
    // These pass the character whitelist and name nothing as a destination.
    for (const host of ['..', '.', ':', '::', '---', '._-']) {
      expect(reject({ host })).toMatch(HOST_MESSAGE)
    }
  })

  it('rejects a colon carrying its own port', () => {
    // `user@host:port` is ssh's target grammar, so a port baked into the stored
    // host silently overrides the record's own port field.
    for (const host of ['gpu01:2222', '10.0.0.1:22']) {
      expect(reject({ host })).toMatch(HOST_MESSAGE)
    }
  })

  it('keeps accepting a bare IPv6 literal, which also has colons', () => {
    // The port rejection must not swallow the addresses colons exist for.
    expect(reject({ host: '::1' })).toBeNull()
    expect(reject({ host: 'fe80::1c:2f' })).toBeNull()
  })

  it('keeps rejecting the option-injection shape', () => {
    expect(reject({ host: '-oProxyCommand=evil' })).toMatch(HOST_MESSAGE)
    expect(reject({ host: '-gpu01' })).toMatch(HOST_MESSAGE)
  })

  it('rejects shell metacharacters and spaces', () => {
    for (const host of ['gpu01;id', 'gpu 01', 'gpu01|cat', '$(id)', 'gpu01&&id']) {
      expect(reject({ host })).toMatch(HOST_MESSAGE)
    }
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
      expect(reject({ username })).toMatch(USER_MESSAGE)
    }
  })

  it('rejects a username that is only separators', () => {
    // Same failure as the host: it passes the whitelist and logs in as nobody.
    for (const username of ['.', '..', '-', '_', '...']) {
      expect(reject({ username })).toMatch(USER_MESSAGE)
    }
  })

  it('keeps rejecting the option-injection shape and shell punctuation', () => {
    expect(reject({ username: '-oProxyCommand=evil' })).toMatch(USER_MESSAGE)
    expect(reject({ username: 'ops@host' })).toMatch(USER_MESSAGE)
    expect(reject({ username: 'ops name' })).toMatch(USER_MESSAGE)
    expect(reject({ username: 'ops;id' })).toMatch(USER_MESSAGE)
  })
})
