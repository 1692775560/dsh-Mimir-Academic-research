/**
 * Behavior tests for the experiments comparison-chart helpers: which metric
 * keys earn a chart, which runs form a chart's rows, how bar widths
 * normalize, and how values print.
 */

import { describe, expect, it } from 'vitest'
import type { ExperimentRecord } from 'dsh-mimir/types'
import {
  barSpans,
  bestRowIndex,
  chartNameLines,
  formatDurationMs,
  formatMetricValue,
  metricChartRows,
  metricDirectionsOf,
  numericMetricKeys,
  zeroLinePct,
} from '../src/client/view-common.ts'

/** One experiment fixture; only the fields the helpers read. */
function run(id: string, metrics: Record<string, number | string>, updatedAt: string): ExperimentRecord {
  return { id, projectId: 'p1', name: id, status: 'success', metrics, updatedAt }
}

describe('numericMetricKeys', () => {
  it('keeps only numeric keys shared by at least two runs, sorted', () => {
    const keys = numericMetricKeys([
      run('e1', { mpjpe: 92.4, 'pa-mpjpe': 61.2, note: 'a' }, '2026-08-01T00:00:00Z'),
      run('e2', { mpjpe: 88.1, 'pa-mpjpe': 58.7 }, '2026-08-02T00:00:00Z'),
      // A key only one run carries has nothing to compare against.
      run('e3', { mpjpe: 90.0, throughput: 12 }, '2026-08-03T00:00:00Z'),
    ])
    expect(keys).toEqual(['mpjpe', 'pa-mpjpe'])
  })

  it('returns no keys without numeric metrics (the empty state)', () => {
    expect(numericMetricKeys([])).toEqual([])
    expect(numericMetricKeys([
      run('e1', { note: 'x' }, '2026-08-01T00:00:00Z'),
      run('e2', {}, '2026-08-02T00:00:00Z'),
    ])).toEqual([])
    // Non-finite numbers never earn a chart.
    expect(numericMetricKeys([
      run('e1', { loss: Number.NaN }, '2026-08-01T00:00:00Z'),
      run('e2', { loss: Number.POSITIVE_INFINITY }, '2026-08-02T00:00:00Z'),
    ])).toEqual([])
  })
})

describe('metricChartRows', () => {
  it('collects the numeric carriers of one key, oldest first', () => {
    const rows = metricChartRows([
      run('newest', { mpjpe: 88.1 }, '2026-08-03T00:00:00Z'),
      run('skipped', { mpjpe: 'n/a' }, '2026-08-02T00:00:00Z'),
      run('missing', {}, '2026-08-01T00:00:00Z'),
      run('oldest', { mpjpe: 92.4 }, '2026-07-30T00:00:00Z'),
    ], 'mpjpe')
    expect(rows.map(row => row.id)).toEqual(['oldest', 'newest'])
    expect(rows.map(row => row.value)).toEqual([92.4, 88.1])
  })
})

describe('barSpans', () => {
  it('normalizes non-negative charts to the largest value, zero at the lane edge', () => {
    expect(barSpans([92.4, 88.1, 46.2])).toEqual([
      { leftPct: 0, widthPct: 100, negative: false },
      { leftPct: 0, widthPct: (88.1 / 92.4) * 100, negative: false },
      { leftPct: 0, widthPct: 50, negative: false },
    ])
  })

  it('collapses an all-zero chart to zero-width bars', () => {
    expect(barSpans([0, 0])).toEqual([
      { leftPct: 0, widthPct: 0, negative: false },
      { leftPct: 0, widthPct: 0, negative: false },
    ])
    expect(barSpans([])).toEqual([])
  })

  it('extends negative bars left of the zero line (#220)', () => {
    // Lane spans [-2, 1] → 3 units; zero sits at 2/3 of the lane.
    expect(barSpans([-2, 1])).toEqual([
      { leftPct: 0, widthPct: (2 / 3) * 100, negative: true },
      { leftPct: (2 / 3) * 100, widthPct: (1 / 3) * 100, negative: false },
    ])
  })

  it('keeps an all-negative chart on the zero baseline (bars grow leftward)', () => {
    expect(barSpans([-1, -2])).toEqual([
      { leftPct: 50, widthPct: 50, negative: true },
      { leftPct: 0, widthPct: 100, negative: true },
    ])
  })
})

