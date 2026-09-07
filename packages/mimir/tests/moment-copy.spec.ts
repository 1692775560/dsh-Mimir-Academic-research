/**
 * The zero-verb copy gate (S9b): every rendered candidate reason — for every
 * source, in both locales — must stay free of the banned predictive verbs.
 * This is the constitution's prediction-ban made executable at the UI layer:
 * the system proposes refusable rows; it never urges, predicts, or hints.
 * @module dsh-mimir/tests/moment-copy
 */

import { describe, expect, it } from 'vitest'
import { zh, en } from '../../ui-mimir/src/client/locales.ts'
import { MOMENT_BANNED_WORDS, formatCandidateReason } from '../../ui-mimir/src/client/moments-view.ts'
import type { ResearchMomentView } from '../src/types.ts'

/** The moment copy keys the renderer can emit, per locale record. */
const MOMENT_TEXT_KEYS = [
  'moment.source.burst', 'moment.source.return', 'moment.source.convergence',
  'moment.source.longSitting', 'moment.source.milestone',
  'moment.reason.magnitude', 'moment.reason.closeness',
  'moment.note.speaks', 'moment.note.silent',
] as const

type MomentTextKey = typeof MOMENT_TEXT_KEYS[number]

/** A minimal renderer over one locale record (params substituted like the view). */
function render(key: MomentTextKey, record: Record<string, string>): string {
  let text = record[key] ?? ''
  const params: Record<string, string> = {
    lines: '3', events: '7', span: '95', lead: '6', count: '9',
  }
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, value)
  }
  return text
}

/** A candidate-shaped view row for the full-reason path. */
function candidateRow(sources: string[], closeness: { towardLead: number; featureCount: number } | null): ResearchMomentView {
  return {
    id: 'ev-001',
    at: '2026-08-05T08:00:00Z',
    lineId: 'idea-a',
    lineLabel: 'Alpha',
    kind: 'convergence',
    sources: sources as ResearchMomentView['sources'],
    action: 'knowledge.idea.added',
    note: null,
    pinned: false,
    declined: false,
    canonical: false,
    eventCount: 7,
    stats: {
      eventCount: 7, creationCount: 4, creationRatio: 0.571, netSignedWeight: 3.2,
      distinctLines: 3, lineCounts: [{ lineId: 'idea-a', count: 4 }], spanMinutes: 95, distinctDays: 2,
    },
    closeness: closeness === null ? null : { towardLead: closeness.towardLead, towardControl: 3, featureCount: closeness.featureCount },
    evidence: ['ev-001'],
  }
}

describe('moment copy gate (zero verbs, both locales)', () => {
  it('every moment text key exists in both locales', () => {
    for (const key of MOMENT_TEXT_KEYS) {
      expect(typeof zh[key]).toBe('string')
      expect(typeof en[key]).toBe('string')
    }
  })

  it('no rendered template contains a banned word (zh)', () => {
    for (const key of MOMENT_TEXT_KEYS) {
      const text = render(key, zh as unknown as Record<string, string>)
      for (const banned of MOMENT_BANNED_WORDS) {
        expect(text.includes(banned), `zh ${key} contains banned '${banned}': ${text}`).toBe(false)
      }
    }
  })

  it('no rendered template contains a banned word (en)', () => {
    for (const key of MOMENT_TEXT_KEYS) {
      const text = render(key, en as unknown as Record<string, string>)
      for (const banned of MOMENT_BANNED_WORDS) {
        expect(text.includes(banned), `en ${key} contains banned '${banned}': ${text}`).toBe(false)
      }
    }
  })

  it('the full reason renderer stays verb-free across sources and locales', () => {
    const tZh = (key: string): string => render(key as MomentTextKey, zh as unknown as Record<string, string>)
    const tEn = (key: string): string => render(key as MomentTextKey, en as unknown as Record<string, string>)
    const sourceSets = [
      ['burst'],
      ['return-after-dormancy'],
      ['cross-line-convergence'],
      ['long-sitting'],
      ['milestone'],
      ['burst', 'cross-line-convergence', 'milestone'],
    ]
    for (const sources of sourceSets) {
      for (const closeness of [null, { towardLead: 6, featureCount: 9 }] as const) {
        for (const translate of [tZh, tEn]) {
          const reason = formatCandidateReason(candidateRow(sources, closeness), translate)
          expect(reason.length).toBeGreaterThan(0)
          for (const banned of MOMENT_BANNED_WORDS) {
            expect(reason.includes(banned), `reason contains banned '${banned}': ${reason}`).toBe(false)
          }
        }
      }
    }
  })
})
