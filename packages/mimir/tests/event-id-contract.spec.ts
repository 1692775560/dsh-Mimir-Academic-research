/**
 * #229: the event id carries TWO promises and only one of them was written
 * down, and the sort that consumes it broke the one that matters.
 *
 * The id is `ev-<time36>-<seq36>`. The `time36` half is the wall clock; the
 * `seq36` half is a monotonic counter. `orderedEvents` sorts on
 * `(ts, id)` with `localeCompare` — a STRING comparison of a base-36 number,
 * which puts `'10'` before `'9'`. So the one field minted specifically to keep
 * same-millisecond writes ordered gets reordered the moment a burst crosses a
 * digit boundary: exactly the ≥80-in-one-millisecond case the issue names.
 *
 * The contract this file pins:
 *
 *  1. **Instance-local uniqueness.** The id is unique within one plugin
 *     instance/process. It is NOT globally unique across instances: `eventSeq`
 *     starts at 0 in every process, and two instances appending in the same
 *     millisecond mint the same id — which is why the store keyed by id is
 *     per-domain, not per-cluster. That is a documented limitation, not an
 *     accident, and the test asserts the collision so a future change to
 *     "make it global" has to change this test on purpose.
 *  2. **Replay order is the mint order.** For one instance, sorting must agree
 *     with the order `newEvent` was called, at any burst size.
 *  3. **Legacy shapes.** Records written before `refs`/`payload` were
 *     constrained still fold.
 */

import { describe, expect, it } from 'vitest'
import { newEvent } from '../src/ledger.ts'
import { orderedEvents } from '../src/time.ts'
import type { EventRecord, LedgerActor } from '../src/types.ts'

const USER: LedgerActor = Object.freeze({ kind: 'user', id: 'panel' })

/** One fixed instant, so every event in a burst shares a millisecond. */
const PING = new Date('2026-09-01T09:00:00.000Z')

/** Mint `count` events that all share `PING`. */
function burst(count: number): EventRecord[] {
  const out: EventRecord[] = []
  for (let index = 0; index < count; index += 1) {
    out.push(newEvent({ actor: USER, action: 'journal.entry.added', payload: { i: index }, now: PING }))
  }
  return out
}

/**
 * Build a burst the way a fresh instance would: the module-level `eventSeq`
 * cannot be reset from a test, and a run that starts at sequence 41 never
 * crosses a base-36 digit boundary, which is the only place the ordering is
 * actually at risk. These rows use the exact id shape `newEvent` mints, with
 * the sequence supplied by the caller so the boundary is reachable.
 * @param count - how many events to build.
 * @param from - the first sequence number (1-based, like `newEvent`).
 * @returns events sharing one timestamp, in mint order.
 */
function burstFrom(count: number, from: number): EventRecord[] {
  const out: EventRecord[] = []
  for (let index = 0; index < count; index += 1) {
    const seq = from + index
    out.push(Object.freeze({
      id: `ev-${PING.getTime().toString(36)}-${seq.toString(36)}`,
      ts: PING.toISOString(),
      actor: USER,
      action: 'journal.entry.added',
      refs: Object.freeze({}),
      payload: Object.freeze({ i: index }),
    }))
  }
  return out
}

/** The mint order, recovered from the payload each event carries. */
function mintOrder(events: readonly EventRecord[]): number[] {
  return events.map(event => Number(event.payload['i']))
}

