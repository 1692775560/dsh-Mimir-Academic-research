/**
 * Guarded localStorage codec for the panel's persisted UI state. Touching
 * `window.localStorage` throws SecurityError in a sandboxed iframe, and a
 * full/blocked store throws on write — both must degrade to "no persistence",
 * never crash the first render. The flag codec also absorbs legacy/dirty
 * values: anything that is not exactly '1' or '0' reads as the default.
 * @module dsh-client-ui-mimir/client/storage
 */

/**
 * Read one key; a blocked or throwing store reads as `null` (absent).
 * @param key - the `mimir.*` storage key.
 */
export function readStorageValue(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Write one key; a full or blocked store drops persistence, never the render.
 * @param key - the `mimir.*` storage key.
 * @param value - the serialized value.
 */
export function writeStorageValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // A full/blocked localStorage drops persistence; the feature still works.
  }
}

/**
 * Read one `'1'`/`'0'` boolean flag with clamping: missing, dirty, or legacy
 * values all read as `defaultValue`.
 * @param key - the `mimir.*` storage key.
 * @param defaultValue - the value when nothing trustworthy is stored.
 */
export function readStorageFlag(key: string, defaultValue: boolean): boolean {
  const raw = readStorageValue(key)
  if (raw === '1') return true
  if (raw === '0') return false
  return defaultValue
}

/** Serialize one boolean flag for {@link writeStorageValue}. */
export function storageFlagValue(value: boolean): string {
  return value ? '1' : '0'
}
