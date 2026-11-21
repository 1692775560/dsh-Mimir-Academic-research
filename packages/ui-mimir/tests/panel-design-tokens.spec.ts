/**
 * DESIGN.md (GoofishOps/frontend) is the source of truth for this shell: a cold
 * grey canvas, white cards, 1px borders instead of shadows, one warm-yellow
 * action colour, cobalt for links and information, and a 6px radius. These
 * assertions are the drift alarm — they fail when a future edit reintroduces
 * the paper/caramel language or paints a card with a shadow.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/ResearchPanel.module.css', import.meta.url), 'utf8')
/** Selector matching reads the stylesheet with comments removed: a comment that
 *  mentions `--mimir-*` would otherwise swallow the rule that follows it. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * Every declaration block whose selector list names exactly this selector —
 * grouped rules (`.btn, .btnPrimary {`) included, longer selectors excluded.
 */
function ruleOf(selector: string): string {
  const bodies: string[] = []
  for (const match of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',').map(part => part.trim())
    if (selectors.includes(selector)) bodies.push(match[2] ?? '')
  }
  return bodies.join('\n')
}

const ALL_RADII = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map(match => match[1] ?? '')

describe('DESIGN.md palette', () => {
  it('uses the canonical values for canvas, surface, line and ink', () => {
    expect(css).toContain('--mimir-canvas: #f5f6f8')
    expect(css).toContain('--mimir-surface: #ffffff')
    expect(css).toContain('--mimir-line: #e6e8eb')
    expect(css).toContain('--mimir-line-soft: #eff1f3')
    expect(css).toContain('--mimir-ink: #1f2329')
    expect(css).toContain('--mimir-radius: 6px')
  })

  it('keeps warm yellow for action and cobalt for information', () => {
    expect(css).toContain('--mimir-action: #ffe14d')
    expect(css).toContain('--mimir-action-hover: #ffd633')
    expect(css).toContain('--mimir-action-active: #f7cc24')
    expect(css).toContain('--mimir-info: #1044cc')
  })

  it('keeps the semantic four, and orange/red only for exceptions', () => {
    expect(css).toContain('--mimir-success: #2f7d4f')
    expect(css).toContain('--mimir-danger: #b42318')
    expect(css).toContain('--mimir-warn: #b45309')
  })

  it('drops every trace of the paper language it replaced', () => {
    for (const legacy of ['#f5f0e6', '#ece5d4', '#fdfbf7', '#a0522d', '#7a3e22', '#bc4749', '#96742f', 'Georgia']) {
      expect(css).not.toContain(legacy)
    }
    expect(css).not.toContain('--mimir-paper')
    expect(css).not.toContain('--mimir-serif')
    expect(css).not.toContain('--mimir-accent')
  })
})

describe('DESIGN.md rules', () => {
  it('lays the panel out as a page, not a floating window', () => {
    const workbench = ruleOf('.workbench')
    expect(workbench).toContain('position: relative')
    expect(workbench).not.toContain('position: fixed')
    expect(css).not.toContain('inset: 2.5vh 2vw')
    expect(ruleOf('.backdrop')).toBe('')
  })

  it('one radius for every corner', () => {
    for (const radius of ALL_RADII) {
      // Token indirection and percentage circles are not literal corners.
      if (radius.includes('var(') || radius.includes('%')) continue
      for (const value of radius.split(/\s+/).filter(part => part !== '')) {
        if (value === '0' || value === '999px') continue
        expect(value.endsWith('6px')).toBe(true)
      }
    }
  })

  it('keeps content flat: cards and bars carry borders, not shadows', () => {
    for (const selector of ['.statChip', '.overviewCard', '.activitySection', '.paperCard', '.timelineCard', '.venueCard']) {
      expect(ruleOf(selector)).toContain('box-shadow: none')
    }
  })

  it('allows exactly one shadow, for surfaces that float above the page', () => {
    const lifted = [...css.matchAll(/box-shadow:[^;]*var\(--mimir-lift\)/g)].length
    expect(lifted).toBeGreaterThan(0)
    for (const selector of ['.venuePopover', '.toast', '.importDialog']) {
      expect(ruleOf(selector)).toContain('var(--mimir-lift)')
    }
  })

  it('marks the current rail row with a light ground and a 2px action bar', () => {
    const active = ruleOf('.navItem[data-active]')
    expect(active).toContain('background: var(--dsw-alias-interactive-bg-hover')
    expect(active).not.toContain('--mimir-action')
    expect(ruleOf('.navItem[data-active]::before')).toContain('background: var(--mimir-action)')
  })

  it('prints ink on yellow, never white', () => {
    const primary = ruleOf('.btnPrimary')
    expect(primary).toContain('background: var(--mimir-action)')
    expect(primary).toContain('color: #1f2329')
    expect(css).toContain('--dsw-alias-label-primary-foreground: #1f2329')
  })
})
