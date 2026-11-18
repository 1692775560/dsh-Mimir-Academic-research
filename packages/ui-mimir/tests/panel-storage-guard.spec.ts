/**
 * #142 item 5: the panel's persisted UI state must survive a store that
 * throws. A sandboxed iframe where touching `window.localStorage` raises
 * SecurityError used to crash the panel on first render, because the reads
 * went straight through the global instead of the guarded codec.
 *
 * The fold flags are read in `useState` initialisers and written in effects;
 * `ResearchController` reads its derivation version in the constructor. All of
 * those run before anyone could catch an exception, so the guard has to be at
 * the call site — which is what these tests pin.
 * @module dsh-client-ui-mimir/tests/panel-storage-guard
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { readStorageFlag, readStorageValue, storageFlagValue, writeStorageValue } from '../src/client/storage.ts'

const KEY = 'mimir.test.guard'

/** Install a `localStorage` that throws on every access, like a blocked iframe. */
function blockStorage(): { getItem: () => never, setItem: () => never } {
  const blocked = {
    getItem: (): never => { throw new Error('SecurityError: the operation is insecure') },
    setItem: (): never => { throw new Error('SecurityError: the operation is insecure') },
  }
  vi.stubGlobal('localStorage', blocked)
  return blocked
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('guarded storage codec (#142 item 5)', () => {
  it('reads an absent value from a throwing store as null', () => {
    blockStorage()
    expect(readStorageValue(KEY)).toBeNull()
  })

  it('falls back to the default flag from a throwing store', () => {
    blockStorage()
    expect(readStorageFlag(KEY, false)).toBe(false)
    expect(readStorageFlag(KEY, true)).toBe(true)
  })

  it('drops the write from a throwing store instead of propagating', () => {
    blockStorage()
    expect(() => { writeStorageValue(KEY, storageFlagValue(true)) }).not.toThrow()
  })

  it('still round-trips through a working store', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => { store.set(key, value) },
    })
    writeStorageValue(KEY, storageFlagValue(true))
    expect(readStorageValue(KEY)).toBe('1')
    expect(readStorageFlag(KEY, false)).toBe(true)
  })

  it('reads a dirty or legacy flag as the default', () => {
    const store = new Map<string, string>([[KEY, 'yes']])
    vi.stubGlobal('localStorage', {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => { store.set(key, value) },
    })
    expect(readStorageFlag(KEY, false)).toBe(false)
    expect(readStorageFlag(KEY, true)).toBe(true)
  })
})
