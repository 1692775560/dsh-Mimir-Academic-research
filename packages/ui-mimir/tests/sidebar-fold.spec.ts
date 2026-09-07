/**
 * Behavior tests for the sidebar fold's pure logic: the persisted flag's
 * fail-open read (only an exact '1' folds), the storage value form, and the
 * top-bar-mode gate (the fold control applies only above 700px).
 */

import { describe, expect, it } from 'vitest'
import {
  readSidebarFolded,
  SIDEBAR_FOLD_STORAGE_KEY,
  sidebarFoldAvailable,
  sidebarFoldStorageValue,
  TOPBAR_MODE_MAX_WIDTH_PX,
} from '../src/client/sidebar-fold.ts'

describe('readSidebarFolded', () => {
  it('reads only an exact "1" as folded; missing/corrupt entries fail open', () => {
    expect(SIDEBAR_FOLD_STORAGE_KEY).toBe('mimir.sidebar.folded')
    expect(readSidebarFolded(() => '1')).toBe(true)
    expect(readSidebarFolded(() => '0')).toBe(false)
    expect(readSidebarFolded(() => null)).toBe(false)
    expect(readSidebarFolded(() => 'true')).toBe(false)
  })

  it('round-trips through sidebarFoldStorageValue', () => {
    expect(sidebarFoldStorageValue(true)).toBe('1')
    expect(sidebarFoldStorageValue(false)).toBe('0')
    for (const folded of [true, false]) {
      const stored = sidebarFoldStorageValue(folded)
      expect(readSidebarFolded(() => stored)).toBe(folded)
    }
  })
})

describe('sidebarFoldAvailable', () => {
  it('applies only above the top-bar-mode width', () => {
    expect(TOPBAR_MODE_MAX_WIDTH_PX).toBe(700)
    expect(sidebarFoldAvailable(701)).toBe(true)
    expect(sidebarFoldAvailable(1440)).toBe(true)
    expect(sidebarFoldAvailable(700)).toBe(false)
    expect(sidebarFoldAvailable(460)).toBe(false)
  })
})
