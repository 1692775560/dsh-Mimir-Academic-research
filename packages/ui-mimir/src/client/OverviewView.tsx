/**
 * The overview view: the selected project's card — title, the five-stage
 * pipeline progress (idea→plan→experiment→writing→done), review-round count,
 * paper directory, artifact list, and the last-updated timestamp — preceded
 * by the stat chips (papers/experiments/figures counts gathered from the
 * other views), followed by the recent-activity card (the five latest remote
 * jobs and the five latest experiment runs of the project), the growth-record
 * entry link (the ledger tab), and the data section (scheduled-backup
 * status, wiki export/import).
 * @module dsh-client-ui-mimir/client/OverviewView
 */

import type { ResearchBackupStatusView, ResearchImportWikiMode, ResearchProjectView, ResearchWikiSnapshot } from 'dsh-mimir/types'
import type { ResearchKey } from './locales.ts'
import type { ResearchFailureView, ResearchJobsView, ResearchProjectSlice } from './controller.ts'
import type { ExperimentRecord } from 'dsh-mimir/types'
import { relativeTime, STAGE_KEYS, STAGES } from './view-common.ts'
import type { ResearchT } from './view-common.ts'
import { DataSection } from './DataSection.tsx'
import { EmptyState } from './EmptyState.tsx'
import { ViewHead } from './ViewHead.tsx'
import css from './ResearchPanel.module.css'

/** The overview's stat chips; null marks a view not yet loaded. */
export interface OverviewStats {
  readonly papers: number | null
  readonly experiments: number | null
  readonly figures: number | null
  readonly servers: number | null
  /** Catalog deadlines landing within 30 days; null until the venues slice loads. */
  readonly venues: number | null
}

/** How many rows each recent-activity column lists. */
const ACTIVITY_LIMIT = 5

/**
 * @param props - the selected project row (undefined before selection), the
 * stat-chip counts gathered from the other views, the remote-jobs slice and
 * the project's experiments slice (the recent-activity card), the wiki
 * export/import verbs, and copy.
 * @returns the overview card, or the no-selection hint.
 */
