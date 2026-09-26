/**
 * Pure logic of the ledger (growth record) view: the time-window filter and
 * report options the view asks the controller for, the archive-style
 * timestamp parts, the one-line payload summary of one event, and the report
 * file name for the Markdown download. DOM-free so it is unit-testable.
 * @module dsh-client-ui-mimir/client/ledger-view
 */

import type { EventRecord, LedgerActorKind, ResearchEventFilter, ResearchProgressReportOptions } from 'dsh-mimir/types'

/** One selectable time window of the ledger view. */
export type LedgerWindow = '7d' | '30d' | '90d' | 'all'

/** The time windows in the control row's order. */
export const LEDGER_WINDOWS: readonly LedgerWindow[] = ['7d', '30d', '90d', 'all']

/** The ledger view's event cap (the list's newest-first window). */
export const LEDGER_LIST_LIMIT = 200

/** Days covered by one window; `all` means no lower bound. */
export function windowDays(window: LedgerWindow): number | null {
  switch (window) {
    case '7d': return 7
    case '30d': return 30
    case '90d': return 90
    case 'all': return null
  }
}

/**
 * The `listEvents` filter of one window + scope: ISO bounds (`since`
 * inclusive, `until` exclusive = now), the project scope when one is
 * selected, newest first, capped.
 * @param window - the selected time window.
 * @param projectId - the project scope, or null for all projects.
 * @param nowMs - the wall clock (injectable for tests).
 * @returns the filter for one `listEvents` call.
 */
export function ledgerWindowFilter(
  window: LedgerWindow,
  projectId: string | null,
  nowMs: number,
): ResearchEventFilter {
  const days = windowDays(window)
  return {
    until: new Date(nowMs).toISOString(),
    projectId: projectId ?? undefined,
    order: 'desc',
    limit: LEDGER_LIST_LIMIT,
    // The interface is readonly and the field optional: build the `since`
    // bound at construction instead of mutating.
    ...(days === null ? {} : { since: new Date(nowMs - days * 86_400_000).toISOString() }),
  }
}

/**
 * The `generateProgressReport` options of one window + scope: the same ISO
 * bounds and project filter as {@link ledgerWindowFilter}, without the list
 * fields the report does not take.
 * @param window - the selected time window.
 * @param projectId - the project scope, or null for all projects.
 * @param nowMs - the wall clock (injectable for tests).
 * @returns the options for one `generateProgressReport` call.
 */
export function reportWindowOptions(
  window: LedgerWindow,
  projectId: string | null,
  nowMs: number,
): ResearchProgressReportOptions {
  const days = windowDays(window)
  return {
    projectId: projectId ?? undefined,
    ...(days === null ? {} : { since: new Date(nowMs - days * 86_400_000).toISOString() }),
  }
}

/** The archive-microtext timestamp of one event (local time, compact). */
export interface LedgerTimeParts {
  /** `08-24`, or `2026-08-24` when the event is outside the current year. */
  readonly date: string
  /** `14:32` (local time). */
  readonly time: string
  /** Whether the date part includes the year. */
  readonly hasYear: boolean
}

/**
 * Parse one ISO timestamp into the timeline's two-line microtext form. An
 * unparseable timestamp yields empty parts (the row falls back to raw text).
 * @param iso - the event's ISO-8601 timestamp.
 * @param nowMs - the wall clock for the year-omission rule (injectable).
 * @returns the date/time parts, or null when the timestamp is invalid.
 */
export function ledgerTimeParts(iso: string, nowMs: number): LedgerTimeParts | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const hasYear = date.getFullYear() !== new Date(nowMs).getFullYear()
  return {
    date: hasYear ? `${String(date.getFullYear())}-${monthDay}` : monthDay,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    hasYear,
  }
}

/** Payload keys worth surfacing in the timeline row, in display priority. */
const PAYLOAD_PRIORITY = [
  'name', 'status', 'verdict', 'created', 'mode', 'metricCount', 'issues', 'exitCode', 'level', 'reason',
] as const

/**
 * The one-line summary of an event's payload: up to three `key=value` pairs
 * from the priority keys (or, when none match, the first scalar fields in
 * insertion order). Arrays and nulls are skipped — the row stays one quiet
 * line, the full payload stays on the event.
 * @param event - the ledger event to summarize.
 * @returns the summary line, or '' when the payload carries no scalars.
 */
export function ledgerPayloadLine(event: Pick<EventRecord, 'payload'>): string {
  const parts: string[] = []
  const push = (key: string, value: EventRecord['payload'][string] | undefined): void => {
    if (value === undefined || value === null || typeof value === 'object') return
    parts.push(`${key}=${String(value)}`)
  }
  for (const key of PAYLOAD_PRIORITY) push(key, event.payload[key])
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(event.payload)) {
      push(key, value)
      if (parts.length >= 3) break
    }
  }
  return parts.slice(0, 3).join(' · ')
}

/** Whether one event is marked destructive in its payload. */
export function ledgerIsDestructive(event: Pick<EventRecord, 'payload'>): boolean {
  return event.payload['destructive'] === true
}

/** Locale key of one actor kind label. */
export const ACTOR_KEYS: Record<LedgerActorKind, string> = {
  user: 'ledger.actor.user',
  agent: 'ledger.actor.agent',
  subagent: 'ledger.actor.subagent',
  module: 'ledger.actor.module',
  system: 'ledger.actor.system',
}

/**
 * The Markdown download file name of one report: dated from the report's
 * `generatedAt` (falling back to now), so a week of reports keep separate
 * files.
 * @param generatedAt - the report's ISO timestamp, or null before one settles.
 * @param nowMs - the wall clock fallback (injectable for tests).
 * @returns e.g. `mimir-progress-2026-08-24.md`.
 */
export function reportFileName(generatedAt: string | null, nowMs: number): string {
  const base = generatedAt !== null && !Number.isNaN(new Date(generatedAt).getTime())
    ? new Date(generatedAt)
    : new Date(nowMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`
  return `mimir-progress-${date}.md`
}
