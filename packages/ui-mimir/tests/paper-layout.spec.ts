/**
 * Tests for the paper view's layout math: the rail drag clamp with the
 * collapse snap, the editor/preview split clamp with both minimums, and the
 * localStorage codec's fallbacks (missing key, malformed JSON, out-of-range
 * values).
 */

import { describe, expect, it } from 'vitest'
import {
  EDITOR_MIN_WIDTH,
  editorShareFromDrag,
  loadPaperLayout,
  PAPER_LAYOUT_DEFAULT,
  PAPER_LAYOUT_STORAGE_KEY,
  PAPER_NARROW_BREAKPOINT,
  paperSoloPane,
  PREVIEW_MIN_WIDTH,
  RAIL_COLLAPSE_BELOW,
  RAIL_MAX_SHARE,
  RAIL_MAX_WIDTH,
  railWidthForContainer,
  railWidthFromDrag,
  serializePaperLayout,
} from '../src/client/paper-layout.ts'

describe('railWidthFromDrag', () => {
  it('adds the pointer delta to the start width, rounded', () => {
    expect(railWidthFromDrag(200, 40)).toBe(240)
    expect(railWidthFromDrag(200, -50.4)).toBe(150)
  })

  it('clamps to the maximum rail width', () => {
    expect(railWidthFromDrag(200, 500)).toBe(RAIL_MAX_WIDTH)
    expect(railWidthFromDrag(0, RAIL_MAX_WIDTH + 1)).toBe(RAIL_MAX_WIDTH)
  })

  it('snaps to collapsed below the threshold instead of leaving a sliver', () => {
    expect(railWidthFromDrag(200, -141)).toBe(0) // 59 < 60
    expect(railWidthFromDrag(200, -140)).toBe(RAIL_COLLAPSE_BELOW) // exactly at the threshold
    expect(railWidthFromDrag(0, -30)).toBe(0)
  })
})

describe('railWidthForContainer', () => {
  it('keeps the preferred width when the container has room', () => {
    // 1400px container: 20% cap = 280 > RAIL_MAX_WIDTH, leftover fits 360+280.
    expect(railWidthForContainer(180, 1400)).toBe(180)
    expect(railWidthForContainer(240, 1400)).toBe(240)
  })

  it('clamps to the maximum rail width', () => {
    expect(railWidthForContainer(320, 1400)).toBe(RAIL_MAX_WIDTH)
  })

  it('caps the rail at 20% of the container width', () => {
    // 1000px container: 20% = 200 < 240.
    expect(railWidthForContainer(240, 1000)).toBe(Math.floor(1000 * RAIL_MAX_SHARE))
    expect(railWidthForContainer(150, 1000)).toBe(150)
  })

  it('squeezes the rail before touching the editor/preview floors', () => {
    // Floors are 360+280 content plus 2×30 chrome = 700px.
    // 800px container: cap 160 leaves 640 < 700, so the rail yields to 100.
    expect(railWidthForContainer(240, 800)).toBe(100)
    // 780px: 780-700 = 80, still above the collapse threshold.
    expect(railWidthForContainer(240, 780)).toBe(80)
  })

  it('collapses to the strip when the squeeze drops below the threshold', () => {
    // 759px: 759-700 = 59 < 60 → collapsed; 760px: exactly 60 → kept.
    expect(railWidthForContainer(240, 759)).toBe(0)
    expect(railWidthForContainer(240, 760)).toBe(60)
    expect(railWidthForContainer(240, EDITOR_MIN_WIDTH + PREVIEW_MIN_WIDTH)).toBe(0)
  })

  it('passes through a collapsed rail or an unmeasured container', () => {
    expect(railWidthForContainer(0, 1400)).toBe(0)
    expect(railWidthForContainer(180, 0)).toBe(180)
    expect(railWidthForContainer(180, -10)).toBe(180)
  })
})

