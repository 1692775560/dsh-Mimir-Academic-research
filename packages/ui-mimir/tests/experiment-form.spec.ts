/**
 * Behavior tests for the experiments form's metrics row editor helpers:
 * expanding stored metrics into editable rows (directions included, #220),
 * and folding rows back with empty-key filtering, trimming, number
 * conversion, last-write-wins, and direction collection.
 */

import { describe, expect, it } from 'vitest'
import {
  directionsFromRows,
  metricRowsFromMetrics,
  metricsFromRows,
} from '../src/client/experiment-form.ts'

describe('metricRowsFromMetrics', () => {
  it('expands entries in order, stringifying values, defaulting direction to none', () => {
    expect(metricRowsFromMetrics({ mpjpe: 92.4, note: 'warmup' })).toEqual([
      { key: 'mpjpe', value: '92.4', direction: 'none' },
      { key: 'note', value: 'warmup', direction: 'none' },
    ])
    expect(metricRowsFromMetrics({})).toEqual([])
  })

  it('carries the stored direction of each metric (#220)', () => {
    expect(metricRowsFromMetrics(
      { loss: 0.5, acc: 0.9 },
      { loss: 'min', acc: 'max' },
    )).toEqual([
      { key: 'loss', value: '0.5', direction: 'min' },
      { key: 'acc', value: '0.9', direction: 'max' },
    ])
  })
})

describe('metricsFromRows', () => {
  it('drops rows whose key trims to empty', () => {
    expect(metricsFromRows([
      { key: '', value: '1', direction: 'none' },
      { key: '   ', value: '2', direction: 'none' },
      { key: 'acc', value: '0.9', direction: 'max' },
    ])).toEqual({ acc: 0.9 })
  })

  it('stores fully numeric values as numbers, everything else as trimmed strings', () => {
    expect(metricsFromRows([
      { key: 'mpjpe', value: ' 88.1 ', direction: 'min' },
      { key: 'epochs', value: '1e3', direction: 'none' },
      { key: 'note', value: '  warmup  ', direction: 'none' },
      { key: 'partial', value: '12abc', direction: 'none' },
      { key: 'empty', value: '', direction: 'none' },
    ])).toEqual({ mpjpe: 88.1, epochs: 1000, note: 'warmup', partial: '12abc', empty: '' })
  })

  it('trims keys, and a later row with the same key wins', () => {
    expect(metricsFromRows([
      { key: ' loss ', value: '0.5', direction: 'min' },
      { key: 'loss', value: '0.4', direction: 'min' },
    ])).toEqual({ loss: 0.4 })
  })
})

describe('directionsFromRows', () => {
  it('collects real preferences only: none entries and empty keys drop (#220)', () => {
    expect(directionsFromRows([
      { key: 'loss', value: '0.5', direction: 'min' },
      { key: 'acc', value: '0.9', direction: 'max' },
      { key: 'note', value: 'x', direction: 'none' },
      { key: '  ', value: '1', direction: 'min' },
    ])).toEqual({ loss: 'min', acc: 'max' })
    expect(directionsFromRows([])).toEqual({})
  })

  it('trims keys, and a later row with the same key wins', () => {
    expect(directionsFromRows([
      { key: ' loss ', value: '0.5', direction: 'min' },
      { key: 'loss', value: '0.4', direction: 'none' },
    ])).toEqual({})
  })
})
