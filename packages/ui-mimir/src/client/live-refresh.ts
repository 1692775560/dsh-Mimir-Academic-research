/**
 * Live-refresh mapping and debounce for the `/research/events` push: which
 * panel slices one wiki change dirties, and the trailing aggregation that
 * turns an agent's burst of writes (say, ten quick literature imports) into
 * one refresh pass. Pure logic — the controller owns the actual reloads.
 * @module dsh-client-ui-mimir/src/client/live-refresh
 */

import type { ResearchWikiChangeEvent } from 'dsh-mimir/types'

/** The panel slices a wiki change can dirty. */
export type LiveSlice =
  | 'projects' | 'papers' | 'experiments' | 'figures' | 'servers' | 'jobs'
  | 'venues' | 'ledger' | 'paper' | 'bibliography'

/**
 * Map one wiki change to the slices showing it. Unknown tables (the CBE
 * internals `ideas`/`claims`, whose views regenerate on demand) map to
 * nothing. The file-side pseudo-tables: `paper-source` (main.tex, keyed by
 * project id) and `bibliography` (the project's .bib).
 * @param event - one change frame from the events stream.
 * @returns the slices to re-read; empty when nothing on screen shows it.
 */
export function slicesForWikiChange(event: ResearchWikiChangeEvent): readonly LiveSlice[] {
  switch (event.table) {
    case 'projects': return ['projects']
    case 'papers': return ['papers']
    case 'experiments': return ['experiments']
    case 'figures': return ['figures']
    case 'servers': return ['servers']
    case 'jobs': return ['jobs']
    case 'venue_watches': return ['venues']
    case 'events': return ['ledger']
    case 'paper-source': return ['paper']
    case 'bibliography': return ['bibliography']
    default: return []
  }
}

/** One change aggregator: collects dirty slices, flushes once after a quiet window. */
export interface WikiChangeAggregator {
  /** Fold one change into the pending set and (re)arm the trailing timer. */
  readonly push: (event: ResearchWikiChangeEvent) => void
  /** Flush the pending set immediately (the visible-again catch-up); a no-op when empty. */
  readonly flushNow: () => void
  /** Drop the pending set and disarm the timer (dispose). */
  readonly cancel: () => void
  /** Whether unflushed slices are pending. */
  readonly pending: () => boolean
}

/**
 * Build the trailing-debounce aggregator behind the panel's live refresh.
 * A push that dirties a NEW slice re-arms the trailing timer, so a burst
 * settles into ONE flush carrying the union; a push adding nothing (an
 * unmappable event, or a table already pending) leaves the timer alone, so a
 * sustained same-table stream cannot postpone the flush forever. The
 * optional max-wait deadline caps the worst case for a stream of DISTINCT
 * slices arriving faster than the quiet window: the flush fires when the
 * deadline hits, carrying whatever is pending.
 * @param flush - receives the dirtied-slice union once per settled batch.
 * @param waitMs - the quiet window length.
 * @param maxWaitMs - optional hard cap from the first push of a batch.
 */
export function createWikiChangeAggregator(
  flush: (slices: ReadonlySet<LiveSlice>) => void,
  waitMs: number,
  maxWaitMs?: number,
): WikiChangeAggregator {
  let slices = new Set<LiveSlice>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  const fire = (): void => {
    if (timer !== null) clearTimeout(timer)
    if (deadline !== null) clearTimeout(deadline)
    timer = null
    deadline = null
    const settled = slices
    slices = new Set()
    if (settled.size > 0) flush(settled)
  }
  return {
    push(event) {
      const before = slices.size
      for (const slice of slicesForWikiChange(event)) slices.add(slice)
      if (slices.size === 0) return
      if (deadline === null && maxWaitMs !== undefined) deadline = setTimeout(fire, maxWaitMs)
      if (slices.size === before) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(fire, waitMs)
    },
    flushNow: fire,
    cancel() {
      if (timer !== null) clearTimeout(timer)
      if (deadline !== null) clearTimeout(deadline)
      timer = null
      deadline = null
      slices = new Set()
    },
    pending: () => slices.size > 0,
  }
}
