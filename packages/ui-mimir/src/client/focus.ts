/**
 * Pure focus-movement logic for the workbench's dialog chrome: the Tab-key
 * focus trap that keeps focus inside the open panel, the arrow-key cycling of
 * the rail tablist, and the shared cyclic-index helper the outline tree's
 * arrow navigation also uses. DOM-free so every rule is unit-testable —
 * ResearchPanel/PaperView adapt the live DOM (the focusable-element list, the
 * active element's index) into these numbers and apply the result.
 * @module dsh-client-ui-mimir/client/focus
 */

import { TABS } from './shortcuts.ts'
import type { ResearchTab } from './store.ts'

/**
 * Wrap `current + delta` into `[0, count)`, cycling both directions. Returns
 * -1 for an empty list so callers can no-op instead of focusing index NaN.
 */
export function wrapIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1
  const next = (current + delta) % count
  return next < 0 ? next + count : next
}

/**
 * Resolve one Tab keydown inside a focus-trapped container. `current` is the
 * active element's index among the container's `count` focusable elements, or
 * -1 when focus sits outside the container entirely (e.g. on the page behind
 * the dialog). Returns the index to force-focus, or null when the browser's
 * default Tab movement already stays inside the container and should run.
 * Focus outside the container is pulled back in (to the first element, or the
 * last under Shift+Tab); Tab past the last wraps to the first and Shift+Tab
 * before the first wraps to the last.
 */
export function trapFocusIndex(current: number, count: number, shift: boolean): number | null {
  if (count <= 0) return null
  if (current < 0 || current >= count) return shift ? count - 1 : 0
  if (!shift && current === count - 1) return 0
  if (shift && current === 0) return count - 1
  return null
}

/**
 * The rail tab one arrow key selects: Left/Up move to the previous tab,
 * Right/Down to the next, cycling past both ends. Returns null for any other
 * key so the caller leaves the keydown alone.
 * @param current - the active tab.
 * @param key - the raw `KeyboardEvent.key`.
 * @param rail - the tabs actually on screen; #242 removes capability-gated
 *   views from the rail, and stepping through a hidden tab would move the
 *   user somewhere they cannot see. Defaults to the full rail.
 */
export function arrowTab(
  current: ResearchTab,
  key: string,
  rail: readonly ResearchTab[] = TABS,
): ResearchTab | null {
  const delta = key === 'ArrowLeft' || key === 'ArrowUp'
    ? -1
    : key === 'ArrowRight' || key === 'ArrowDown'
      ? 1
      : 0
  if (delta === 0) return null
  if (rail.length === 0) return null
  const index = rail.indexOf(current)
  if (index < 0) return null
  return rail[wrapIndex(index, delta, rail.length)] ?? null
}
