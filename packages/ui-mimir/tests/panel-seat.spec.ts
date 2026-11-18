/**
 * The panel's seats are a public contract with two packages that declare their
 * own slots (ui-sidebar, ui-layout). This spec pins the shape of that contract
 * so a future edit cannot quietly move the entry back to a footer toggle or
 * resurrect the dialog it used to be.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

const source = (name: string): string =>
  readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')

const index = source('index.ts')
const panel = source('ResearchPanel.tsx')
const slots = source('slots.ts')

describe('sidebar seat (#142 shell redesign)', () => {
  it('takes a row in the global panel list, not the footer', () => {
    expect(index).toContain("slots.inject('sidebar.panellist'")
    expect(index).toContain("name: 'sidebar.panellist'")
    expect(index).not.toContain('sidebar.footer.action')
  })

  it('routes the row id to the same main panel key', () => {
    expect(index).toContain("const PANEL_KEY = 'research' as MainPanelId")
    expect(index).toContain('id: PANEL_KEY')
    expect(index).toContain('key: PANEL_KEY')
    // The shell resolves the label from row metadata, so the row carries no copy.
    expect(index).toContain("label: () => (chromeSnapshot.locale === 'en' ? en : zh)['panel.title']")
  })

  it('renders in the main column instead of the frame overlay', () => {
    expect(index).toContain("slots.inject('main'")
    expect(slots).toContain("PropsRuntime<'main'>")
    expect(index).not.toContain("slots.inject('shell.overlay'")
    expect(slots).not.toContain("PropsRuntime<'shell.overlay'>")
  })
})

describe('the page, not the dialog', () => {
  it('drops the modal semantics', () => {
    expect(panel).toContain('<section className={css.workbench} role="region"')
    expect(panel).not.toContain('aria-modal')
    expect(panel).not.toContain('role="dialog"')
    expect(panel).not.toContain('css.backdrop')
  })

  it('renders whenever it is mounted, with no open gate', () => {
    expect(panel).not.toContain('state.open')
    expect(panel).not.toContain('if (!open) return null')
  })

  it('carries none of the three header buttons', () => {
    expect(panel).not.toContain('css.headActions')
    expect(panel).not.toContain('toggleTheme')
    expect(panel).not.toContain('toggleLocale')
    expect(slots).not.toContain('toggleTheme')
    expect(slots).not.toContain('toggleLocale')
  })

  it('carries no keyboard shortcuts', () => {
    expect(panel).not.toContain('shortcutFor')
    expect(panel).not.toContain('FOCUSABLE_SELECTOR')
    expect(panel).not.toContain('isEditableTarget')
    expect(Object.hasOwn(en, 'shortcuts.hint')).toBe(false)
    expect(Object.hasOwn(zh, 'shortcuts.hint')).toBe(false)
  })
})

describe('copy for the new seats', () => {
  it('names the sidebar tab in both locales', () => {
    for (const dictionary of [zh, en]) {
      expect(dictionary['sidebar.glance']).toBeTypeOf('string')
      expect(dictionary['sidebar.running']).toBeTypeOf('string')
      expect(dictionary['sidebar.openWorkbench']).toBeTypeOf('string')
    }
    expect(zh['sidebar.glance']).toBe('科研速览')
    expect(en['sidebar.glance']).toBe('Research at a glance')
  })
})
