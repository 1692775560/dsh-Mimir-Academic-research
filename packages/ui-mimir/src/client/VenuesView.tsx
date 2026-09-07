/**
 * The venues view: the cached ccfddl conference catalog as a filterable card
 * grid (rank badge, countdown, conference date/place, homepage link, and the
 * per-project watch star) plus the static CCF-A journal directory behind a
 * mode toggle. All narrowing is the pure fold in `./venues-view.ts`; the
 * slice loads lazily via `ensureVenues` from the panel.
 * @module dsh-client-ui-mimir/client/VenuesView
 */

import { useMemo, useState } from 'react'
import type { VenueDeadlineView } from 'dsh-mimir/types'
import type { ResearchVenuesView } from './controller.ts'
import { EmptyState } from './EmptyState.tsx'
import { ViewHead } from './ViewHead.tsx'
import { failureCopy, relativeTime, type ResearchT } from './view-common.ts'
import {
  EMPTY_VENUE_FILTER,
  filterJournals,
  filterVenues,
  journalSubs,
  venueCountdownState,
  venueDaysLeft,
  venueFilterSubs,
  type VenueFilter,
  type VenueMode,
} from './venues-view.ts'
import css from './ResearchPanel.module.css'

/** The time-window chip options, in display order. */
const WINDOW_OPTIONS: readonly (number | null)[] = [null, 30, 90]
/** The rank chip options, in display order. */
const RANK_OPTIONS: readonly ('A' | 'B' | 'C' | null)[] = [null, 'A', 'B', 'C']

/** Locale key of one time-window chip. */
function windowKey(days: number | null): 'venues.windowAll' | 'venues.window30' | 'venues.window90' {
  if (days === 30) return 'venues.window30'
  if (days === 90) return 'venues.window90'
  return 'venues.windowAll'
}

/** One conference card: rank badge, countdown, date/place, link, watch star. */
function VenueCard({ venue, watched, watchable, onToggleWatch, nowMs, t }: {
  readonly venue: VenueDeadlineView
  readonly watched: boolean
  /** False without a selected project (watch lists are per-project). */
  readonly watchable: boolean
  readonly onToggleWatch: (seriesKey: string) => void
  readonly nowMs: number
  readonly t: ResearchT
}) {
  const daysLeft = venue.nextDeadlineAt === null ? null : venueDaysLeft(venue.nextDeadlineAt, nowMs)
  const soon = daysLeft !== null && venueCountdownState(daysLeft) === 'soon'
  const hostname = (() => {
    try {
      return new URL(venue.conf.link).hostname
    } catch {
      return venue.conf.link
    }
  })()
  return (
    <article className={css.venueCard} data-watched={watched || undefined}>
      <div className={css.venueCardHead}>
        <span className={css.venueRank} data-rank={venue.ccfRank}>
          {venue.ccfRank === 'N' ? '—' : `CCF-${venue.ccfRank}`}
        </span>
        <h3 className={css.venueCardTitle}>
          {venue.title} {venue.conf.year}
        </h3>
        <button
          type="button"
          className={css.venueWatch}
          data-on={watched || undefined}
          disabled={!watchable}
          aria-pressed={watched}
          aria-label={t(watched ? 'venues.unwatch' : 'venues.watch')}
          title={t(watched ? 'venues.unwatch' : 'venues.watch')}
          onClick={() => { onToggleWatch(venue.key) }}
        >
          {watched ? '★' : '☆'}
        </button>
      </div>
      <p className={css.venueCardDesc} title={venue.description}>{venue.description}</p>
      <p className={css.venueCardDeadline} data-soon={soon || undefined}>
        {daysLeft === null
          ? t('venues.noDeadline')
          : `${t(venue.nextDeadlineKind === 'abstract' ? 'venues.abstract' : 'venues.paper')} · ${t('venues.daysLeft', { days: daysLeft })}`}
      </p>
      <p className={css.venueCardMeta}>
        {[venue.conf.date, venue.conf.place].filter(part => part !== '').join(' · ')}
      </p>
      {venue.conf.link !== '' && (
        <a className={css.venueCardLink} href={venue.conf.link} target="_blank" rel="noreferrer">
          {hostname}
        </a>
      )}
    </article>
  )
}

/**
 * @param props - the venues slice, whether a project is selected (the watch
 * star's gate), the reload/refresh verbs, the watch toggle, and copy.
 * @returns the conference card grid or the journal directory.
 */
