/**
 * The digest (B–F) view — the humanized ledger's headline card: six
 * independent perspectives on the same window, each a list of self-contained
 * experience capsules, plus the (project-only) Eureka EWS table and Mermaid
 * worktree. The report model is rendered directly here (not through the
 * Markdown renderer); the MMS string is what the copy/download buttons
 * export, where `<details>` and Mermaid come alive in a wiki or GitHub.
 *
 * Honesty is carried from the engine: the Eureka table is a description of
 * roads already walked (lead-in entropy vs. its paired control), never a
 * "you are next" prompt — no such prompt exists anywhere in this view.
 * @module dsh-client-ui-mimir/client/DigestView
 */

import { useState } from 'react'
import type {
  ResearchCapsulePerspective,
  ResearchDigestSlice,
  ResearchDigestTier,
  ResearchDigestView,
  ResearchExperienceCapsule,
  ResearchFailureView,
} from './controller.ts'
import type { ResearchKey } from './locales.ts'
import type { ResearchT } from './view-common.ts'
import { ViewHead } from './ViewHead.tsx'
import css from './ResearchPanel.module.css'

/** The three report depths (light → heavy). */
const TIERS: readonly ResearchDigestTier[] = ['weekly', 'monthly', 'project']
/** The two report languages. */
const LANGS: readonly ('zh' | 'en')[] = ['zh', 'en']

