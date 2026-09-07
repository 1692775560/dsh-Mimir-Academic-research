/**
 * The moments timeline (S9b) view-model helpers: grouping and the zero-verb
 * candidate reasons. Everything here is STRUCTURED-DATA → SENTENCE glue; the
 * banned-words CI test (`tests/moment-copy.spec.ts`) audits the rendered
 * strings, so no imperative or predictive verb may appear — the system
 * proposes refusable rows, it never urges, ranks, or predicts.
 * @module dsh-client-ui-mimir/client/moments-view
 */

import type {
  ResearchMomentIndexView,
  ResearchMomentView,
} from 'dsh-mimir/types'

/** Words the candidate copy must never contain (prediction-ban, enforced by CI). */
export const MOMENT_BANNED_WORDS = [
  '接近', '逼近', '突破', '在即', '建议', '应该', '值得', '快要',
  'approaching', 'breakthrough', 'near', 'should', 'consider', 'worth', 'on track',
] as const

/** The three reading groups of the unified timeline. */
export type MomentGroup = 'canonical' | 'candidate' | 'declined'

/** Group one row: canonical (pin/eureka) → candidate (unrefused) → declined. */
export function groupOf(moment: ResearchMomentView): MomentGroup {
  if (moment.canonical) return 'canonical'
  if (moment.declined) return 'declined'
  return 'candidate'
}

/** The (at, id)-ordered rows split into the three groups, order preserved. */
export function groupMoments(
  view: ResearchMomentIndexView,
): Readonly<Record<MomentGroup, readonly ResearchMomentView[]>> {
  const out: Record<MomentGroup, ResearchMomentView[]> = {
    canonical: [], candidate: [], declined: [],
  }
  for (const moment of view.moments) {
    out[groupOf(moment)].push(moment)
  }
  return Object.freeze({
    canonical: Object.freeze(out.canonical),
    candidate: Object.freeze(out.candidate),
    declined: Object.freeze(out.declined),
  })
}

/** One source's descriptive phrase (the structure, stated as a fact). */
function sourceReason(source: string, stats: ResearchMomentView['stats'], t: (key: string) => string): string {
  switch (source) {
    case 'burst':
      return t('moment.source.burst')
    case 'return-after-dormancy':
      return t('moment.source.return')
    case 'cross-line-convergence':
      return t('moment.source.convergence').replace('{lines}', String(stats.distinctLines))
    case 'long-sitting':
      return t('moment.source.longSitting')
    case 'milestone':
      return t('moment.source.milestone')
    default:
      return source
  }
}

/**
 * The one-line reason of a candidate row: its sources' phrases joined, plus
 * the magnitude — pure description, zero verbs. The closeness footnote is
 * appended ONLY when the profile speaks (the caller checks `view.speaks`).
 */
export function formatCandidateReason(
  moment: ResearchMomentView,
  t: (key: string) => string,
): string {
  const parts = moment.sources.map(source => sourceReason(source, moment.stats, t))
  const magnitude = t('moment.reason.magnitude')
    .replace('{events}', String(moment.stats.eventCount))
    .replace('{span}', String(moment.stats.spanMinutes))
  const line = parts.length === 0 ? magnitude : `${parts.join(' · ')} · ${magnitude}`
  if (moment.closeness !== null) {
    const closeness = t('moment.reason.closeness')
      .replace('{lead}', String(moment.closeness.towardLead))
      .replace('{count}', String(moment.closeness.featureCount))
    return `${line} · ${closeness}`
  }
  return line
}