describe('zeroLinePct', () => {
  it('returns null when no value is negative (the lane edge IS the zero line)', () => {
    expect(zeroLinePct([0, 3])).toBeNull()
    expect(zeroLinePct([])).toBeNull()
  })

  it('positions the zero line inside the lane when a value is negative', () => {
    expect(zeroLinePct([-2, 1])).toBe((2 / 3) * 100)
    expect(zeroLinePct([-1, -2])).toBe(100)
  })
})

describe('bestRowIndex', () => {
  const rows = metricChartRows([
    run('e1', { loss: 0.8 }, '2026-08-01T00:00:00Z'),
    run('e2', { loss: 0.5 }, '2026-08-02T00:00:00Z'),
    run('e3', { loss: 0.9 }, '2026-08-03T00:00:00Z'),
  ], 'loss')

  it('picks the smallest value for min and the largest for max', () => {
    expect(bestRowIndex(rows, 'min')).toBe(1)
    expect(bestRowIndex(rows, 'max')).toBe(2)
  })

  it('highlights nothing for none and keeps the earliest row on ties', () => {
    expect(bestRowIndex(rows, 'none')).toBeNull()
    expect(bestRowIndex([], 'min')).toBeNull()
    const tied = metricChartRows([
      run('t1', { loss: 0.5 }, '2026-08-01T00:00:00Z'),
      run('t2', { loss: 0.5 }, '2026-08-02T00:00:00Z'),
    ], 'loss')
    expect(bestRowIndex(tied, 'min')).toBe(0)
  })
})

describe('metricDirectionsOf', () => {
  it('merges per-record directions with the later-updated record winning', () => {
    const directions = metricDirectionsOf([
      { ...run('new', { acc: 90 }, '2026-08-02T00:00:00Z'), metricDirections: { acc: 'max' } },
      { ...run('old', { acc: 80, loss: 0.5 }, '2026-08-01T00:00:00Z'), metricDirections: { acc: 'min', loss: 'min' } },
    ])
    expect(directions).toEqual({ acc: 'max', loss: 'min' })
  })

  it('treats records without the field as contributing nothing', () => {
    expect(metricDirectionsOf([run('e1', { loss: 1 }, '2026-08-01T00:00:00Z')])).toEqual({})
  })
})

describe('formatMetricValue', () => {
  it('prints integers as-is and rounds other numbers to four significant digits', () => {
    expect(formatMetricValue(92.4)).toBe('92.4')
    expect(formatMetricValue(88.123456)).toBe('88.12')
    expect(formatMetricValue(0.002345678)).toBe('0.002346')
    expect(formatMetricValue(123456)).toBe('123456')
    expect(formatMetricValue('n/a')).toBe('n/a')
  })
})

describe('chartNameLines', () => {
  it('keeps a short name on one line', () => {
    expect(chartNameLines('消融：FAPE 编码开关')).toEqual(['消融：FAPE 编码开关'])
    expect(chartNameLines('full model')).toEqual(['full model'])
  })

  it('wraps a long name greedily at a word boundary without ellipsizing the tail', () => {
    expect(chartNameLines('基线复现：EgoHMR 在 EgoBody 上的指标')).toEqual([
      '基线复现：EgoHMR 在',
      'EgoBody 上的指标',
    ])
  })

  it('wraps a long latin name at the last space inside the budget', () => {
    const [first, second] = chartNameLines('full model: EgoSync whole body recovery')
    expect(first).toBe('full model: EgoSync')
    expect(second).toBe('whole body recovery')
  })

  it('ellipsizes the second line when two lines still overflow', () => {
    const [first, second] = chartNameLines(
      '完整模型：EgoSync-full 在 EgoBody3D 全量数据集上的长序列压力测试指标',
    )
    expect(first).toBe('完整模型：')
    expect(second?.endsWith('…')).toBe(true)
    // The ellipsized tail keeps the full name out of the bar lane.
    expect(chartNameLines('完整模型：EgoSync-full 在 EgoBody3D 全量数据集上的长序列压力测试指标')[1])
      .not.toContain('指标')
  })
})

describe('formatDurationMs', () => {
  it('prints sub-second runs as ms, sub-minute runs as seconds, longer runs as minutes', () => {
    expect(formatDurationMs(950)).toBe('950ms')
    expect(formatDurationMs(12_340)).toBe('12.3s')
    expect(formatDurationMs(192_000)).toBe('3.2min')
  })

  it('prints an empty string for non-finite or negative input', () => {
    expect(formatDurationMs(Number.NaN)).toBe('')
    expect(formatDurationMs(-5)).toBe('')
  })
})
