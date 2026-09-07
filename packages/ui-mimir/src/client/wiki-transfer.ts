/**
 * The overview data section's pure helpers: the export download's filename
 * and the import dialog's snapshot summary (per-table row counts read from a
 * parsed JSON file). The summary is a display-level shape check only — the
 * Host revalidates every row on import. DOM-free so both rules are
 * unit-testable.
 * @module dsh-client-ui-mimir/client/wiki-transfer
 */

import type { ResearchWikiTableName } from 'dsh-mimir/types'

/** The six wiki tables, in display order (kept in sync with the Host's list). */
export const WIKI_TABLE_LABELS: readonly ResearchWikiTableName[] = [
  'papers', 'ideas', 'claims', 'projects', 'experiments', 'servers',
]

/** The export download's filename: `mimir-wiki-YYYYMMDD.json` (UTC date). */
export function wikiExportFilename(date: Date): string {
  const stamp = date.toISOString().slice(0, 10).replaceAll('-', '')
  return `mimir-wiki-${stamp}.json`
}

/** One table's row in the import summary. */
export interface WikiSnapshotTableCount {
  readonly name: ResearchWikiTableName
  readonly count: number
}

/** The import dialog's summary of one parsed snapshot file. */
export interface WikiSnapshotSummary {
  readonly exportedAt: string
  readonly tables: readonly WikiSnapshotTableCount[]
}

/**
 * Summarize one parsed export file for the import dialog: per-table row
 * counts plus the export timestamp. Returns null for anything that is not a
 * recognizable mimir-wiki snapshot (bad format/version, missing table
 * arrays) so the dialog can refuse it before it reaches the Host.
 */
export function wikiSnapshotSummary(raw: unknown): WikiSnapshotSummary | null {
  if (typeof raw !== 'object' || raw === null) return null
  const snapshot = raw as {
    format?: unknown
    version?: unknown
    exportedAt?: unknown
    tables?: unknown
  }
  // v2 (seven tables) is still importable; v3 adds the `events` ledger.
  if (snapshot.format !== 'mimir-wiki') return null
  if (snapshot.version !== 2 && snapshot.version !== 3) return null
  if (typeof snapshot.exportedAt !== 'string') return null
  if (typeof snapshot.tables !== 'object' || snapshot.tables === null) return null
  const tables = snapshot.tables as Record<string, unknown>
  const counts: WikiSnapshotTableCount[] = []
  for (const name of WIKI_TABLE_LABELS) {
    const rows = tables[name]
    if (!Array.isArray(rows)) return null
    counts.push({ name, count: rows.length })
  }
  return { exportedAt: snapshot.exportedAt, tables: counts }
}
