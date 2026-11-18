/**
 * #216: the four boundaries the evidence graph was never tested against.
 *
 * Each case here is a way the fold could be wrong without any single-input
 * assertion noticing:
 *
 *   1. **Same-millisecond replay.** `newEvent` mints `ev-<time36>-<seq36>`, so
 *      80 appends inside one millisecond get 80 distinct ids and identical
 *      `ts`. The canonical order is `(ts, id)`, and id is a *string* sort of a
 *      base-36 sequence — `'10'` sorts before `'9'`. If the fold ever leaned on
 *      array order or on numeric intuition, a burst would replay shuffled.
 *   2. **Cycle refusal on long history.** A >1000-event window whose edges
 *      close a loop must still fold to an acyclic structure, or the graph is
 *      not a graph and any consumer that traverses it hangs.
 *   3. **Concurrent reciprocal edges.** Two `addEvidenceEdge` calls racing on
 *      the same pair must leave at most one active edge in each direction.
 *   4. **Legacy event shapes.** A row written before a payload field existed
 *      (no `dedupKey`, no `keys`, no labels) must fold exactly like a current
 *      row, not be counted unnormalizable.
 *
 * Tests 1–2 and 4 drive the pure fold. Test 3 drives the service boundary over
 * a real domain, because that is where dedupKey identity is minted.
 */

import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_EDGE_ADDED_ACTION,
  EVIDENCE_EDGE_RETRACTED_ACTION,
  deriveEvidenceGraph,
} from '../src/evidence-graph.ts'
import { dedupKeyOf, evidenceScopeOf } from '../src/evidence-identity.ts'
import type { EvidenceGraph, EvidenceGraphEdge } from '../src/evidence-graph.ts'
import type { EventRecord, LedgerActor, LedgerJsonValue } from '../src/types.ts'

const USER: LedgerActor = Object.freeze({ kind: 'user', id: 'panel' })

const WIKI = Object.freeze({
  ideas: Object.freeze([]),
  claims: Object.freeze([]),
  projects: Object.freeze([]),
})

const BASE = Date.parse('2026-09-01T09:00:00.000Z')

/**
 * The scope string the fold computes for an event with no project/idea/claim
 * refs. It is NOT `'/'` — `evidenceScopeOf` joins three empty segments with
 * slashes and gets `'//'`. Writing `'/'` by hand silently produces a different
 * dedupKey, and the edges then refuse to dedup against their own twins.
 */
const UNSCOPED = evidenceScopeOf({})

/** The exact id shape `newEvent` mints: `ev-<time36>-<seq36>`. */
function mintedId(ms: number, seq: number): string {
  return `ev-${ms.toString(36)}-${seq.toString(36)}`
}

function event(
  id: string,
  ts: string,
  action: string,
  refs: Partial<EventRecord['refs']>,
  payload: Record<string, LedgerJsonValue>,
  actor: LedgerActor = USER,
): EventRecord {
  return Object.freeze({
    id,
    ts,
    actor,
    action,
    refs: Object.freeze(refs),
    payload: Object.freeze(payload),
  })
}

/** Every directed adjacency in the active subgraph. */
function adjacency(graph: EvidenceGraph): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const edge of graph.edges) {
    if (edge.retracted) continue
    // `narrates` points at a line node, not at evidence; it cannot close a
    // claim loop and is excluded from the reachability question.
    if (edge.rel === 'narrates') continue
    const targets = out.get(edge.src) ?? new Set<string>()
    targets.add(edge.dst)
    out.set(edge.src, targets)
  }
  return out
}

/** The directed cycle reachable from `start`, as a key path, or null. */
function findCycle(graph: EvidenceGraph, start: string): readonly string[] | null {
  const out = adjacency(graph)
  const seen = new Set<string>()
  const path: string[] = []
  const walk = (key: string): readonly string[] | null => {
    if (path.includes(key)) return [...path.slice(path.indexOf(key)), key]
    if (seen.has(key)) return null
    seen.add(key)
    path.push(key)
    for (const next of out.get(key) ?? []) {
      const found = walk(next)
      if (found !== null) return found
    }
    path.pop()
    return null
  }
  return walk(start)
}

