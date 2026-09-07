/**
 * Feasibility proof for the ledger EWS layer: entropy measures recovery
 * known ground truth before any of it touches the Eureka engine. A constant
 * stream must read 0 bits, four equally likely actions must read 2 bits, a
 * perfectly alternating stream must have zero conditional entropy and full
 * symbolic persistence — and every conditional quantity must go null below
 * the sample floor rather than report an unsupportable number.
 * @module dsh-mimir/tests/ledger-ews
 */

import { describe, expect, it } from 'vitest'
import {
  actionSequence,
  conditionalEntropy,
  ewsOrder,
  ewsReading,
  surprisalSequence,
  unigramEntropy,
  CBE_EWS_MAX_ORDER,
  CBE_EWS_MIN_EVENTS,
} from '../src/ledger-ews.ts'
import type { EventRecord, LedgerActor, LedgerJsonValue } from '../src/types.ts'

const USER: LedgerActor = { kind: 'user', id: 'panel' }
const MIN = 60_000
const BASE = Date.parse('2026-08-01T00:00:00.000Z')

let seq = 0
function ev(ts: string, action: string): EventRecord {
  seq += 1
  return Object.freeze({
    id: `ev-${String(seq).padStart(4, '0')}`,
    ts,
    actor: USER,
    action,
    refs: Object.freeze({}),
    payload: Object.freeze({} as Record<string, LedgerJsonValue>),
  })
}

/** One event per slot, far enough apart to stay one window. */
function stream(actions: readonly string[]): EventRecord[] {
  return actions.map((action, index) => ev(new Date(BASE + index * MIN).toISOString(), action))
}

const FROM = BASE - 1
const TO = BASE + 10_000 * MIN

describe('symbol projection', () => {
  it('projects the window onto action names in time order', () => {
    const events = [
      ev(new Date(BASE + 2 * MIN).toISOString(), 'b'),
      ev(new Date(BASE + 1 * MIN).toISOString(), 'a'),
    ]
    expect(actionSequence(events, FROM, TO)).toEqual(['a', 'b'])
  })

  it('drops unparseable timestamps and out-of-window events', () => {
    const events = [
      ev('not-a-date', 'x'),
      ev(new Date(BASE).toISOString(), 'inside'),
      ev(new Date(BASE + 100_000 * MIN).toISOString(), 'outside'),
    ]
    expect(actionSequence(events, FROM, TO)).toEqual(['inside'])
  })
})

describe('unigram entropy', () => {
  it('reads zero for a stream that never varies', () => {
    expect(unigramEntropy(Array.from({ length: 16 }, () => 'a'))).toBe(0)
  })

  it('reads exactly 1 bit for two equally likely actions', () => {
    const symbols = Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 'a' : 'b'))
    expect(unigramEntropy(symbols)).toBe(1)
  })

  it('reads exactly 2 bits for four equally likely actions', () => {
    const symbols = Array.from({ length: 16 }, (_, i) => ['a', 'b', 'c', 'd'][i % 4] as string)
    expect(unigramEntropy(symbols)).toBe(2)
  })
})

describe('conditional entropy', () => {
  it('reads zero for a perfectly alternating stream', () => {
    const symbols = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 'a' : 'b'))
    expect(conditionalEntropy(symbols, 1)).toBe(0)
  })

  it('is strictly lower than the unigram entropy when the stream has structure', () => {
    const symbols = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 'a' : 'b'))
    expect(conditionalEntropy(symbols, 1)).toBeLessThan(unigramEntropy(symbols))
  })

  it('separates an unpredictable stream from a structured one', () => {
    const structured = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 'a' : 'b'))
    // Deterministic pseudo-random (LCG) over four symbols — no Math.random,
    // so a failure reproduces exactly.
    const alphabet = ['a', 'b', 'c', 'd']
    let state = 12345
    const random = Array.from({ length: 60 }, () => {
      state = (state * 1664525 + 1013904223) % 4294967296
      // HIGH bits only: an LCG's low bits cycle with a tiny period, which
      // would make this "random" stream perfectly predictable at order 1.
      return alphabet[Math.floor((state / 4294967296) * 4)] as string
    })
    expect(conditionalEntropy(structured, 1)).toBe(0)
    expect(conditionalEntropy(random, 1)).toBeGreaterThan(0)
    // And the structured stream is the more persistent of the two.
    expect(conditionalEntropy(random, 1)).toBeGreaterThan(conditionalEntropy(structured, 1) ?? 0)
  })

  it('refuses to report below the sample floor', () => {
    const short = Array.from({ length: CBE_EWS_MIN_EVENTS - 1 }, (_, i) => (i % 2 === 0 ? 'a' : 'b'))
    expect(conditionalEntropy(short, 1)).toBeNull()
  })

  it('refuses an order the sample cannot carry', () => {
    const symbols = Array.from({ length: CBE_EWS_MIN_EVENTS }, (_, i) => (i % 2 === 0 ? 'a' : 'b'))
    // k = 12 leaves 0 transitions: unsupportable, so null rather than 0.
    expect(conditionalEntropy(symbols, CBE_EWS_MIN_EVENTS)).toBeNull()
  })
})

