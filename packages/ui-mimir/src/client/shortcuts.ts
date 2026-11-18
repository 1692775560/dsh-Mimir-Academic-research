/**
 * Pure workbench-chrome logic: the keyboard-shortcut mapping plus the
 * theme/locale snapshot shape the panel header renders, and the toggle
 * targets for both switches. DOM-free so the mapping is unit-testable —
 * ResearchPanel adapts KeyboardEvent into {@link ShortcutInput}, and the
 * plugin entry adapts ctx.theme/ctx.locale into {@link WorkbenchChrome}.
 * @module dsh-client-ui-mimir/client/shortcuts
 */

import type { ResearchTab } from './store.ts'

/** The nine view tabs in rail order — also the `1`–`9` shortcut order. */
export const TABS: readonly ResearchTab[] = Object.freeze(['overview', 'paper', 'papers', 'experiments', 'figures', 'meetings', 'servers', 'ledger', 'venues'])

/** The panel header's chrome snapshot: resolved color scheme + active locale. */
export interface WorkbenchChrome {
  /** Whether the host's dark base palette is active (`system` already resolved). */
  dark: boolean
  /** The host's active locale id ('zh' | 'en'). */
  locale: string
}

/** DOM-free view of one keydown: exactly the fields the mapping reads. */
export interface ShortcutInput {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  /** Whether the event target is a text-entry surface (input, textarea, contenteditable). */
  editable: boolean
  /** Whether a paper-view pane currently holds fullscreen (Esc exits it before closing). */
  fullscreen: boolean
  /** The rail on screen, for the digit mapping (#242); absent means the full list. */
  rail?: readonly ResearchTab[]
}

/**
 * Map a digit to a rail position: `1`–`n` index the tabs actually on screen.
 *
 * #242 removes capability-gated views from the rail, so the digit order must
 * follow the visible rail rather than the static list — otherwise `7` would
 * jump to a view the user cannot see. The caller passes the rail it rendered;
 * omitting it keeps the historical full-list order for tests and callers that
 * have no capability set yet.
 * @param key - the raw `KeyboardEvent.key`.
 * @param rail - the tabs on screen, in order.
 * @returns the tab that digit selects, or null when the key is not a position.
 */
export function tabForDigit(key: string, rail: readonly ResearchTab[] = TABS): ResearchTab | null {
  if (key.length !== 1 || key < '1' || key > String(rail.length)) return null
  return rail[Number(key) - 1] ?? null
}

/** What one keydown asks the workbench to do. */
export type ShortcutAction =
  | { type: 'tab'; tab: ResearchTab }
  | { type: 'close' }
  | { type: 'exit-fullscreen' }
  | { type: 'compile' }

/**
 * Map one keydown to a workbench action. The caller gates on the panel being
 * open; the mapping itself refuses every combo while a text-entry surface
 * holds focus, so the editor's own keystrokes (and the browser's alt-menu
 * accelerators) pass through untouched. `1`–`9` pick the rail tab in
 * {@link TABS} order, `Escape` exits a fullscreened pane first and closes the
 * panel only when nothing is fullscreened, ⌘/Ctrl+Enter asks for a compile
 * (the caller gates on the paper view and a selected project).
 * @param input - the keydown fields.
 * @returns the action, or null when the keydown is not a workbench shortcut.
 */
export function shortcutFor(input: ShortcutInput): ShortcutAction | null {
  if (input.editable || input.altKey) return null
  if (input.metaKey || input.ctrlKey) {
    return input.key === 'Enter' ? { type: 'compile' } : null
  }
  if (input.key === 'Escape') return input.fullscreen ? { type: 'exit-fullscreen' } : { type: 'close' }
  const digitTab = tabForDigit(input.key, input.rail ?? TABS)
  if (digitTab !== null) return { type: 'tab', tab: digitTab }
  return null
}

/** The preference the theme toggle writes: the opposite of the resolved scheme. */
export function nextColorScheme(dark: boolean): 'light' | 'dark' {
  return dark ? 'light' : 'dark'
}

/** The locale the language toggle switches to. */
export function nextLocale(locale: string): 'zh' | 'en' {
  return locale === 'zh' ? 'en' : 'zh'
}