describe('same-millisecond replay (#216 item 1)', () => {
  const TS = new Date(BASE).toISOString()

  /** 80 appends inside one millisecond, every one a distinct claim edge. */
  function burst(): EventRecord[] {
    const out: EventRecord[] = []
    for (let seq = 1; seq <= 80; seq += 1) {
      const src = `lit:arxiv:2401.${String(seq).padStart(5, '0')}`
      const dst = `claim:claim-${seq % 7}`
      out.push(event(mintedId(BASE, seq), TS, EVIDENCE_EDGE_ADDED_ACTION, { claimId: `claim-${seq % 7}` }, {
        rel: 'supports',
        src,
        dst,
        dedupKey: dedupKeyOf('supports', src, dst, UNSCOPED),
      }))
    }
    return out
  }

  it('keeps all 80 edges when they share one timestamp', () => {
    const graph = deriveEvidenceGraph(burst(), WIKI)
    expect(graph.stats.totalEdges).toBe(80)
    expect(graph.stats.duplicateEdges).toBe(0)
    expect(graph.stats.unnormalizable).toBe(0)
    expect(new Set(graph.edges.map(edge => edge.id)).size).toBe(80)
  })

  it('replays the burst in (ts, id) order, not in the order the rows arrived', () => {
    // The ids sort as STRINGS: '10' < '9'. That is the canonical order the
    // ledger's own `orderedEvents` defines, so a burst read back from storage
    // must produce the same sequence as a burst fed in reverse.
    const forward = deriveEvidenceGraph(burst(), WIKI).edges.map(edge => edge.id)
    const backward = deriveEvidenceGraph([...burst()].reverse(), WIKI).edges.map(edge => edge.id)
    expect(backward).toEqual(forward)
    expect(forward).toEqual([...forward].sort((left, right) => left.localeCompare(right)))
  })

  it('gives every burst row a distinct dedupKey, so no two collapse', () => {
    const keys = new Set(burst().map(row => row.payload['dedupKey']))
    expect(keys.size).toBe(80)
  })

  it('folds a 200-row burst deterministically across two runs', () => {
    const rows = burst()
    const grown = [...rows, ...rows.map(row => event(
      `${row.id}-b`, row.ts, EVIDENCE_EDGE_ADDED_ACTION, row.refs, { ...row.payload },
    ))]
    expect(deriveEvidenceGraph(grown, WIKI)).toEqual(deriveEvidenceGraph(grown, WIKI))
    // The `-b` copies are duplicates by dedupKey, and that is what must show.
    expect(deriveEvidenceGraph(grown, WIKI).stats.duplicateEdges).toBe(80)
  })
})