describe('editorShareFromDrag', () => {
  it('converts the dragged editor px into a share of the available width', () => {
    expect(editorShareFromDrag(600, 1000)).toBeCloseTo(0.6)
  })

  it('keeps the editor minimum', () => {
    expect(editorShareFromDrag(100, 1000)).toBeCloseTo(EDITOR_MIN_WIDTH / 1000)
  })

  it('keeps the preview minimum', () => {
    expect(editorShareFromDrag(900, 1000)).toBeCloseTo((1000 - PREVIEW_MIN_WIDTH) / 1000)
  })

  it('lets the editor minimum win when the container cannot fit both', () => {
    // 400px available cannot hold 360 + 280: the editor clamps to 360.
    expect(editorShareFromDrag(390, 400)).toBeCloseTo(EDITOR_MIN_WIDTH / 400)
  })

  it('falls back to the default share on a zero-width container', () => {
    expect(editorShareFromDrag(100, 0)).toBe(PAPER_LAYOUT_DEFAULT.editor)
  })
})

describe('loadPaperLayout', () => {
  it('returns the default when nothing is stored', () => {
    expect(loadPaperLayout(() => null)).toEqual(PAPER_LAYOUT_DEFAULT)
  })

  it('parses a stored layout', () => {
    const stored = serializePaperLayout({ rail: 200, editor: 0.75, collapsed: true })
    expect(loadPaperLayout(key => (key === PAPER_LAYOUT_STORAGE_KEY ? stored : null)))
      .toEqual({ rail: 200, editor: 0.75, collapsed: true })
  })

  it('loads layouts saved before the collapsed flag existed', () => {
    expect(loadPaperLayout(() => JSON.stringify({ rail: 200, editor: 0.6 })))
      .toEqual({ rail: 200, editor: 0.6, collapsed: false })
  })

  it('clamps a stored rail above the current maximum instead of rejecting it', () => {
    // Older builds allowed a 320px rail; the layout still loads, narrowed.
    expect(loadPaperLayout(() => JSON.stringify({ rail: RAIL_MAX_WIDTH + 80, editor: 0.6 })))
      .toEqual({ rail: RAIL_MAX_WIDTH, editor: 0.6, collapsed: false })
  })

  it('falls back on malformed JSON', () => {
    expect(loadPaperLayout(() => '{oops')).toEqual(PAPER_LAYOUT_DEFAULT)
  })

  it('falls back on out-of-range values', () => {
    expect(loadPaperLayout(() => JSON.stringify({ rail: -5, editor: 0.6 }))).toEqual(PAPER_LAYOUT_DEFAULT)
    expect(loadPaperLayout(() => JSON.stringify({ rail: 200, editor: 0 }))).toEqual(PAPER_LAYOUT_DEFAULT)
    expect(loadPaperLayout(() => JSON.stringify({ rail: 200, editor: 1 }))).toEqual(PAPER_LAYOUT_DEFAULT)
    expect(loadPaperLayout(() => JSON.stringify({ rail: 200, editor: 0.6, collapsed: 'yes' })))
      .toEqual(PAPER_LAYOUT_DEFAULT)
    expect(loadPaperLayout(() => JSON.stringify({ rail: 200 }))).toEqual(PAPER_LAYOUT_DEFAULT)
  })

  it('falls back when storage itself throws', () => {
    expect(loadPaperLayout(() => { throw new Error('denied') })).toEqual(PAPER_LAYOUT_DEFAULT)
  })
})

describe('paperSoloPane', () => {
  it('exposes the narrow breakpoint at 900px', () => {
    expect(PAPER_NARROW_BREAKPOINT).toBe(900)
  })

  it('follows the tab selection under the narrow breakpoint', () => {
    expect(paperSoloPane(true, 'editor', null)).toBe('editor')
    expect(paperSoloPane(true, 'preview', null)).toBe('preview')
  })

  it('lets the tab override a stale fullscreen flag while narrow', () => {
    expect(paperSoloPane(true, 'editor', 'preview')).toBe('editor')
  })

  it('follows the fullscreen flag at full width', () => {
    expect(paperSoloPane(false, 'editor', 'preview')).toBe('preview')
    expect(paperSoloPane(false, 'preview', 'editor')).toBe('editor')
  })

  it('keeps the split layout at full width with no fullscreen', () => {
    expect(paperSoloPane(false, 'editor', null)).toBeNull()
    expect(paperSoloPane(false, 'preview', null)).toBeNull()
  })
})