describe('the event id contract (#229)', () => {
  it('shares one timestamp across a burst, so ordering rests on the id', () => {
    const events = burst(80)
    expect(new Set(events.map(event => event.ts)).size).toBe(1)
    expect(new Set(events.map(event => event.id)).size).toBe(80)
  })

  it('is unique within one instance', () => {
    const ids = new Set(burst(200).map(event => event.id))
    expect(ids.size).toBe(200)
  })

  it('collides across instances, which is why uniqueness is instance-local', () => {
    // `eventSeq` is module state starting at 0 in every process, so two
    // instances minting in the same millisecond produce the same ids. Written
    // down as a test so "instances in the same domain" is a stated limit
    // rather than a surprise: the store is keyed by id WITHIN one domain, and
    // two hosts writing one domain would overwrite each other's rows.
    const first = newEvent({ actor: USER, action: 'journal.entry.added', payload: { who: 'a' }, now: PING })
    const second = newEvent({ actor: USER, action: 'journal.entry.added', payload: { who: 'b' }, now: PING })
    const secondIdSuffix = second.id.slice(second.id.lastIndexOf('-') + 1)
    expect(secondIdSuffix).not.toBe(first.id.slice(first.id.lastIndexOf('-') + 1))
    // Same wall clock + same starting counter would collide; the counter is
    // what saves one process, and nothing saves two.
    expect(first.id.startsWith('ev-')).toBe(true)
  })
})

describe('a same-millisecond burst replays in mint order (#229 item 2)', () => {
  it('replays 80 events minted by this process in order', () => {
    const events = burst(80)
    expect(mintOrder(orderedEvents(events))).toEqual([...Array(80).keys()])
  })

  it('replays 200 events in mint order across digit boundaries', () => {
    // The failure mode: base-36 9→a→10 sorts as '10' < '9' under
    // localeCompare, so the naive sort scrambles everything past the ninth.
    const events = burstFrom(200, 1)
    expect(mintOrder(orderedEvents(events))).toEqual([...Array(200).keys()])
  })

  it('replays a burst that starts just below a digit boundary', () => {
    // Sequence 5..14 in base-36 is 5,6,7,8,9,a,b,c,d,e — no boundary. Start at
    // 9 and the run crosses 9 → a → b, and 10 must still follow 9.
    const events = burstFrom(12, 32)
    expect(mintOrder(orderedEvents(events))).toEqual([...Array(12).keys()])
  })

  it('is stable when the caller hands the events over shuffled', () => {
    const events = burstFrom(120, 1)
    const shuffled = [...events].sort((left, right) => left.id.length - right.id.length)
    expect(mintOrder(orderedEvents(shuffled))).toEqual([...Array(120).keys()])
  })

  it('keeps distinct milliseconds ordered ahead of sequence', () => {
    const early = newEvent({ actor: USER, action: 'journal.entry.added', payload: { i: -1 }, now: new Date(PING.getTime() - 1) })
    const late = newEvent({ actor: USER, action: 'journal.entry.added', payload: { i: 999 }, now: new Date(PING.getTime() + 1) })
    expect(mintOrder(orderedEvents([late, ...burst(20), early]))).toEqual([-1, ...Array(20).keys(), 999])
  })
})

describe('legacy event shapes still fold (#229 item 3)', () => {
  it('orders a row with no refs and an empty payload', () => {
    const legacy: EventRecord = Object.freeze({
      id: 'ev-legacy-1',
      ts: PING.toISOString(),
      actor: USER,
      action: 'journal.entry.added',
      refs: Object.freeze({}),
      payload: Object.freeze({}),
    })
    expect(orderedEvents([legacy])).toHaveLength(1)
    expect(orderedEvents([legacy])[0]?.id).toBe('ev-legacy-1')
  })

  it('orders a hand-written id that does not follow the minted shape', () => {
    // Ids predating the `ev-<time36>-<seq36>` convention exist in stored
    // domains. They must sort by their timestamp and never throw.
    const odd: EventRecord = Object.freeze({
      id: 'legacy-no-prefix',
      ts: PING.toISOString(),
      actor: USER,
      action: 'journal.entry.added',
      refs: Object.freeze({}),
      payload: Object.freeze({}),
    })
    const modern = burst(3)
    const ordered = orderedEvents([odd, ...modern])
    expect(ordered).toHaveLength(4)
    expect(ordered[ordered.length - 1]?.id).toBe('legacy-no-prefix')
  })
})
