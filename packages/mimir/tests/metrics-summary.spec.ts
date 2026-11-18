/**
 * Tests for the `metrics.jsonl` summariser (#152, first phase).
 *
 * The issue names three cases that must be covered — a normal run, a missing
 * file, a corrupt file — and asks for the parser to be a pure function so this
 * file needs no server and no temp directory. The missing-file case therefore
 * enters as `''`: the ssh read that would have produced it lives in the shell,
 * and the shell's job is only to hand over text or nothing.
 */

import { describe, expect, it } from 'vitest'
import { metricDirectionOf, summarizeMetrics } from '../src/metrics-summary.ts'

/** One JSONL line. */
function line(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

describe('metricDirectionOf', () => {
  it('reads error-shaped names as lower-is-better', () => {
    for (const name of ['loss', 'val_loss', 'train/loss', 'eval.cer', 'ppl', 'perplexity', 'rmse', 'mae', 'mse', 'latency_ms']) {
      expect(metricDirectionOf(name), name).toBe('min')
    }
  })

  it('reads everything else as higher-is-better', () => {
    for (const name of ['accuracy', 'f1', 'score', 'reward', 'bleu', 'throughput']) {
      expect(metricDirectionOf(name), name).toBe('max')
    }
  })

  it('does not read a name that merely contains a loss word as lower-is-better', () => {
    // `loss_scale` is a hyper-parameter, not a value you minimise; the regex
    // anchors on the tail so only the measured quantity matches.
    expect(metricDirectionOf('loss_scale')).toBe('max')
    expect(metricDirectionOf('error_budget')).toBe('max')
  })
})

describe('summarizeMetrics', () => {
  it('reports the last row and the best value per metric (#152 normal case)', () => {
    const text = [
      line({ step: 1, loss: 2.5, accuracy: 0.61 }),
      line({ step: 2, loss: 1.9, accuracy: 0.70 }),
      line({ step: 3, loss: 2.1, accuracy: 0.68 }),
    ].join('\n')
    const summary = summarizeMetrics(text)
    expect(summary).toBeDefined()
    if (summary === undefined) return
    expect(summary.rows).toBe(3)
    expect(summary.lastStep).toBe(3)
    // "Last" is the highest step's row, not the file's final line.
    expect(summary.last).toEqual({ loss: 2.1, accuracy: 0.68 })
    // Best follows each metric's own direction: loss down, accuracy up.
    expect(summary.best).toEqual({ loss: 1.9, accuracy: 0.70 })
    expect(summary.directions).toEqual({ loss: 'min', accuracy: 'max' })
  })

  it('picks the highest step when a resumed run appends out of order', () => {
    const text = [
      line({ step: 40, loss: 0.9 }),
      line({ step: 12, loss: 3.3 }),
      line({ step: 41, loss: 0.8 }),
    ].join('\n')
    const summary = summarizeMetrics(text)
    expect(summary?.lastStep).toBe(41)
    expect(summary?.last).toEqual({ loss: 0.8 })
  })

  it('returns undefined for an empty file (the missing-file case)', () => {
    expect(summarizeMetrics('')).toBeUndefined()
    expect(summarizeMetrics('\n\n   \n')).toBeUndefined()
  })

  it('returns undefined when no line is usable (the corrupt-file case)', () => {
    expect(summarizeMetrics('not json at all\n{"half": ')).toBeUndefined()
  })

  it('skips the half-written trailing line but keeps the rows above it', () => {
    const text = `${line({ step: 1, loss: 2.0 })}\n${line({ step: 2, loss: 1.7 })}\n{"step": 3, "lo`
    const summary = summarizeMetrics(text)
    expect(summary?.rows).toBe(2)
    expect(summary?.lastStep).toBe(2)
    expect(summary?.last).toEqual({ loss: 1.7 })
  })

  it('drops non-numeric metric values instead of coercing them to NaN', () => {
    const text = [
      line({ step: 1, loss: 2.0, note: 'warming up', flag: true, nested: { a: 1 } }),
      line({ step: 2, loss: 1.5, note: 'done' }),
    ].join('\n')
    const summary = summarizeMetrics(text)
    expect(summary?.last).toEqual({ loss: 1.5 })
    expect(summary?.directions).toEqual({ loss: 'min' })
  })

  it('skips rows whose step is not a finite number', () => {
    const text = [
      line({ step: 'one', loss: 9 }),
      line({ loss: 8 }),
      line({ step: null, loss: 7 }),
      line({ step: 5, loss: 1.1 }),
    ].join('\n')
    const summary = summarizeMetrics(text)
    expect(summary?.rows).toBe(1)
    expect(summary?.last).toEqual({ loss: 1.1 })
  })

  it('carries a metric that appears only in some rows', () => {
    const text = [
      line({ step: 1, loss: 2.0 }),
      line({ step: 2, loss: 1.5, bleu: 0.31 }),
      line({ step: 3, loss: 1.4, bleu: 0.29 }),
    ].join('\n')
    const summary = summarizeMetrics(text)
    expect(summary?.last).toEqual({ loss: 1.4, bleu: 0.29 })
    expect(summary?.best).toEqual({ loss: 1.4, bleu: 0.31 })
  })

  it('ignores blank lines and stray non-object JSON', () => {
    const text = ['', '[]', '42', 'null', line({ step: 1, loss: 2.0 }), ''].join('\n')
    const summary = summarizeMetrics(text)
    expect(summary?.rows).toBe(1)
  })

  it('freezes what it hands out', () => {
    const summary = summarizeMetrics(line({ step: 1, loss: 2.0 }))
    expect(Object.isFrozen(summary)).toBe(true)
    expect(Object.isFrozen(summary?.last)).toBe(true)
    expect(Object.isFrozen(summary?.best)).toBe(true)
    expect(Object.isFrozen(summary?.directions)).toBe(true)
  })
})
