/**
 * The moments timeline (S9b) card of the ledger view: the unified timeline
 * over the five deterministic candidate sources, read pull-only. Three
 * groups — canonical (the researcher's pins and declared Eurekas),
 * candidates (proposed, refusable), declined (seen and refused) — each in
 * (at, id) order with NO ranking and NO scores. Candidate copy is zero-verb
 * (structure stated as fact; the banned-words CI test audits it); the
 * closeness footnote renders only while the eureka profile speaks. Pin /
 * decline / declare are the researcher's actions — the buttons are
 * affordances for declarations, not system suggestions.
 * @module dsh-client-ui-mimir/client/MomentsView
 */

import type { ResearchMomentView } from 'dsh-mimir/types'
import type { ResearchMomentsSlice } from './controller.ts'
import type { ResearchT } from './view-common.ts'
import { formatCandidateReason, groupMoments } from './moments-view.ts'
import css from './ResearchPanel.module.css'

/** One row of the timeline: the group-styled body plus its action buttons. */
function MomentRow({ moment, onPin, onDecline, onDeclare, t }: {
  readonly moment: ResearchMomentView
  readonly onPin: (targetEventId: string) => void
  readonly onDecline: (targetEventId: string) => void
  readonly onDeclare: () => void
  readonly t: ResearchT
}) {
  return (
    <li className={css.ledgerRow} data-declined={moment.declined || undefined}>
      <span className={css.ledgerTime} title={moment.at}>
        <span className={css.ledgerTimeDate}>{moment.at.slice(0, 10)}</span>
        <span className={css.ledgerTimeClock}>{moment.at.slice(11, 16)}</span>
      </span>
      <span className={css.ledgerNode} aria-hidden />
      <div className={css.ledgerBody}>
        <div className={css.ledgerLine}>
          <span className={css.tagPill} data-active={moment.canonical || undefined}>
            {t(`moment.kind.${moment.kind}`)}
          </span>
          {moment.lineLabel !== null && (
            <span className={css.actorBadge}>{moment.lineLabel}</span>
          )}
          {moment.note !== null && <span>{moment.note}</span>}
        </div>
        <p className={css.ledgerDetail}>
          {formatCandidateReason(moment, t as (key: string) => string)}
        </p>
        <div className={css.viewActions}>
          {!moment.pinned && (
            <button type="button" className={css.btn} onClick={() => { onPin(moment.id) }}>
              {t('moment.action.pin')}
            </button>
          )}
          {!moment.canonical && !moment.declined && (
            <button type="button" className={css.btn} onClick={() => { onDecline(moment.id) }}>
              {t('moment.action.decline')}
            </button>
          )}
          {moment.kind === 'eureka' && (
            <button type="button" className={css.btn} onClick={() => { onDeclare() }}>
              {t('moment.action.context')}
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

/**
 * @param props - the moments slice, the refresh/pin/decline/declare verbs, and copy.
 * @returns the moments timeline card (three groups, zero verbs, no ranking).
 */
export function MomentsView({
  moments, refreshMoments, pinMoment, declineMoment, t,
}: {
  readonly moments: ResearchMomentsSlice
  readonly refreshMoments: () => void
  readonly pinMoment: (targetEventId: string, note?: string | undefined) => Promise<unknown>
  readonly declineMoment: (targetEventId: string) => Promise<unknown>
  readonly t: ResearchT
}) {
  const view = moments.view
  return (
    <section className={css.reportCard}>
      <div className={css.reportCardHead}>
        <h3 className={css.reportCardTitle}>{t('moment.title')}</h3>
        <div className={css.viewActions}>
          <button
            type="button"
            className={css.btn}
            onClick={refreshMoments}
            disabled={moments.status === 'loading'}
          >
            {t('moment.refresh')}
          </button>
        </div>
      </div>
      {(moments.status === 'cold' || moments.status === 'loading') && (
        <p className={css.hint}>{t('moment.loading')}</p>
      )}
      {moments.status === 'error' && (
        <p className={css.failure} role="status">
          {moments.failure?.message ?? t('moment.failed')}
          <button type="button" className={css.retry} onClick={refreshMoments}>
            {t('error.retry')}
          </button>
        </p>
      )}
      {moments.status === 'ready' && view !== null && (
        <>
          <p className={css.hint}>
            {view.speaks ? t('moment.note.speaks') : t('moment.note.silent')}
          </p>
          {view.retrieval.truncated && (
            <p className={css.hint}>{view.retrieval.silences.join(' · ')}</p>
          )}
          {view.moments.length === 0 && <p className={css.hint}>{t('moment.empty')}</p>}
          {(() => {
            const groups = groupMoments(view)
            return (
              <>
                {groups.canonical.length > 0 && (
                  <>
                    <h4 className={css.reportCardTitle}>{t('moment.group.canonical')}</h4>
                    <ul className={css.ledgerList}>
                      {groups.canonical.map(moment => (
                        <MomentRow
                          key={moment.id}
                          moment={moment}
                          onPin={id => { void pinMoment(id) }}
                          onDecline={id => { void declineMoment(id) }}
                          onDeclare={() => {}}
                          t={t}
                        />
                      ))}
                    </ul>
                  </>
                )}
                {groups.candidate.length > 0 && (
                  <>
                    <h4 className={css.reportCardTitle}>{t('moment.group.candidate')}</h4>
                    <ul className={css.ledgerList}>
                      {groups.candidate.map(moment => (
                        <MomentRow
                          key={moment.id}
                          moment={moment}
                          onPin={id => { void pinMoment(id) }}
                          onDecline={id => { void declineMoment(id) }}
                          onDeclare={() => {}}
                          t={t}
                        />
                      ))}
                    </ul>
                  </>
                )}
                {groups.declined.length > 0 && (
                  <>
                    <h4 className={css.reportCardTitle}>{t('moment.group.declined')}</h4>
                    <ul className={css.ledgerList}>
                      {groups.declined.map(moment => (
                        <MomentRow
                          key={moment.id}
                          moment={moment}
                          onPin={id => { void pinMoment(id) }}
                          onDecline={id => { void declineMoment(id) }}
                          onDeclare={() => {}}
                          t={t}
                        />
                      ))}
                    </ul>
                  </>
                )}
              </>
            )
          })()}
        </>
      )}
    </section>
  )
}
