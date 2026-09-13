/**
 * Behavior tests for the metric-figure pure rules: the standalone SVG bar
 * chart's structure and escaping, the destination file name's sanitization,
 * and the LaTeX-safe caption composition.
 */

import { describe, expect, it } from 'vitest'
import {
  escapeLatex,
  escapeXml,
  metricFigureCaption,
  metricFigureFileName,
  metricFigureSvg,
} from '../src/client/metric-figure.ts'
import type { MetricChartRow } from '../src/client/view-common.ts'

/** One chart row fixture. */
function row(id: string, name: string, value: number): MetricChartRow {
  return { id, name, status: 'success', value }
}

const ROWS = [
  row('e1', 'baseline', 92.4),
  row('e2', 'full model', 88.1),
]

describe('escapeXml / escapeLatex', () => {
  it('escapes the XML specials', () => {
    expect(escapeXml(`a<b>&"'"`)).toBe('a&lt;b&gt;&amp;&quot;&apos;&quot;')
  })

  it('escapes the LaTeX specials a generated caption can contain', () => {
    expect(escapeLatex('pa_mpjpe 100% & #1')).toBe('pa\\_mpjpe 100\\% \\& \\#1')
    expect(escapeLatex('{a}$b^c~d')).toBe('\\{a\\}\\$b\\textasciicircum{}c\\textasciitilde{}d')
  })
})

describe('metricFigureFileName', () => {
  it('folds unsafe runs to dashes and keeps the metric key readable', () => {
    expect(metricFigureFileName('mpjpe')).toBe('metric-mpjpe.svg')
    expect(metricFigureFileName('pa_mpjpe v2')).toBe('metric-pa-mpjpe-v2.svg')
    expect(metricFigureFileName('准确率（%）')).toBe('metric-chart.svg')
  })
})

describe('metricFigureCaption', () => {
  it('names the metric and every compared run with its value', () => {
    expect(metricFigureCaption('mpjpe', ROWS)).toBe(
      'Comparison of mpjpe across experiments: baseline (92.4), full model (88.1).',
    )
  })

  it('spells out the metric direction when one is set (#220)', () => {
    expect(metricFigureCaption('loss', ROWS, 'min')).toContain('. Lower is better.')
    expect(metricFigureCaption('acc', ROWS, 'max')).toContain('. Higher is better.')
    expect(metricFigureCaption('note', ROWS, 'none')).not.toContain('is better.')
  })

  it('escapes LaTeX specials in the metric key and the run names', () => {
    const caption = metricFigureCaption('pa_mpjpe', [row('e1', '消融_50%', 61.2)])
    expect(caption).toContain('pa\\_mpjpe')
    expect(caption).toContain('消融\\_50\\% (61.2)')
  })
})

describe('metricFigureSvg', () => {
  it('renders a standalone document: title, one bar per row, formatted values', () => {
    const svg = metricFigureSvg('mpjpe', ROWS)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
    expect(svg).toContain('<title>mpjpe</title>')
    expect(svg.match(/<rect x="216"/g)?.length).toBe(2)
    expect(svg).toContain('>baseline</text>')
    expect(svg).toContain('>full model</text>')
    expect(svg).toContain('>92.4</text>')
    expect(svg).toContain('>88.1</text>')
    // The widest bar (the best run) spans the full bar lane.
    expect(svg).toContain('width="330"')
    // No theme dependency: the generated file must render off-panel.
    expect(svg).not.toContain('var(--')
  })

  it('shades the best run darker under the metric direction and normalizes the rest to the lane (#220)', () => {
    const svg = metricFigureSvg('mpjpe', ROWS, 'max')
    expect(svg).toContain('width="330" height="18" rx="2" fill="#3f5f7f"')
    expect(svg).toContain(`width="${String((88.1 / 92.4) * 330)}"`)
    expect(svg).toContain('>mpjpe (higher is better)</text>')
    expect(svg).toContain('<title>mpjpe</title>')
    // Without a direction nothing is "best": every bar keeps the base tone.
    const plain = metricFigureSvg('mpjpe', ROWS)
    expect(plain).not.toContain('#3f5f7f')
    expect(plain).not.toContain('is better')
  })

  it('escapes XML specials in run names and metric keys', () => {
    const svg = metricFigureSvg('a<b', [row('e1', 'R&D <v2>', 1)])
    expect(svg).toContain('<title>a&lt;b</title>')
    expect(svg).toContain('R&amp;D &lt;v2&gt;')
    expect(svg).not.toContain('R&D')
  })

  it('extends negative bars left of a drawn zero line and survives an empty list (#220)', () => {
    const mixed = metricFigureSvg('loss', [row('e1', 'a', 1), row('e2', 'b', -2)])
    // The negative bar wears the negative tone, its value anchored left of the bar.
    expect(mixed).toContain('fill="#b0877f"')
    expect(mixed).toContain('text-anchor="end" fill="#4a5560">-2</text>')
    // The zero line sits inside the lane (2/3 of it for values [-2, 1]);
    // compute through the same percent indirection the renderer uses.
    const zeroPct = ((0 - -2) / 3) * 100
    const zeroX = 216 + (zeroPct / 100) * 330
    expect(mixed).toContain(`<line x1="${zeroX}"`)
    // A zero value yields a zero-width bar.
    const zero = metricFigureSvg('loss', [row('e1', 'a', 0), row('e2', 'b', -1)])
    expect(zero).toContain('width="0"')
    const empty = metricFigureSvg('loss', [])
    expect(empty.startsWith('<svg')).toBe(true)
    expect(empty).not.toContain('<rect x="216"')
  })
})