/** The "at a glance" big-number table. */
function DigestStatTable({
  stats,
  lang,
}: {
  stats: readonly { readonly key: string; readonly label: { readonly zh: string; readonly en: string }; readonly value: string }[]
  lang: 'zh' | 'en'
}) {
  if (stats.length === 0) return null
  return (
    <table className={css.digestTable}>
      <tbody>
        {stats.map(stat => (
          <tr key={stat.key}>
            <th scope="row">{stat.label[lang]}</th>
            <td>{stat.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** One capsule row: when it happened, its theme/metric, and the evidence ids. */
function CapsuleRow({
  capsule,
  onPin,
  t,
}: {
  capsule: ResearchExperienceCapsule
  onPin?: ((targetEventId: string) => void) | undefined
  t: ResearchT
}) {
  const target = capsule.evidence[0] ?? null
  return (
    <li className={css.digestCapsule}>
      <span className={css.digestCapsuleAt}>{capsule.at}</span>
      {capsule.theme !== null && <span className={css.digestCapsuleTheme}>{capsule.theme}</span>}
      {capsule.metric !== null && <span className={css.digestCapsuleMetric}>{capsule.metric}</span>}
      <span className={css.digestCapsuleEvidence}>{capsule.evidence.join(' · ')}</span>
      {onPin !== undefined && target !== null && (
        <button type="button" className={css.btn} onClick={() => { void onPin(target) }}>
          {t('digest.pin')}
        </button>
      )}
    </li>
  )
}

/**
 * @param props - the digest slice, the selected project (for Eureka scoping),
 * the controller verbs, and copy.
 * @returns the digest card.
 */
export function DigestView({
  digest, selectedProjectId, refreshDigest, generateDigest, setEureka, pinMoment, t,
}: {
  readonly digest: ResearchDigestSlice
  readonly selectedProjectId: string | null
  readonly refreshDigest: () => void
  readonly generateDigest: (tier: ResearchDigestTier, lang: 'zh' | 'en') => Promise<ResearchFailureView | null>
  readonly setEureka: (
    ideaId: string | undefined,
    projectId: string | undefined,
    title: string,
  ) => Promise<ResearchFailureView | null>
  readonly pinMoment: (targetEventId: string, note?: string | undefined) => Promise<ResearchFailureView | null>
  readonly t: ResearchT
}) {
  const [eurekaTitle, setEurekaTitle] = useState('')
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  // Guard: a test or any caller may mount this component without a `digest`
  // prop. The store always supplies one in production, but reading
  // `digest.report` before that check would throw on `undefined`. Render the
  // same idle card used for the `status === 'idle'` branch instead.
  if (digest == null) {
    return (
      <div className={css.reportCard}>
        <ViewHead title={t('digest.title')} subtitle={t('digest.subtitle')} />
        <p className={css.hint}>{t('digest.empty')}</p>
      </div>
    )
  }

  const report: ResearchDigestView | null = digest.report
  const lang = digest.lang

  const onCopy = async (): Promise<void> => {
    if (digest.status !== 'ready' || report === null) return
    try {
      await navigator.clipboard.writeText(digest.markdown)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.setTimeout(() => { setCopyState('idle') }, 1600)
  }

  const onDownload = (): void => {
    if (digest.status !== 'ready' || report === null) return
    const blob = new Blob([digest.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `digest-${report.tier}-${report.asOf}.md`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
  }

  const onDeclareEureka = async (): Promise<void> => {
    const title = eurekaTitle.trim()
    if (title === '' || selectedProjectId === null) return
    const failure = await setEureka(undefined, selectedProjectId, title)
    if (failure === null) setEurekaTitle('')
  }

  return (
    <div className={css.reportCard}>
      <ViewHead title={t('digest.title')} subtitle={t('digest.subtitle')}>
        <button
          type="button"
          className={css.btn}
          onClick={refreshDigest}
          disabled={digest.status === 'loading'}
        >
          {t('ledger.refresh')}
        </button>
      </ViewHead>

      {/* Tier + language switchers. */}
      <div className={css.digestControls}>
        {TIERS.map(value => (
          <button
            key={value}
            type="button"
            className={css.tagPill}
            data-active={digest.tier === value || undefined}
            onClick={() => { void generateDigest(value, lang) }}
          >
            {t(`digest.tier.${value}` as ResearchKey)}
          </button>
        ))}
        <span className={css.digestControlLabel}>{t('digest.lang')}</span>
        {LANGS.map(value => (
          <button
            key={value}
            type="button"
            className={css.tagPill}
            data-active={lang === value || undefined}
            onClick={() => { void generateDigest(digest.tier, value) }}
          >
            {t(`digest.lang.${value}` as ResearchKey)}
          </button>
        ))}
      </div>

      {digest.status === 'idle' && <p className={css.hint}>{t('digest.empty')}</p>}
      {digest.status === 'loading' && <p className={css.hint}>{t('digest.generating')}</p>}
      {digest.status === 'error' && (
        <p className={css.failure} role="status">
          {digest.failure?.message ?? t('digest.failed')}
          <button type="button" className={css.retry} onClick={refreshDigest}>{t('error.retry')}</button>
        </p>
      )}

      {digest.status === 'ready' && report !== null && (
        <div className={css.digestBody}>
          {/* Retrieval declaration (PRISMA-style): where, how many, what stayed silent. */}
          <p className={css.digestRetrieval}>
            <strong>{t('digest.retrieval')}</strong>
            {' · '}{report.retrieval.source}
            {' · '}{report.retrieval.since} → {report.retrieval.until}
            {' · '}{t('digest.events')} {report.retrieval.eventsHit}/{report.retrieval.eventsTotal}
            {' · v'}{report.retrieval.derivationVersion}
            {report.retrieval.silences.length > 0 && (
              <span className={css.digestSilence}> · {report.retrieval.silences.join(' · ')}</span>
            )}
          </p>

          {/* Overview — the big-number table. */}
          <section className={css.digestSection}>
            <h3 className={css.reportCardTitle}>{t('digest.overview')}</h3>
            <DigestStatTable stats={report.overview} lang={lang} />
          </section>

          {/* Six independent perspectives, each a capped list of capsules. */}
          {report.perspectives.map(block => (
            <section key={block.perspective} className={css.digestSection}>
              <h3 className={css.reportCardTitle}>{block.label[lang]}</h3>
              {block.capsules.length === 0
                ? <p className={css.hint}>{t('digest.perspectiveEmpty')}</p>
                : (
                  <ul className={css.digestCapsuleList}>
                    {block.capsules.map(capsule => (
                      <CapsuleRow
                        key={capsule.id}
                        capsule={capsule}
                        onPin={block.perspective === ('moment' as ResearchCapsulePerspective) ? (id => { void pinMoment(id) }) : undefined}
                        t={t}
                      />
                    ))}
                  </ul>
                )}
            </section>
          ))}

          {/* Eureka EWS table (project only) — a description, never a prediction. */}
          {report.eurekaTable.length > 0 && (
            <section className={css.digestSection}>
              <h3 className={css.reportCardTitle}>{t('digest.eureka')}</h3>
              <table className={css.digestTable}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('digest.col.at')}</th>
                    <th>{t('digest.col.title')}</th>
                    <th>{t('digest.col.leadEntropy')}</th>
                    <th>{t('digest.col.controlEntropy')}</th>
                    <th>{t('digest.col.leadSurprisal')}</th>
                    <th>{t('digest.col.controlSurprisal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.eurekaTable.map(row => (
                    <tr key={row.index}>
                      <td>{row.index}</td>
                      <td>{row.at}</td>
                      <td>{row.title}</td>
                      <td>{row.leadEntropyRate ?? '—'}</td>
                      <td>{row.controlEntropyRate ?? '—'}</td>
                      <td>{row.leadMeanSurprisal ?? '—'}</td>
                      <td>{row.controlMeanSurprisal ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className={css.digestNote}>{t('digest.eurekaNote')}</p>
            </section>
          )}

          {/* Mermaid worktree (project only) — raw in the app, alive in a renderer. */}
          {report.mermaid !== null && (
            <section className={css.digestSection}>
              <details>
                <summary>{t('digest.mermaid')}</summary>
                <pre className={css.digestMermaid}><code>{report.mermaid}</code></pre>
              </details>
            </section>
          )}

          {/* In my own words — a single empty task slot for the researcher. */}
          <section className={css.digestSection}>
            <h3 className={css.reportCardTitle}>{t('digest.ownWords')}</h3>
            <ul className={css.digestTasks}>
              <li><input type="checkbox" disabled /> <span>{t('digest.ownWordsSlot')}</span></li>
            </ul>
          </section>

          {/* Copy / download the MMS (where <details> + Mermaid come alive). */}
          <div className={css.viewActions}>
            <button
              type="button"
              className={css.btn}
              onClick={() => { void onCopy() }}
              disabled={digest.status !== 'ready'}
            >
              {copyState === 'copied' ? t('digest.copied') : t('digest.copy')}
            </button>
            <button
              type="button"
              className={css.btn}
              onClick={onDownload}
              disabled={digest.status !== 'ready'}
            >
              {t('digest.download')}
            </button>
          </div>
        </div>
      )}

      {/* Declare an Eureka — the researcher's own milestone, never system-declared. */}
      <section className={css.digestDeclare}>
        <input
          type="text"
          className={css.digestInput}
          placeholder={t('digest.eurekaPlaceholder')}
          value={eurekaTitle}
          onChange={e => setEurekaTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void onDeclareEureka() }}
          disabled={selectedProjectId === null}
        />
        <button
          type="button"
          className={css.btnPrimary}
          onClick={() => { void onDeclareEureka() }}
          disabled={eurekaTitle.trim() === '' || selectedProjectId === null}
        >
          {t('digest.declareEureka')}
        </button>
        {selectedProjectId === null && <span className={css.hint}>{t('digest.eurekaNeedsProject')}</span>}
      </section>
    </div>
  )
}
