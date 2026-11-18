/**
 * The one table that decides WHEN a lazy slice loads (#222).
 *
 * Every panel slice used to answer that question inside its own `ensure*`
 * method: "ready or already in flight, so do nothing". That reads fine until a
 * load fails — `status` is `'error'`, nothing is in flight, and the effect that
 * called `ensure` will not run again because its dependencies did not change.
 * The slice then sits on its error card until the user finds that view's own
 * retry button, and the reconnect and project-switch paths never retry at all.
 *
 * So the rule lives here instead, as data, and the controller applies it:
 *
 * - a settled `ready` slice is left alone (the view's `refresh*` entry is the
 *   explicit staleness door);
 * - a `'error'` slice is re-attempted by any run that was *triggered* — that
 *   is the whole point of a retry, and it is what makes the reconnect and
 *   project-switch paths converge with the first-open path;
 * - an in-flight slice is left alone, and therefore no longer needs the
 *   per-slice `*Promise !== null` guards the caller-side code used to carry.
 *
 * Pure logic; the controller owns the actual loads. `lazy-slice-matrix.spec.ts`
 * asserts the table against the triggers the panel ships with.
 * @module dsh-client-ui-mimir/src/client/slice-policy
 */

/** The four statuses every panel slice reports (mirror of the controller's own union). */
export type SliceStatus = 'cold' | 'loading' | 'ready' | 'error'

/** The lazy slices the panel loads on demand, one row each in the matrix. */
export type LazySlice =
  | 'projects' | 'papers' | 'subscriptions' | 'zotero' | 'jobs' | 'venues' | 'figures' | 'artifact'

/** Why a slice is being asked for. Each trigger has a row per slice. */
export type LoadTrigger =
  /** The view holding the slice was opened for the first time. */
  | 'first-open'
  /** The user came back to a view whose slice never settled. */
  | 'revisit'
  /** The events stream reconnected: writes made while it was down are unknown. */
  | 'reconnect'
  /** The selected project changed, so project-scoped slices are stale. */
  | 'project-switch'
  /** The user pressed the view's retry control after a failure. */
  | 'retry'

/** What the controller should do with one slice for one trigger. */
export type SliceAction =
  /** Start a load that may flash the view into `loading`. */
  | 'load'
  /** Start a load that keeps the settled rows on screen (a background refresh). */
  | 'refresh'
  /** Do nothing: the slice is fresh, in flight, or irrelevant to this trigger. */
  | 'skip'

/**
 * Decide one slice's action.
 *
 * `status` is the slice's own settled status, or `'cold'` when it has never
 * been read. `inFlight` means a load is already running, which always wins: a
 * second concurrent read of the same slice would race the first one's publish.
 *
 * @param status - the slice's current status.
 * @param inFlight - whether a load for this slice is already running.
 * @param trigger - why the slice is being asked for.
 * @returns the action to take.
 */
export function sliceAction(
  status: SliceStatus,
  inFlight: boolean,
  trigger: LoadTrigger,
): SliceAction {
  if (inFlight) return 'skip'
  if (trigger === 'retry') return status === 'ready' ? 'refresh' : 'load'
  // A reconnect or a project switch finds the slice possibly stale: refresh a
  // settled one in place, load a cold or failed one properly.
  if (trigger === 'reconnect' || trigger === 'project-switch') {
    if (status === 'ready') return 'refresh'
    if (status === 'cold') return 'skip'
    return 'load'
  }
  // First open and revisit are the same question: is anything on screen yet?
  // `loading` without `inFlight` is unreachable, so skipping it is safe — the
  // in-flight load owns the transition out of the spinner.
  return status === 'ready' || status === 'loading' ? 'skip' : 'load'
}

/**
 * The slices each trigger touches, in load order (a dependency first: nothing
 * project-scoped can load before the project list settles).
 *
 * This is the matrix the issue asks for: read a row to answer "what happens on
 * a reconnect", read a column to answer "who may load the figures slice".
 */
const ALL_SLICES: readonly LazySlice[] = Object.freeze([
  'projects', 'papers', 'subscriptions', 'zotero', 'jobs', 'venues', 'figures', 'artifact',
])

export const LOAD_MATRIX: Readonly<Record<LoadTrigger, readonly LazySlice[]>> = Object.freeze({
  'first-open': ALL_SLICES,
  revisit: Object.freeze(['papers', 'subscriptions', 'zotero', 'jobs', 'venues', 'figures', 'artifact'] as const),
  reconnect: ALL_SLICES,
  'project-switch': Object.freeze(['venues', 'figures', 'artifact'] as const),
  retry: ALL_SLICES,
})

/**
 * Whether a slice is scoped to the selected project, and so must be reloaded
 * when that selection changes.
 * @param slice - the slice to classify.
 * @returns true when the slice belongs to one project.
 */
export function isProjectScoped(slice: LazySlice): boolean {
  return slice === 'venues' || slice === 'figures' || slice === 'artifact'
}

/** The workbench tabs the trigger matrix is keyed by. */
export type PanelTab =
  | 'overview' | 'paper' | 'papers' | 'experiments' | 'figures' | 'servers'
  | 'venues' | 'meetings' | 'ledger' | 'worktree' | 'foraging' | 'moments'

/**
 * The slices each tab wants on open — the "who asks for what" half of the
 * matrix. Reading a row answers "what does opening this tab load?"; the
 * freshness half ({@link sliceAction}) then decides whether that ask actually
 * becomes a request.
 *
 * A tab missing from this table loads nothing beyond the project list: its
 * reads are driven by an explicit control in the view, not by opening it.
 */
export const SLICES_BY_TAB: Readonly<Record<PanelTab, readonly LazySlice[]>> = Object.freeze({
  // The stat chips count the papers and figures slices; the activity card
  // reads jobs. The experiments slice is already loaded by selectProject().
  overview: Object.freeze(['papers', 'jobs', 'venues', 'figures'] as const),
  paper: Object.freeze([] as const),
  papers: Object.freeze(['papers', 'subscriptions', 'zotero'] as const),
  experiments: Object.freeze(['artifact'] as const),
  figures: Object.freeze(['figures'] as const),
  servers: Object.freeze(['jobs'] as const),
  venues: Object.freeze(['venues'] as const),
  meetings: Object.freeze([] as const),
  ledger: Object.freeze([] as const),
  worktree: Object.freeze([] as const),
  foraging: Object.freeze([] as const),
  moments: Object.freeze([] as const),
})
