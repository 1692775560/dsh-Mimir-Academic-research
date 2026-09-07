/**
 * The sidebar fold's pure logic: the persisted fold flag (localStorage,
 * `mimir.*` naming convention) and the layout gate (the fold control only
 * exists in the side-rail layout — at ≤700px the rail becomes a top bar and
 * folding would fight the horizontal nav). DOM-free so both are unit-testable.
 * @module dsh-client-ui-mimir/client/sidebar-fold
 */

/** localStorage key the fold flag persists under (mimir.* convention). */
export const SIDEBAR_FOLD_STORAGE_KEY = 'mimir.sidebar.folded'

/** Widest viewport of the top-bar layout (mirrors the CSS media query). */
export const TOPBAR_MODE_MAX_WIDTH_PX = 700

/**
 * Read the persisted fold flag. Anything but the exact `'1'` writes as
 * unfolded — a missing or corrupt entry never traps the rail folded.
 * @param read - the storage getter (DOM-free seam; `localStorage.getItem` in the panel).
 * @returns whether the sidebar starts folded.
 */
export function readSidebarFolded(read: (key: string) => string | null): boolean {
  return read(SIDEBAR_FOLD_STORAGE_KEY) === '1'
}

/** The persisted form of one fold flag. */
export function sidebarFoldStorageValue(folded: boolean): string {
  return folded ? '1' : '0'
}

/**
 * Whether the fold control applies at one viewport width: only in the
 * side-rail layout. At or below {@link TOPBAR_MODE_MAX_WIDTH_PX} the rail is a
 * horizontal top bar, where a fold would fight the horizontal nav — the
 * button hides and the folded styling is inert there.
 * @param viewportWidthPx - the workbench's viewport width (fixed 96vw, so the
 *   viewport query doubles as a container query).
 * @returns whether folding is available.
 */
export function sidebarFoldAvailable(viewportWidthPx: number): boolean {
  return viewportWidthPx > TOPBAR_MODE_MAX_WIDTH_PX
}
