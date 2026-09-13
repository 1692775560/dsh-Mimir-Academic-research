/**
 * The experiments view's inline create/edit form helpers: the metrics
 * key/value row editor's pure rules. Rows are the form's editable
 * representation (both fields stay text); `metricsFromRows` folds them back
 * into the record's `Record<string, number | string>` — empty keys drop, and
 * a value that fully parses as a finite number is stored as a number.
 * DOM-free so every rule is unit-testable.
 * @module dsh-client-ui-mimir/client/experiment-form
 */

import type { MetricDirection } from 'dsh-mimir/types'

/** One editable metrics row: key and value stay raw text while editing. */
export interface MetricRow {
  readonly key: string
  readonly value: string
  /** Preference direction of the metric (#220); `none` = unordered. */
  readonly direction: MetricDirection
}

/**
 * Expand a record's metrics into editable rows (values stringified), each
 * row carrying the metric's stored direction (absent reads as `none`, #220).
 * @param metrics - the stored metrics map.
 * @param directions - the stored per-metric directions, when the record has any.
 * @returns one row per entry, in insertion order.
 */
export function metricRowsFromMetrics(
  metrics: Record<string, number | string>,
  directions?: Record<string, MetricDirection> | undefined,
): MetricRow[] {
  return Object.entries(metrics).map(([key, value]) => ({
    key,
    value: String(value),
    direction: directions?.[key] ?? 'none',
  }))
}

/**
 * Fold the editor's rows into a metrics map: rows whose key trims to empty
 * drop; values are trimmed, and a trimmed value that parses fully as a
 * finite number (`Number`) is stored as a number, otherwise as the trimmed
 * string. Later rows with the same trimmed key win.
 * @param rows - the editor's rows.
 * @returns the metrics map for the upsert payload.
 */
export function metricsFromRows(rows: readonly MetricRow[]): Record<string, number | string> {
  const metrics: Record<string, number | string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key === '') continue
    const value = row.value.trim()
    const numeric = value === '' ? Number.NaN : Number(value)
    metrics[key] = Number.isFinite(numeric) ? numeric : value
  }
  return metrics
}

/**
 * Fold the editor's rows into a metric-directions map (#220): keys follow
 * the same trim/dedupe rules as {@link metricsFromRows}, and `none` entries
 * are omitted so the stored map only carries real preferences.
 * @param rows - the editor's rows.
 * @returns the directions map for the upsert payload.
 */
export function directionsFromRows(rows: readonly MetricRow[]): Record<string, MetricDirection> {
  const directions: Record<string, MetricDirection> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key === '') continue
    // Last write wins like `metricsFromRows`: a later `none` row retracts an
    // earlier preference for the same key.
    if (row.direction === 'none') delete directions[key]
    else directions[key] = row.direction
  }
  return directions
}
