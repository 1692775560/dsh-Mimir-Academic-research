/**
 * The constitution's CI audit (I3): governance is self-executing. Every
 * exported scalar constant (number/string, SCREAMING_SNAKE, not vocabulary
 * `*_ACTION` names) of the CBE modules must be registered in
 * PARAMETER_REGISTRY with a matching value, and the registry must hold no
 * stale keys. A new unregistered constant fails this test — the build is
 * the enforcement, not a reviewer's memory.
 * @module dsh-mimir/tests/registry.spec
 */

import { describe, expect, it } from 'vitest'
import * as cognitiveMap from '../src/cognitive-map.ts'
import * as ledger from '../src/ledger.ts'
import * as worktree from '../src/worktree.ts'
import * as cbeEngine from '../src/cbe-engine.ts'
import * as foraging from '../src/foraging.ts'
import * as vocabulary from '../src/vocabulary.ts'
import * as eureka from '../src/eureka.ts'
import * as momentIndex from '../src/moment-index.ts'
import * as ledgerEws from '../src/ledger-ews.ts'
import * as momentCandidates from '../src/moment-candidates.ts'
import { PARAMETER_REGISTRY } from '../src/registry.ts'
import type { CbeParameterEntry } from '../src/registry.ts'

/** The CBE modules whose exported constants are governed. */
const MODULES: ReadonlyArray<Record<string, unknown>> = [cognitiveMap, ledger, worktree, cbeEngine, foraging, vocabulary, eureka, momentIndex, ledgerEws, momentCandidates]

/** A constant name is governed when it looks like one and is not vocabulary. */
function isGovernedScalar(name: string, value: unknown): boolean {
  if (typeof value !== 'number' && typeof value !== 'string') return false
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return false
  return !name.endsWith('_ACTION')
}

describe('parameter registry audit (I3)', () => {
  it('every governed exported scalar is registered with its exact value', () => {
    const missing: string[] = []
    const drifted: string[] = []
    for (const module of MODULES) {
      for (const [name, value] of Object.entries(module)) {
        if (!isGovernedScalar(name, value)) continue
        const entry = PARAMETER_REGISTRY[name]
        if (entry === undefined) {
          missing.push(name)
          continue
        }
        if (entry.value !== value) drifted.push(`${name}: export ${String(value)} vs registry ${String(entry.value)}`)
      }
    }
    expect(missing).toEqual([])
    expect(drifted).toEqual([])
  })

  it('the registry holds no stale keys (every key is a live export)', () => {
    const exported = new Set<string>()
    for (const module of MODULES) {
      for (const name of Object.keys(module)) exported.add(name)
    }
    const stale = Object.keys(PARAMETER_REGISTRY).filter(name => !exported.has(name))
    expect(stale).toEqual([])
  })

  it('every entry carries a track, a real anchor, a real issue, and a review date', () => {
    const shapes: string[] = []
    for (const [name, entry] of Object.entries(PARAMETER_REGISTRY) as [string, CbeParameterEntry][]) {
      if (entry.track !== 'anchored' && entry.track !== 'calibratable' && entry.track !== 'provisional') {
        shapes.push(`${name}: bad track`)
      }
      if (entry.anchor.trim().length < 10) shapes.push(`${name}: anchor too thin`)
      if (entry.issue.trim().length < 10) shapes.push(`${name}: issue too thin`)
      if (Number.isNaN(Date.parse(entry.lastReviewed))) shapes.push(`${name}: bad lastReviewed`)
    }
    expect(shapes).toEqual([])
  })

  it('provisional entries carry a retirement plan (the magic-number ban)', () => {
    const retirementWords = /retire|replace|G1|duel|pending|until|validate|none planned/i
    const lazy: string[] = []
    for (const [name, entry] of Object.entries(PARAMETER_REGISTRY) as [string, CbeParameterEntry][]) {
      if (entry.track === 'provisional' && !retirementWords.test(entry.issue)) lazy.push(name)
    }
    expect(lazy).toEqual([])
  })
})
