/**
 * Pure helpers behind the sidebar's project management: the create/rename
 * title rule (a client-side mirror of the Host's `project-admin` guard, so an
 * invalid title never leaves the panel) and the session-switcher projection —
 * the dsh session list folded into the small immutable view the panel renders.
 * DOM-free so both are unit-testable.
 * @module dsh-client-ui-mimir/client/project-form
 */

/** Title length cap of one project (mirrors the Host's project-admin rule). */
export const PROJECT_TITLE_MAX_LENGTH = 200

/**
 * Trim and validate one project title (create and rename share the rule).
 * @param title - the raw input.
 * @returns the cleaned title, or null when it is blank or over the cap.
 */
export function cleanProjectTitle(title: string): string | null {
  const cleaned = title.trim()
  return cleaned.length > 0 && cleaned.length <= PROJECT_TITLE_MAX_LENGTH ? cleaned : null
}

/** One session row of the switcher: the delivery target of "… with AI" verbs. */
export interface ResearchSessionEntry {
  readonly id: string
  readonly title: string
  readonly running: boolean
}

/** The session switcher's immutable view: the list plus the current selection. */
export interface ResearchSessionListView {
  readonly current: string | null
  readonly list: readonly ResearchSessionEntry[]
}

/** The slice of the dsh session-list snapshot the projection reads. */
export interface SessionListSource {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, { readonly displayTitle: string; readonly running: boolean } | undefined>>
  readonly current: string | undefined
}

/**
 * Project one dsh session-list snapshot into the switcher view.
 * @param state - the sessions service's list snapshot.
 * @returns the panel-facing view (current = null when nothing is selected).
 */
export function sessionListView(state: SessionListSource): ResearchSessionListView {
  return Object.freeze({
    current: state.current ?? null,
    list: Object.freeze(state.ids.map(id => Object.freeze({
      id,
      title: state.byId[id]?.displayTitle ?? id,
      running: state.byId[id]?.running ?? false,
    }))),
  })
}

/**
 * Value equality of two switcher views; the observable adapter keeps reference
 * identity while nothing moved, so the selector hook never re-renders on an
 * unrelated session-store bump.
 */
export function sameSessionListView(left: ResearchSessionListView, right: ResearchSessionListView): boolean {
  if (left.current !== right.current || left.list.length !== right.list.length) return false
  return left.list.every((entry, index) => {
    const other = right.list[index]
    return other !== undefined && entry.id === other.id && entry.title === other.title && entry.running === other.running
  })
}
