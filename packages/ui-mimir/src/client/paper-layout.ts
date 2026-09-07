/**
 * Pure layout math for the paper view's draggable three-pane split: the
 * outline rail width in px (0 = collapsed strip), the editor's share of the
 * remaining width (the preview takes the rest), the drag-to-width clamping,
 * and the localStorage persistence codec. DOM-free so every rule is
 * unit-testable — PaperView feeds pointer deltas in and renders the result.
 * @module dsh-client-ui-mimir/client/paper-layout
 */

/** The paper view's pane widths: rail in px, editor as a 0–1 share of the rest. */
export interface PaperLayout {
  /** Outline rail width in px; 0 renders the collapsed slim strip. */
  readonly rail: number
  /** Editor share (0–1) of the width left after the rail; the preview gets the rest. */
  readonly editor: number
  /** The header toggle's collapsed flag; a drag to 0 collapses via `rail` instead. */
  readonly collapsed: boolean
}

/** localStorage key the layout persists under. */
export const PAPER_LAYOUT_STORAGE_KEY = 'mimir.paperLayout'

/** Shipped layout: 180px rail, editor/preview at roughly 7:5. */
export const PAPER_LAYOUT_DEFAULT: PaperLayout = Object.freeze({ rail: 180, editor: 0.58, collapsed: false })

/** The rail never grows past this (px). Section titles are short; the rail
 *  is a navigation aid, not a reading surface. */
export const RAIL_MAX_WIDTH = 240
/** The rail never takes more than this share of the container width. */
export const RAIL_MAX_SHARE = 0.2
/** A rail dragged below this width snaps to 0 (collapsed) instead of a sliver. */
export const RAIL_COLLAPSE_BELOW = 60
/** The collapsed rail renders as a slim strip of this width (px). */
export const RAIL_COLLAPSED_STRIP = 44
/** The editor never shrinks below this (px). */
export const EDITOR_MIN_WIDTH = 360
/** The preview never shrinks below this (px). */
export const PREVIEW_MIN_WIDTH = 280
/** Horizontal chrome (padding + border) each pane adds around its
 *  content-box minimum — the floors in footprint terms. */
export const PANE_FRAME_PX = 30

/** Clamp helper: value into [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * The rail width after one drag: the start width plus the horizontal pointer
 * delta, clamped to [0, {@link RAIL_MAX_WIDTH}], snapping to 0 (the collapsed
 * strip) below {@link RAIL_COLLAPSE_BELOW} so a near-collapse never leaves an
 * unreadable sliver.
 */
export function railWidthFromDrag(startRail: number, deltaX: number): number {
  const next = clamp(Math.round(startRail + deltaX), 0, RAIL_MAX_WIDTH)
  return next < RAIL_COLLAPSE_BELOW ? 0 : next
}

/**
 * The rail width that actually renders for a container of `containerPx`.
 * The rail is the first pane to give ground: it is capped by
 * {@link RAIL_MAX_WIDTH} and {@link RAIL_MAX_SHARE} of the container, and
 * when the container cannot hold the rail plus both pane floors (the
 * {@link EDITOR_MIN_WIDTH}/{@link PREVIEW_MIN_WIDTH} content minimums plus
 * their {@link PANE_FRAME_PX} chrome) the rail shrinks to whatever is left —
 * snapping to 0 (the collapsed strip) below {@link RAIL_COLLAPSE_BELOW}.
 * Anything still short after that is the container's horizontal scrollbar's
 * job; the editor and preview floors are never yielded. A collapsed (0) or
 * non-positive-container input passes through untouched. `containerPx`
 * excludes the inter-pane gaps (the caller subtracts them).
 */
export function railWidthForContainer(rail: number, containerPx: number): number {
  if (rail <= 0 || containerPx <= 0) return rail
  const cap = Math.min(RAIL_MAX_WIDTH, Math.floor(containerPx * RAIL_MAX_SHARE))
  let width = Math.min(rail, cap)
  const floors = EDITOR_MIN_WIDTH + PREVIEW_MIN_WIDTH + 2 * PANE_FRAME_PX
  if (containerPx - width >= floors) return width
  width = containerPx - floors
  return width < RAIL_COLLAPSE_BELOW ? 0 : width
}

/**
 * The editor share after one split-handle drag. `editorPx` is the dragged-to
 * editor width and `availablePx` the combined editor+preview width at drag
 * start; the share clamps so the editor keeps at least {@link EDITOR_MIN_WIDTH}
 * and the preview at least {@link PREVIEW_MIN_WIDTH} (the editor minimum wins
 * when the container is too narrow for both).
 */
export function editorShareFromDrag(editorPx: number, availablePx: number): number {
  if (availablePx <= 0) return PAPER_LAYOUT_DEFAULT.editor
  const maxEditor = Math.max(EDITOR_MIN_WIDTH, availablePx - PREVIEW_MIN_WIDTH)
  return clamp(editorPx, EDITOR_MIN_WIDTH, maxEditor) / availablePx
}

/** Wire form of one layout; NaN/Infinity never survive the round trip. A
 *  stored rail above the current maximum is clamped, not rejected, so layouts
 *  saved by older builds (wider cap, no `collapsed` flag) still load. */
function isValidLayout(value: unknown): value is PaperLayout {
  if (typeof value !== 'object' || value === null) return false
  const layout = value as { rail?: unknown; editor?: unknown; collapsed?: unknown }
  return typeof layout.rail === 'number' && Number.isFinite(layout.rail)
    && layout.rail >= 0
    && typeof layout.editor === 'number' && Number.isFinite(layout.editor)
    && layout.editor > 0 && layout.editor < 1
    && (layout.collapsed === undefined || typeof layout.collapsed === 'boolean')
}

/**
 * Read the persisted layout, falling back to {@link PAPER_LAYOUT_DEFAULT} on
 * a missing key, malformed JSON, or out-of-range values. Storage access is
 * injected as a `getItem` so the codec stays DOM-free.
 */
export function loadPaperLayout(getItem: (key: string) => string | null): PaperLayout {
  try {
    const raw = getItem(PAPER_LAYOUT_STORAGE_KEY)
    if (raw === null) return PAPER_LAYOUT_DEFAULT
    const parsed: unknown = JSON.parse(raw)
    if (!isValidLayout(parsed)) return PAPER_LAYOUT_DEFAULT
    return {
      rail: Math.min(parsed.rail, RAIL_MAX_WIDTH),
      editor: parsed.editor,
      collapsed: parsed.collapsed ?? false,
    }
  } catch {
    return PAPER_LAYOUT_DEFAULT
  }
}

/** Serialize one layout for localStorage. */
export function serializePaperLayout(layout: PaperLayout): string {
  return JSON.stringify({ rail: layout.rail, editor: layout.editor, collapsed: layout.collapsed })
}

/** Below this content width (px) the paper view degrades to a one-pane tab layout. */
export const PAPER_NARROW_BREAKPOINT = 900

/** The pane the narrow-width tab bar can select. */
export type PaperSoloPane = 'editor' | 'preview'

/**
 * Which pane takes the whole content area: under the narrow breakpoint the
 * tab bar decides (the rail and split handle hide via the fullscreen CSS);
 * at full width the explicit fullscreen flag decides (null = split).
 */
export function paperSoloPane(
  narrow: boolean,
  tab: PaperSoloPane,
  fullscreen: PaperSoloPane | null,
): PaperSoloPane | null {
  return narrow ? tab : fullscreen
}
