/**
 * The figures view's AI-organize in-flight marker: poll cadence, wall-clock
 * budget, and the pure retire decision shared by the poll tick and the
 * signature-watch effect. Extracted so the decision is unit-testable without
 * a DOM.
 * @module dsh-client-ui-mimir/client/figure-organize
 */

/** Poll cadence of the figure list while an AI organize request is in flight. */
export const ORGANIZE_POLL_MS = 5000

/**
 * Wall-clock budget of one AI organize request. The marker times out past it
 * even when the list signature never moved (the agent declined or failed
 * silently), so the view never spins "整理中" forever.
 */
export const ORGANIZE_TIMEOUT_MS = 120_000

/** The in-flight marker: the list signature the request started from and its start time. */
export interface OrganizeMarker {
  readonly anchor: string
  readonly startedAt: number
}

/**
 * Whether the in-flight marker retires: the list signature moved off the
 * anchor (the agent's writes landed) or the request timed out. Evaluated on
 * every poll tick — not only on signature changes — so an organize that
 * never changes the list still times out.
 * @param marker - the in-flight marker.
 * @param listSignature - the current figure-list signature ('' while loading).
 * @param now - the current wall-clock time in milliseconds.
 * @returns whether the caller should drop the marker.
 */
export function organizeMarkerRetired(marker: OrganizeMarker, listSignature: string, now: number): boolean {
  return (listSignature !== '' && listSignature !== marker.anchor)
    || now - marker.startedAt > ORGANIZE_TIMEOUT_MS
}
