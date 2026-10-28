/**
 * Unit tests for the AI-organize marker's retire decision: the signature-move
 * leg (the agent's writes landed) and the timeout leg — which must fire even
 * when the signature never changes, the regression that pinned the view in
 * "organizing" forever.
 */

import { describe, expect, it } from 'vitest'
import { ORGANIZE_TIMEOUT_MS, organizeMarkerRetired, type OrganizeMarker } from '../src/client/figure-organize.ts'

const MARKER: OrganizeMarker = { anchor: 'sig-a', startedAt: 1_000_000 }

describe('organizeMarkerRetired', () => {
  it('retires when the list signature moved off the anchor', () => {
    expect(organizeMarkerRetired(MARKER, 'sig-b', MARKER.startedAt + 1000)).toBe(true)
  })

  it('stays while the signature is unchanged and the budget is unspent', () => {
    expect(organizeMarkerRetired(MARKER, 'sig-a', MARKER.startedAt + 1000)).toBe(false)
    expect(organizeMarkerRetired(MARKER, 'sig-a', MARKER.startedAt + ORGANIZE_TIMEOUT_MS)).toBe(false)
  })

  it('retires on timeout even when the signature never changed (the stuck-marker regression)', () => {
    expect(organizeMarkerRetired(MARKER, 'sig-a', MARKER.startedAt + ORGANIZE_TIMEOUT_MS + 1)).toBe(true)
  })

  it('retires on timeout while the list is still loading (empty signature)', () => {
    expect(organizeMarkerRetired(MARKER, '', MARKER.startedAt + 1000)).toBe(false)
    expect(organizeMarkerRetired(MARKER, '', MARKER.startedAt + ORGANIZE_TIMEOUT_MS + 1)).toBe(true)
  })

  it('treats any real signature as movement when the marker anchored on an empty one', () => {
    const emptyAnchored: OrganizeMarker = { anchor: '', startedAt: 1_000_000 }
    expect(organizeMarkerRetired(emptyAnchored, 'sig-a', 1_001_000)).toBe(true)
  })
})
