/**
 * Behavior tests for the guarded localStorage codec (#241): a sandboxed
 * iframe throws SecurityError on any localStorage touch, and legacy/dirty
 * flag values must clamp to the default — neither may crash the first render.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readStorageFlag,
  readStorageValue,
  storageFlagValue,
  writeStorageValue,
} from '../src/client/storage.ts'

/** Install a localStorage whose every method throws, as a sandboxed iframe's does. */
function stubThrowingStorage(): void {
  vi.stubGlobal('localStorage', {
    getItem: () => { throw new DOMException('denied', 'SecurityError') },
    setItem: () => { throw new DOMException('denied', 'SecurityError') },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('storage codec', () => {
  it('a throwing store reads as absent and writes are dropped, never thrown', () => {
    stubThrowingStorage()
    expect(readStorageValue('mimir.x')).toBeNull()
    expect(readStorageFlag('mimir.x', true)).toBe(true)
    expect(readStorageFlag('mimir.x', false)).toBe(false)
    expect(() => writeStorageValue('mimir.x', '1')).not.toThrow()
  })

  it('reads and writes flags round-trip through a working store', () => {
    const map = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value) },
    })
    expect(readStorageFlag('mimir.x', true)).toBe(true) // missing → default
    writeStorageValue('mimir.x', storageFlagValue(true))
    expect(readStorageFlag('mimir.x', false)).toBe(true)
    writeStorageValue('mimir.x', storageFlagValue(false))
    expect(readStorageFlag('mimir.x', true)).toBe(false)
  })

  it('clamps dirty and legacy values to the default', () => {
    const map = new Map<string, string>([['mimir.dirty', 'yes'], ['mimir.legacy', '']])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value) },
    })
    expect(readStorageFlag('mimir.dirty', false)).toBe(false)
    expect(readStorageFlag('mimir.dirty', true)).toBe(true)
    expect(readStorageValue('mimir.legacy')).toBe('')
  })
})
