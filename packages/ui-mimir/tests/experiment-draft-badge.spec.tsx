/**
 * Render tests for the draft badge on an experiment record (#152).
 *
 * The capture itself is covered in `packages/mimir/tests/metrics-autocapture.spec.ts`;
 * what is asserted here is the panel half of the contract — a record the
 * machine produced says so, and a record a person typed does not. That
 * distinction is the whole reason the field exists: the metric directions on a
 * draft are a guess, and a guess that looks like a reviewed result is worse
 * than no draft at all.
 */

import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ExperimentsView } from '../src/client/ExperimentsView.tsx'
import { zh } from '../src/client/locales.ts'
import type { ResearchArtifactView, ResearchProjectSlice, ResearchServersView } from '../src/client/controller.ts'
import type { ExperimentRecord, MetricDirection } from 'dsh-mimir/types'

/** Locale lookup over the real Chinese dictionary (placeholders left as-is). */
function t(key: string): string {
  return (zh as Record<string, string>)[key] ?? key
}

const SERVER_IDLE: ResearchServersView = { status: 'ready', list: [], failure: null }

const ARTIFACT: ResearchArtifactView = {
  projectId: 'p1',
  name: 'EXPERIMENT_LOG.md',
  status: 'ready',
  content: '',
  mtimeMs: null,
  failure: null,
}

/** One experiment row; `draft` absent unless the test sets it. */
function record(id: string, draft?: boolean): ExperimentRecord {
  return {
    id,
    projectId: 'p1',
    name: `run ${id}`,
    status: 'success',
    metrics: { loss: 0.4 },
    ...(draft === undefined ? {} : { draft }),
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

/** Render the experiments table over the given rows. */
function render(rows: readonly ExperimentRecord[]): string {
  const experiments: ResearchProjectSlice<readonly ExperimentRecord[]> = {
    projectId: 'p1',
    status: 'ready',
    list: rows,
    failure: null,
  }
  return renderToString(
    <ExperimentsView
      experiments={experiments}
      artifact={ARTIFACT}
      servers={SERVER_IDLE}
      projectId="p1"
      ensureServers={() => {}}
      deleteExperiment={() => Promise.resolve(null)}
      updateExperiment={() => Promise.resolve(null)}
      saveExperiment={() => Promise.resolve(null)}
      generateMetricFigure={(_key: string, _rows, _direction: MetricDirection) => Promise.resolve()}
      retry={() => {}}
      t={t}
    />,
  )
}

describe('experiment draft badge (#152)', () => {
  it('marks a captured record with the draft label', () => {
    const html = render([record('exp-draft', true)])
    expect(html).toContain(t('experiments.draft'))
    expect(html).toContain('experimentDraft')
    // The hover text explains why the numbers look authoritative but are not.
    expect(html).toContain(t('experiments.draftHint'))
  })

  it('leaves a hand-written record unmarked', () => {
    const html = render([record('exp-typed')])
    expect(html).not.toContain(t('experiments.draft'))
    expect(html).not.toContain('experimentDraft')
  })

  it('marks only the drafts when the table holds both kinds', () => {
    const html = render([record('exp-typed'), record('exp-draft', true)])
    const badges = html.split(t('experiments.draft')).length - 1
    // One badge in the row plus one in the title attribute's copy of the hint
    // is not possible: the hint is its own string, so the count is exact.
    expect(badges).toBeGreaterThanOrEqual(1)
    expect(html).toContain('run exp-typed')
    expect(html).toContain('run exp-draft')
  })

  it('reads an absent flag as not-a-draft', () => {
    // Every record predating #152 lands here; none of them may gain a badge.
    const html = render([record('exp-legacy', false)])
    expect(html).not.toContain('experimentDraft')
  })
})
