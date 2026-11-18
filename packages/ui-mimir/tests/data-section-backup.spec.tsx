/**
 * Render smoke for the overview data card's backup status lines (#227):
 * server-renders the real DataSection with a ready backup slice and asserts
 * the health line actually reaches HTML. The count-only line shipped before
 * this could not distinguish "no backups yet" from "the loop has been failing
 * for hours", so both states are pinned here.
 * @module dsh-client-ui-mimir/tests/data-section-backup.spec
 */

import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { ResearchBackupStatusView } from 'dsh-mimir/types'
import { DataSection } from '../src/client/DataSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { ResearchKey } from '../src/client/locales.ts'
import type { ResearchT } from '../src/client/view-common.ts'

function t(key: ResearchKey, params?: Record<string, string>): string {
  let text: string = zh[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value)
  }
  return text
}

/** A backup slice in its healthy, never-run shape; override per case. */
function backupView(overrides: Partial<ResearchBackupStatusView> = {}): ResearchBackupStatusView {
  return {
    enabled: true, intervalMinutes: 60, keep: 24, count: 3,
    latestName: 'mimir-wiki-20260821-000002.json',
    lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, lastError: null,
    ...overrides,
  }
}

/** Render the card with no export/import work to do. */
function render(backup: ResearchBackupStatusView | null): string {
  return renderToString(
    <DataSection
      backup={backup}
      taskHealth={null}
      exportWiki={() => Promise.reject(new Error('unused'))}
      importWiki={() => Promise.reject(new Error('unused'))}
      t={t as ResearchT}
    />,
  )
}

describe('overview data card backup health (#227)', () => {
  it('shows the cadence and count line while enabled', () => {
    const html = render(backupView())
    expect(html).toContain(zh['overview.backup'])
    expect(html).toContain('3')
    expect(html).toContain(zh['overview.backupStored'])
  })

  it('surfaces the failure streak and the error summary when the loop is failing', () => {
    const html = render(backupView({
      consecutiveFailures: 2,
      lastError: 'EACCES: permission denied',
      lastSuccessAt: '2026-08-21T00:00:01.000Z',
      lastFailureAt: '2026-08-21T01:00:01.000Z',
    }))
    expect(html).toContain(zh['overview.backupFailing'])
    expect(html).toContain('2')
    expect(html).toContain('EACCES: permission denied')
  })

  it('paints the failure line with the danger flag, not as muted metadata', () => {
    const html = render(backupView({ consecutiveFailures: 1, lastError: 'boom' }))
    expect(html).toContain('data-danger="true"')
  })

  it('shows the last success instant once a pass has landed', () => {
    const html = render(backupView({ lastSuccessAt: '2026-08-21T00:00:01.000Z' }))
    expect(html).toContain(zh['overview.backupLastOk'])
    expect(html).not.toContain(zh['overview.backupFailing'])
  })

  it('says nothing about health before the first pass', () => {
    const html = render(backupView())
    expect(html).not.toContain(zh['overview.backupFailing'])
    expect(html).not.toContain(zh['overview.backupLastOk'])
  })

  it('keeps the disabled line free of health copy', () => {
    const html = render(backupView({
      enabled: false, intervalMinutes: 0, keep: 0, count: 0, latestName: null,
      consecutiveFailures: 4, lastError: 'boom',
    }))
    expect(html).toContain(zh['overview.backupDisabled'])
    expect(html).not.toContain(zh['overview.backupFailing'])
  })

  it('hides everything while the slice has not loaded', () => {
    const html = render(null)
    expect(html).not.toContain(zh['overview.backup'])
  })
})