describe('adaptive order', () => {
  it('is 0 below the floor and never exceeds the cap', () => {
    expect(ewsOrder(CBE_EWS_MIN_EVENTS - 1, 4)).toBe(0)
    for (const n of [20, 50, 200, 5000]) {
      const order = ewsOrder(n, 6)
      expect(order).toBeGreaterThanOrEqual(0)
      expect(order).toBeLessThanOrEqual(CBE_EWS_MAX_ORDER)
    }
  })

  it('grows with the sample', () => {
    expect(ewsOrder(5000, 6)).toBeGreaterThanOrEqual(ewsOrder(CBE_EWS_MIN_EVENTS, 6))
  })
})

describe('surprisal', () => {
  it('leaves the first `order` positions without history', () => {
    const symbols = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 'a' : 'b'))
    const surprisals = surprisalSequence(symbols, 2)
    expect(surprisals[0]).toBeNull()
    expect(surprisals[1]).toBeNull()
    expect(surprisals[2]).not.toBeNull()
  })

  it('reads zero surprise through a perfectly alternating stream', () => {
    const symbols = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 'a' : 'b'))
    const known = surprisalSequence(symbols, 1).filter(v => v !== null)
    expect(known.every(value => value === 0)).toBe(true)
  })

  it('returns all nulls below the floor', () => {
    const short = Array.from({ length: 5 }, () => 'a')
    expect(surprisalSequence(short, 1).every(v => v === null)).toBe(true)
  })
})

describe('window reading', () => {
  it('reports full symbolic persistence for a perfectly alternating stream', () => {
    const reading = ewsReading(
      stream(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 'a' : 'b'))),
      FROM, TO,
    )
    expect(reading.symbols).toBe(40)
    expect(reading.distinct).toBe(2)
    expect(reading.unigramEntropy).toBe(1)
    expect(reading.conditionalEntropy).toBe(0)
    // H1 − H(1) = 1 − 0: the previous action fully determines the next.
    expect(reading.lag1MutualInformation).toBe(1)
    expect(reading.meanSurprisal).toBe(0)
  })

  it('goes null on every conditional quantity below the floor', () => {
    const reading = ewsReading(stream(Array.from({ length: 3 }, () => 'a')), FROM, TO)
    expect(reading.symbols).toBe(3)
    // H₁ is gated too: three symbols reading as 0 bits would look like
    // "perfectly predictable", which is a claim about nothing.
    expect(reading.unigramEntropy).toBeNull()
    expect(reading.conditionalEntropy).toBeNull()
    expect(reading.lag1MutualInformation).toBeNull()
    expect(reading.meanSurprisal).toBeNull()
    expect(reading.order).toBe(0)
  })

  it('is an empty reading for an empty window, not a crash', () => {
    const reading = ewsReading([], FROM, TO)
    expect(reading.symbols).toBe(0)
    expect(reading.unigramEntropy).toBeNull()
    expect(reading.conditionalEntropy).toBeNull()
  })

  it('freezes its result', () => {
    expect(Object.isFrozen(ewsReading(stream(['a', 'b', 'a']), FROM, TO))).toBe(true)
  })
})
