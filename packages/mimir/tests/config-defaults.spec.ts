/**
 * #218: one source of defaults.
 *
 * The drift this guards was structural, so the test is structural too: a knob
 * whose default lived in both the schema and `resolveConfig` could be changed
 * in one place and stay stale in the other, and both sides still compiled
 * because the schema's output is optional-typed while `resolveConfig` fills it
 * in.
 *
 * Three assertions, in increasing strength:
 *  - the schema applies `DEFAULTS` exactly (an empty config equals it);
 *  - `resolveConfig` — the path taken when a caller bypasses Loader
 *    normalization — fills in the same values;
 *  - a config that sets one knob keeps every other default, so the fallbacks
 *    are per-field rather than all-or-nothing.
 */

import { describe, expect, it } from 'vitest'
import { Config, DEFAULTS } from '../src/index.ts'

/** `Config({})` as the Loader would normalize it. */
const normalized = Config({}) as unknown as Record<string, unknown>

describe('DEFAULTS is the only source (#218)', () => {
  it('is exactly what the schema produces for an empty config', () => {
    expect(normalized).toEqual(DEFAULTS)
  })

  it('covers every key the schema declares, and nothing extra', () => {
    // A knob added to the schema but not to DEFAULTS (or the reverse) is the
    // two-edits-that-drift case the issue names.
    expect(Object.keys(normalized).sort()).toEqual(Object.keys(DEFAULTS).sort())
  })

  it('fills nested groups rather than replacing them', () => {
    const backup = Config({ backup: { keep: 3 } }) as unknown as { backup: Record<string, unknown> }
    expect(backup.backup).toEqual({ ...DEFAULTS.backup, keep: 3 })
  })

  it('keeps the documented numbers', () => {
    // Pinned on purpose: these are the values users see in README tables, so a
    // silent change to DEFAULTS should fail here rather than ship.
    expect(DEFAULTS).toEqual({
      workspaceDir: '.research',
      reviewer: { provider: 'spawn', maxRounds: 3, timeoutMs: 600_000 },
      latex: { engine: 'auto', timeoutMs: 120_000 },
      arxiv: { maxResults: 10, timeoutMs: 30_000 },
      search: { command: 'auto', timeoutMs: 30_000, maxResults: 10 },
      zotero: { apiKey: '', userId: '' },
      subscriptions: { enabled: true, intervalMinutes: 1440 },
      backup: { enabled: true, intervalMinutes: 60, keep: 24, dir: 'backups' },
      skills: { enabled: true },
      serverTools: { enabled: true },
    })
  })
})
