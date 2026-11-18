/**
 * Summarise one training run's `metrics.jsonl` (#152, first phase).
 *
 * The file is one JSON object per line, `{"step": n, "metric": value, ...}`.
 * Everything here is a pure function of the text: no ssh, no filesystem, no
 * clock. That split is the point of the issue — the parser is testable without
 * a server, so the three cases that matter (a normal run, a missing file, a
 * corrupt file) do not need a fake remote.
 *
 * The preference direction (which way is "better") is not in the file, so
 * {@link metricDirectionOf} guesses it from the metric's name and the guess is
 * written into the draft experiment's `metricDirections` — which the user can
 * then correct in the panel. A guess that is visible and editable beats a
 * silently wrong "best", and it beats refusing to name a best value at all.
 *
 * @module dsh-mimir/src/metrics-summary
 */

import type { MetricDirection } from './types.ts'

/** One metric's value at one step. */
export type MetricSample = Readonly<Record<string, number>>

/** What one `metrics.jsonl` file adds up to. */
export interface MetricsSummary {
  /** Number of usable rows (a row counts when it names a numeric `step`). */
  readonly rows: number
  /** Highest `step` seen; 0 when no row named one. */
  readonly lastStep: number
  /** Every metric's value at the highest step. */
  readonly last: MetricSample
  /** Every metric's best value across all rows, in its preference direction. */
  readonly best: MetricSample
  /** The direction `best` was computed with, per metric. */
  readonly directions: Readonly<Record<string, MetricDirection>>
}

/**
 * Metric names that read as "lower is better".
 *
 * Deliberately small and literal: this only decides a *default* that the user
 * sees and can override. Matching on substrings keeps `val_loss`,
 * `train/loss`, `eval_cer` and `ppl` in one rule without a lookup table that
 * would go stale the moment someone names a metric in another language.
 */
const LOWER_IS_BETTER = /(^|[/_.-])(loss|err|error|cer|wer|perplexity|ppl|rmse|mae|mse|latency|ms|time)$/i

/**
 * Guess one metric's preference direction from its name (#152).
 *
 * `min` for anything that reads as an error or a duration, `max` otherwise —
 * accuracy, F1, score, reward all improve upwards. Names ending in a unit or a
 * ratio are the ambiguous ones, and those are exactly what `metricDirections`
 * on the record exists to correct.
 * @param name - the metric key as written in the file.
 * @returns the guessed direction.
 */
export function metricDirectionOf(name: string): MetricDirection {
  return LOWER_IS_BETTER.test(name.trim()) ? 'min' : 'max'
}

/** One parsed row: its step plus every numeric metric it carried. */
interface MetricsRow {
  readonly step: number
  readonly values: Readonly<Record<string, number>>
}

/**
 * Parse the rows a `metrics.jsonl` file carries.
 *
 * Forgiving about *shape*, strict about *content*: a blank line is skipped, a
 * line that is not JSON is skipped, and a line whose `step` is not a finite
 * number is skipped — a half-written trailing line is the most common real
 * failure (the job was killed mid-append) and losing the whole file over it
 * would be the wrong trade. Non-numeric metric values are dropped rather than
 * coerced, because `Number('done')` is `NaN` and a silent `NaN` in a metric
 * column is worse than a missing one.
 * @param text - the file's full contents.
 * @returns the usable rows, in file order.
 */
function parseRows(text: string): readonly MetricsRow[] {
  const rows: MetricsRow[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    const step = record['step']
    if (typeof step !== 'number' || !Number.isFinite(step)) continue
    const values: Record<string, number> = {}
    for (const [key, value] of Object.entries(record)) {
      if (key === 'step') continue
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      values[key] = value
    }
    rows.push({ step, values })
  }
  return rows
}

/**
 * Reduce one `metrics.jsonl` file to the values a draft record can carry
 * (#152): the last row's metrics, plus each metric's best value.
 *
 * "Last" means the highest `step`, not the last line — a resumed run appends
 * from where it left off, and a file whose tail was written by an earlier
 * attempt must not overwrite a newer step.
 * @param text - the file's full contents (`''` for an empty file).
 * @returns the summary, or `undefined` when the file holds no usable row —
 * which is the "nothing to record" case, not an error.
 */
export function summarizeMetrics(text: string): MetricsSummary | undefined {
  const rows = parseRows(text)
  if (rows.length === 0) return undefined
  let lastRow = rows[0] as MetricsRow
  for (const row of rows) {
    if (row.step >= lastRow.step) lastRow = row
  }
  const names = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row.values)) names.add(key)
  }
  const directions: Record<string, MetricDirection> = {}
  const best: Record<string, number> = {}
  for (const name of names) {
    const direction = metricDirectionOf(name)
    directions[name] = direction
    let chosen: number | undefined
    for (const row of rows) {
      const value = row.values[name]
      if (value === undefined) continue
      if (chosen === undefined
        || (direction === 'min' ? value < chosen : value > chosen)) {
        chosen = value
      }
    }
    if (chosen !== undefined) best[name] = chosen
  }
  return Object.freeze({
    rows: rows.length,
    lastStep: lastRow.step,
    last: Object.freeze({ ...lastRow.values }),
    best: Object.freeze(best),
    directions: Object.freeze(directions),
  })
}