export function OverviewView({ project, stats, backup, jobs, experiments, openLedger, exportWiki, importWiki, t }: {
  readonly project: ResearchProjectView | undefined
  readonly stats: OverviewStats
  /** Scheduled-backup status line; null hides it (not loaded yet). */
  readonly backup: ResearchBackupStatusView | null
  /** Every submitted remote job, most recent first (the activity card's jobs column). */
  readonly jobs: ResearchJobsView
  /** The selected project's experiments slice (the activity card's experiments column). */
  readonly experiments: ResearchProjectSlice<readonly ExperimentRecord[]> | null
  /** Switch the workbench to the ledger (growth record) tab. */
  readonly openLedger: () => void
  readonly exportWiki: () => Promise<ResearchWikiSnapshot | ResearchFailureView>
  readonly importWiki: (
    snapshot: unknown,
    mode: ResearchImportWikiMode,
    confirmReplace: boolean,
  ) => Promise<{ imported: Record<string, number>; skipped: Record<string, number> } | ResearchFailureView>
  readonly t: ResearchT
}) {
  if (project === undefined) {
    return <EmptyState glyph="🧭">{t('overview.noProject')}</EmptyState>
  }
  const stageIndex = STAGES.indexOf(project.stage)
  const chips: ReadonlyArray<{ key: ResearchKey; value: number | null }> = [
    { key: 'overview.statPapers', value: stats.papers },
    { key: 'overview.statExperiments', value: stats.experiments },
    { key: 'overview.statFigures', value: stats.figures },
    { key: 'overview.statServers', value: stats.servers },
    { key: 'overview.statVenues', value: stats.venues },
  ]
  // The jobs slice arrives most-recent-first already; the experiments slice
  // needs a sort by updatedAt. Both columns cap at ACTIVITY_LIMIT rows.
  const recentJobs = jobs.status === 'ready' ? jobs.list.slice(0, ACTIVITY_LIMIT) : null
  const recentExperiments = experiments !== null
    && experiments.projectId === project.id
    && experiments.status === 'ready'
    ? [...experiments.list]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, ACTIVITY_LIMIT)
    : null
  return (
    <div className={css.overviewWrap}>
      <ViewHead title={t('tab.overview')} subtitle={t('view.overview.subtitle')} />
      <div className={css.statChips}>
        {chips.map(chip => (
          <span key={chip.key} className={css.statChip}>
            <span className={css.statValue}>{chip.value === null ? '—' : chip.value}</span>
            <span className={css.statLabel}>{t(chip.key)}</span>
          </span>
        ))}
      </div>
      <div className={css.overviewCard}>
        <h2 className={css.overviewTitle}>{project.title}</h2>
        <ol className={css.stageBar} aria-label={t(STAGE_KEYS[project.stage])}>
          {STAGES.map((stage, index) => (
            <li
              key={stage}
              className={css.stageStep}
              data-reached={index <= stageIndex || undefined}
              data-current={index === stageIndex || undefined}
            >
              {t(STAGE_KEYS[stage])}
            </li>
          ))}
        </ol>
        <dl className={css.overviewMeta}>
          <div>
            <dt>{t('project.reviewRounds')}</dt>
            <dd>{project.reviewRounds}</dd>
          </div>
          <div>
            <dt>{t('overview.paperDir')}</dt>
            <dd><code>{project.paperDir ?? 'paper'}</code></dd>
          </div>
          <div>
            <dt>{t('overview.updatedAt')}</dt>
            <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
          </div>
        </dl>
        <h3 className={css.sectionTitle}>{t('overview.artifacts')}</h3>
        {project.artifacts.length === 0
          ? <p className={css.hint}>{t('overview.noArtifacts')}</p>
          : (
            <ul className={css.artifactList}>
              {project.artifacts.map(artifact => <li key={artifact}><code>{artifact}</code></li>)}
            </ul>
          )}
        <button type="button" className={css.ledgerLink} onClick={openLedger}>
          {t('overview.openLedger')} <span aria-hidden>→</span>
        </button>
      </div>
      <div className={css.activitySection}>
        <h3 className={css.sectionTitle}>{t('overview.activity')}</h3>
        <div className={css.activityGrid}>
          <section>
            <h4 className={css.activityColTitle}>{t('overview.recentJobs')}</h4>
            {recentJobs === null ? (
              <p className={css.hint}>{t('projects.loading')}</p>
            ) : recentJobs.length === 0 ? (
              <p className={css.hint}>{t('overview.noJobs')}</p>
            ) : (
              <ul className={css.activityList}>
                {recentJobs.map(job => (
                  <li key={job.id} className={css.activityItem}>
                    <span className={css.activityName} title={job.command}><code>{job.command}</code></span>
                    <span className={css.jobStatus} data-status={job.status}>
                      {t(`jobStatus.${job.status}`)}
                    </span>
                    <span className={css.activityTime}>{relativeTime(t, job.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h4 className={css.activityColTitle}>{t('overview.recentExperiments')}</h4>
            {recentExperiments === null ? (
              <p className={css.hint}>{t('projects.loading')}</p>
            ) : recentExperiments.length === 0 ? (
              <p className={css.hint}>{t('experiments.empty')}</p>
            ) : (
              <ul className={css.activityList}>
                {recentExperiments.map(record => (
                  <li key={record.id} className={css.activityItem}>
                    <span className={css.activityName} title={record.name}>{record.name}</span>
                    <span className={css.experimentStatus} data-status={record.status}>
                      {t(`experimentStatus.${record.status}`)}
                    </span>
                    <span className={css.activityTime}>{relativeTime(t, record.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      <DataSection backup={backup} exportWiki={exportWiki} importWiki={importWiki} t={t} />
    </div>
  )
}