export function VenuesView({ venues, hasProject, refreshVenues, refreshVenueCatalog, toggleVenueWatch, t }: {
  readonly venues: ResearchVenuesView
  readonly hasProject: boolean
  readonly refreshVenues: () => void
  readonly refreshVenueCatalog: () => Promise<void>
  readonly toggleVenueWatch: (seriesKey: string) => Promise<void>
  readonly t: ResearchT
}) {
  const [mode, setMode] = useState<VenueMode>('conferences')
  const [filter, setFilter] = useState<VenueFilter>(EMPTY_VENUE_FILTER)
  const [refreshing, setRefreshing] = useState(false)

  const subOptions = useMemo(() => venueFilterSubs(venues.list), [venues.list])
  const journalSubOptions = useMemo(() => journalSubs(venues.journals), [venues.journals])
  const cards = useMemo(
    () => filterVenues(venues.list, venues.watched, filter, Date.now()),
    [venues.list, venues.watched, filter],
  )
  const journals = useMemo(
    () => filterJournals(venues.journals, filter.query, filter.sub),
    [venues.journals, filter.query, filter.sub],
  )

  const subtitle = venues.fetchedAt === null
    ? t('venues.subtitleNever')
    : t('venues.subtitle', { age: relativeTime(t, venues.fetchedAt) })

  return (
    <section className={css.venues}>
      <ViewHead title={t('venues.title')} subtitle={subtitle}>
        <button
          type="button"
          className={css.btn}
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true)
            void refreshVenueCatalog().finally(() => { setRefreshing(false) })
          }}
        >
          {refreshing ? t('venues.refreshing') : t('venues.refresh')}
        </button>
      </ViewHead>

      <div className={css.papersFilters}>
        <button type="button" className={css.tagPill} data-active={mode === 'conferences' || undefined} onClick={() => { setMode('conferences') }}>
          {t('venues.modeConferences')}
        </button>
        <button type="button" className={css.tagPill} data-active={mode === 'journals' || undefined} onClick={() => { setMode('journals') }}>
          {t('venues.modeJournals')}
        </button>
        <input
          type="search"
          className={css.input}
          placeholder={t(mode === 'conferences' ? 'venues.searchConf' : 'venues.searchJournal')}
          value={filter.query}
          onChange={(event) => { setFilter(prev => ({ ...prev, query: event.target.value })) }}
        />
        <select
          className={css.input}
          aria-label={t('venues.fieldAll')}
          value={filter.sub ?? ''}
          onChange={(event) => { setFilter(prev => ({ ...prev, sub: event.target.value === '' ? null : event.target.value })) }}
        >
          <option value="">{t('venues.fieldAll')}</option>
          {(mode === 'conferences' ? subOptions : journalSubOptions).map(sub => (
            <option key={sub} value={sub}>{sub}</option>
          ))}
        </select>
        {mode === 'conferences' && RANK_OPTIONS.map(rank => (
          <button
            key={rank ?? 'all'}
            type="button"
            className={css.tagPill}
            data-active={filter.rank === rank || undefined}
            onClick={() => { setFilter(prev => ({ ...prev, rank })) }}
          >
            {rank === null ? t('venues.rankAll') : `CCF-${rank}`}
          </button>
        ))}
        {mode === 'conferences' && WINDOW_OPTIONS.map(days => (
          <button
            key={days ?? 'all'}
            type="button"
            className={css.tagPill}
            data-active={filter.withinDays === days || undefined}
            onClick={() => { setFilter(prev => ({ ...prev, withinDays: days })) }}
          >
            {t(windowKey(days))}
          </button>
        ))}
      </div>

      {(venues.status === 'cold' || venues.status === 'loading') && (
        <p className={css.hint}>{t('venues.loading')}</p>
      )}
      {venues.status === 'error' && (
        <p className={css.failure} role="status">
          {failureCopy(t, venues.failure) || t('venues.error')}
          <button type="button" className={css.retry} onClick={refreshVenues}>
            {t('venues.retry')}
          </button>
        </p>
      )}
      {venues.status === 'ready' && mode === 'conferences' && venues.list.length === 0 && (
        <EmptyState glyph="📅">{t('venues.empty')}</EmptyState>
      )}
      {venues.status === 'ready' && mode === 'conferences' && venues.list.length > 0 && cards.length === 0 && (
        <EmptyState glyph="🔍">{t('venues.emptyFiltered')}</EmptyState>
      )}
      {venues.status === 'ready' && mode === 'conferences' && cards.length > 0 && (
        <div className={css.venuesGrid}>
          {cards.map(venue => (
            <VenueCard
              key={venue.key}
              venue={venue}
              watched={venues.watched.includes(venue.key)}
              watchable={hasProject}
              onToggleWatch={(seriesKey) => { void toggleVenueWatch(seriesKey) }}
              nowMs={Date.now()}
              t={t}
            />
          ))}
        </div>
      )}
      {venues.status === 'ready' && mode === 'journals' && (
        <div className={css.venuesGrid}>
          {journals.map(journal => (
            <article key={journal.title} className={css.venueCard}>
              <div className={css.venueCardHead}>
                <span className={css.venueRank} data-rank="A">CCF-A</span>
                <h3 className={css.venueCardTitle}>{journal.title}</h3>
              </div>
              <p className={css.venueCardDesc} title={journal.fullName}>{journal.fullName}</p>
              <p className={css.venueCardMeta}>{journal.sub} · {journal.publisher}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