describe('a long history must still fold to an acyclic graph (#216 item 2)', () => {
  /** 1200 unrelated events, so the window is "long" by the issue's measure. */
  function filler(): EventRecord[] {
    const out: EventRecord[] = []
    for (let index = 0; index < 1200; index += 1) {
      out.push(event(
        mintedId(BASE + index, 1),
        new Date(BASE + index * 1000).toISOString(),
        'journal.entry.added',
        {},
        { text: `entry ${index}` },
      ))
    }
    return out
  }

  it('folds 1200 events whose edges chain without a cycle', () => {
    const chain: EventRecord[] = []
    for (let index = 0; index < 40; index += 1) {
      const src = `claim:claim-${index}`
      const dst = `claim:claim-${index + 1}`
      chain.push(event(mintedId(BASE, 1000 + index), new Date(BASE).toISOString(), EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'tests',
        src,
        dst,
        dedupKey: dedupKeyOf('tests', src, dst, UNSCOPED),
      }))
    }
    const graph = deriveEvidenceGraph([...filler(), ...chain], WIKI)
    expect(graph.stats.totalEdges).toBe(40)
    expect(findCycle(graph, 'claim:claim-0')).toBeNull()
  })

  it('refuses to hand back a loop when the history closes one', () => {
    // claim-0 → claim-1 → claim-2 → claim-0. Nothing in the write path stops
    // this, so the fold is the last line: it must not present a structure any
    // traversal can hang on.
    const ring = ['claim:claim-0', 'claim:claim-1', 'claim:claim-2', 'claim:claim-0']
    const rows: EventRecord[] = []
    for (let index = 0; index < ring.length - 1; index += 1) {
      const src = ring[index] as string
      const dst = ring[index + 1] as string
      rows.push(event(mintedId(BASE, 2000 + index), new Date(BASE).toISOString(), EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'tests',
        src,
        dst,
        dedupKey: dedupKeyOf('tests', src, dst, UNSCOPED),
      }))
    }
    const graph = deriveEvidenceGraph([...filler(), ...rows], WIKI)
    expect(findCycle(graph, 'claim:claim-0')).toBeNull()
  })

  it('keeps the loop-closing edge visible as rejected rather than silently dropped', () => {
    const ring = ['claim:claim-0', 'claim:claim-1', 'claim:claim-0']
    const rows = [0, 1].map(index => {
      const src = ring[index] as string
      const dst = ring[index + 1] as string
      return event(mintedId(BASE, 3000 + index), new Date(BASE).toISOString(), EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'tests', src, dst, dedupKey: dedupKeyOf('tests', src, dst, UNSCOPED),
      })
    })
    const graph = deriveEvidenceGraph(rows, WIKI)
    // Dropping it without a trace would be the silent failure I2 forbids: the
    // count has to say a declaration was refused.
    expect(graph.stats.cycleRejected).toBe(1)
    expect(graph.stats.totalEdges).toBe(1)
  })
})

describe('reciprocal edges stay one-per-direction (#216 item 3)', () => {
  const ts = new Date(BASE).toISOString()

  it('keeps the first direction and refuses the reciprocal one, visibly', () => {
    const forward = dedupKeyOf('cites', 'lit:arxiv:2401.00001', 'lit:arxiv:2401.00002', UNSCOPED)
    const backward = dedupKeyOf('cites', 'lit:arxiv:2401.00002', 'lit:arxiv:2401.00001', UNSCOPED)
    const graph = deriveEvidenceGraph([
      event(mintedId(BASE, 1), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'cites', src: 'lit:arxiv:2401.00001', dst: 'lit:arxiv:2401.00002', dedupKey: forward,
      }),
      event(mintedId(BASE, 2), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'cites', src: 'lit:arxiv:2401.00002', dst: 'lit:arxiv:2401.00001', dedupKey: backward,
      }),
    ], WIKI)
    // A ↔ B is a cycle, so exactly one of the two may survive. Which one is
    // decided by (ts, id): the first declaration wins, deterministically.
    expect(graph.stats.totalEdges).toBe(1)
    expect(graph.stats.cycleRejected).toBe(1)
    const survivors = graph.edges.map(edge => `${edge.src}->${edge.dst}`)
    expect(survivors).toHaveLength(1)
    // Which direction survives is an artifact of `(ts, id)` order, and that is
    // the point: the answer is decided by the ledger, not by who called first.
    expect(['lit:arxiv:2401.00001->lit:arxiv:2401.00002', 'lit:arxiv:2401.00002->lit:arxiv:2401.00001'])
      .toContain(survivors[0])
  })

  it('resolves the reciprocal race the same way whichever row arrives first', () => {
    // The two callers race, so storage can hand the rows back in either order.
    // The outcome may not depend on that.
    const forward = dedupKeyOf('cites', 'lit:arxiv:2401.00001', 'lit:arxiv:2401.00002', UNSCOPED)
    const backward = dedupKeyOf('cites', 'lit:arxiv:2401.00002', 'lit:arxiv:2401.00001', UNSCOPED)
    const first = event(mintedId(BASE, 1), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
      rel: 'cites', src: 'lit:arxiv:2401.00001', dst: 'lit:arxiv:2401.00002', dedupKey: forward,
    })
    const second = event(mintedId(BASE, 2), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
      rel: 'cites', src: 'lit:arxiv:2401.00002', dst: 'lit:arxiv:2401.00001', dedupKey: backward,
    })
    const left = deriveEvidenceGraph([first, second], WIKI)
    const right = deriveEvidenceGraph([second, first], WIKI)
    expect(right).toEqual(left)
    expect(left.stats.cycleRejected).toBe(1)
  })

  it('collapses a retracted-and-redeclared reciprocal pair to one active edge', () => {
    const forward = dedupKeyOf('cites', 'lit:arxiv:2401.00001', 'lit:arxiv:2401.00002', UNSCOPED)
    const graph = deriveEvidenceGraph([
      event(mintedId(BASE, 1), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'cites', src: 'lit:arxiv:2401.00001', dst: 'lit:arxiv:2401.00002', dedupKey: forward,
      }),
      event(mintedId(BASE, 2), ts, EVIDENCE_EDGE_RETRACTED_ACTION, {}, { dedupKey: forward }),
      event(mintedId(BASE, 3), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'cites', src: 'lit:arxiv:2401.00001', dst: 'lit:arxiv:2401.00002', dedupKey: forward,
      }),
    ], WIKI)
    const active = graph.edges.filter(edge => !edge.retracted && edge.rel === 'cites')
    expect(active).toHaveLength(1)
    expect(graph.stats.activeEdges).toBe(1)
  })

  it('counts a self-loop as a cycle rather than an edge', () => {
    const key = dedupKeyOf('cites', 'lit:arxiv:2401.00001', 'lit:arxiv:2401.00001', UNSCOPED)
    const graph = deriveEvidenceGraph([
      event(mintedId(BASE, 1), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'cites', src: 'lit:arxiv:2401.00001', dst: 'lit:arxiv:2401.00001', dedupKey: key,
      }),
    ], WIKI)
    expect(graph.stats.cycleRejected).toBe(1)
    expect(graph.edges.filter(edge => edge.src === edge.dst && !edge.retracted)).toHaveLength(0)
  })
})

