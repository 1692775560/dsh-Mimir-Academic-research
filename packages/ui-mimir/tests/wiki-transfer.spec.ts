/**
 * Tests for the overview data section's pure helpers: the export download's
 * filename (`mimir-wiki-YYYYMMDD.json`, UTC) and the import dialog's snapshot
 * summary (per-table row counts, null for anything not a recognizable
 * mimir-wiki snapshot).
 */

import { describe, expect, it } from 'vitest'
import { wikiExportFilename, wikiSnapshotSummary } from '../src/client/wiki-transfer.ts'

/** One well-formed minimal v2 snapshot (seven tables, no ledger) for the summary tests. */
function validSnapshot(): unknown {
  return {
    format: 'mimir-wiki',
    version: 2,
    exportedAt: '2026-08-20T12:00:00.000Z',
    tables: {
      papers: [{ arxivId: 'a' }, { arxivId: 'b' }],
      ideas: [],
      claims: [{ id: 'c' }],
      projects: [{ id: 'p' }],
      experiments: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
      servers: [],
      figures: [{ id: 'p:f.png' }],
    },
  }
}

describe('wikiExportFilename', () => {
  it('stamps the UTC date as mimir-wiki-YYYYMMDD.json', () => {
    expect(wikiExportFilename(new Date('2026-08-20T21:53:42.729Z'))).toBe('mimir-wiki-20260820.json')
  })

  it('uses the UTC date, not the local one', () => {
    // 23:30 UTC on the 1st is already the 2nd in UTC+8; the stamp must stay the 1st.
    expect(wikiExportFilename(new Date('2026-01-01T23:30:00.000Z'))).toBe('mimir-wiki-20260101.json')
  })
})

describe('wikiSnapshotSummary', () => {
  it('reads the export timestamp and every table count', () => {
    expect(wikiSnapshotSummary(validSnapshot())).toEqual({
      exportedAt: '2026-08-20T12:00:00.000Z',
      tables: [
        { name: 'papers', count: 2 },
        { name: 'ideas', count: 0 },
        { name: 'claims', count: 1 },
        { name: 'projects', count: 1 },
        { name: 'experiments', count: 3 },
        { name: 'servers', count: 0 },
        { name: 'figures', count: 1 },
      ],
      // A file written before the field existed still gets the historical
      // exclusion list: jobs (runtime state) and the meeting watch list.
      excludedTables: ['jobs', 'venue_watches'],
    })
  })

  it('summarizes a v3 snapshot with the ledger table and its exclusion list', () => {
    const raw = validSnapshot() as { version: number; excludedTables?: unknown; tables: Record<string, unknown> }
    raw.version = 3
    raw.tables['events'] = [{ id: 'ev1' }, { id: 'ev2' }]
    raw.excludedTables = ['jobs', 'venue_watches']
    const summary = wikiSnapshotSummary(raw)
    expect(summary?.tables).toHaveLength(8)
    expect(summary?.tables.at(-1)).toEqual({ name: 'events', count: 2 })
    expect(summary?.excludedTables).toEqual(['jobs', 'venue_watches'])
  })

  it('rejects a v3 snapshot missing the events ledger', () => {
    const raw = validSnapshot() as { version: number }
    raw.version = 3
    expect(wikiSnapshotSummary(raw)).toBeNull()
  })

  it('rejects a v2 snapshot missing one of its seven tables', () => {
    const raw = validSnapshot() as { tables: Record<string, unknown> }
    delete raw.tables['figures']
    expect(wikiSnapshotSummary(raw)).toBeNull()
  })

  it('falls back to the historical exclusion list when the field is malformed', () => {
    const raw = validSnapshot() as { excludedTables?: unknown }
    raw.excludedTables = 'jobs'
    expect(wikiSnapshotSummary(raw)?.excludedTables).toEqual(['jobs', 'venue_watches'])
  })

  it('rejects a wrong format tag', () => {
    const raw = validSnapshot() as { format: string }
    raw.format = 'other-tool'
    expect(wikiSnapshotSummary(raw)).toBeNull()
  })

  it('rejects a wrong snapshot version', () => {
    const raw = validSnapshot() as { version: number }
    raw.version = 1
    expect(wikiSnapshotSummary(raw)).toBeNull()
  })

  it('rejects a missing exportedAt timestamp', () => {
    const raw = validSnapshot() as { exportedAt?: unknown }
    delete raw.exportedAt
    expect(wikiSnapshotSummary(raw)).toBeNull()
  })

  it('rejects a snapshot missing one table array', () => {
    const raw = validSnapshot() as { tables: Record<string, unknown> }
    delete raw.tables['claims']
    expect(wikiSnapshotSummary(raw)).toBeNull()
  })

  it('rejects a table that is not an array', () => {
    const raw = validSnapshot() as { tables: Record<string, unknown> }
    raw.tables['servers'] = { id: 's' }
    expect(wikiSnapshotSummary(raw)).toBeNull()
  })

  it('rejects non-object roots', () => {
    expect(wikiSnapshotSummary(null)).toBeNull()
    expect(wikiSnapshotSummary('mimir-wiki')).toBeNull()
    expect(wikiSnapshotSummary(42)).toBeNull()
  })
})