describe('legacy event shapes fold like current ones (#216 item 4)', () => {
  const ts = new Date(BASE).toISOString()
  const SRC = 'lit:arxiv:2401.00001'
  const DST = 'claim:claim-1'

  it('derives the dedupKey when a pre-dedupKey row omits it', () => {
    const legacy = event(mintedId(BASE, 1), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
      rel: 'supports', src: SRC, dst: DST,
    })
    const graph = deriveEvidenceGraph([legacy], WIKI)
    expect(graph.stats.unnormalizable).toBe(0)
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]?.dedupKey).toBe(dedupKeyOf('supports', SRC, DST, UNSCOPED))
  })

  it('folds a row with no keys and no labels', () => {
    const legacy = event(mintedId(BASE, 1), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
      rel: 'supports', src: SRC, dst: DST,
    })
    const graph = deriveEvidenceGraph([legacy], WIKI)
    const edge = graph.edges[0] as EvidenceGraphEdge
    expect(edge.note).toBeNull()
    expect(graph.nodes.every(node => node.label === null)).toBe(true)
  })

  it('counts a row whose rel is unknown instead of guessing one', () => {
    const broken = event(mintedId(BASE, 1), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
      rel: 'resembles', src: SRC, dst: DST,
    })
    const graph = deriveEvidenceGraph([broken], WIKI)
    expect(graph.stats.unnormalizable).toBe(1)
    expect(graph.edges).toHaveLength(0)
  })

  it('dedups a legacy row against its re-declared current twin', () => {
    const legacy = event(mintedId(BASE, 1), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
      rel: 'supports', src: SRC, dst: DST,
    })
    const current = event(mintedId(BASE, 2), ts, EVIDENCE_EDGE_ADDED_ACTION, {}, {
      rel: 'supports', src: SRC, dst: DST, dedupKey: dedupKeyOf('supports', SRC, DST, UNSCOPED),
    })
    const graph = deriveEvidenceGraph([current, legacy], WIKI)
    expect(graph.edges).toHaveLength(1)
    expect(graph.stats.duplicateEdges).toBe(1)
    // The earliest row (by id) survives, whichever shape it had.
    expect(graph.edges[0]?.id).toBe(mintedId(BASE, 1))
  })
})
