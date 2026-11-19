/**
 * The right-pane seat gives the workbench ~380px while the window stays wide, so
 * the narrow layout must answer to the space the panel GOT. These tests pin the
 * mechanism (a container on the workbench host, container queries for the
 * breakpoints) — the regression they guard is a viewport query sneaking back in,
 * which silently keeps the desktop rail in the narrow right pane.
 * @module dsh-client-ui-mimir/tests/narrow-layout-container
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/client/ResearchPanel.module.css', import.meta.url)), 'utf8')

/** The `.workbenchHost` rule body. */
function hostBlock(): string {
  const start = CSS.indexOf('.workbenchHost {')
  expect(start).toBeGreaterThan(-1)
  return CSS.slice(start, CSS.indexOf('\n}\n', start))
}

describe('the workbench sizes itself by its container', () => {
  it('declares the size container on the host the panel renders', () => {
    expect(hostBlock()).toContain('container-type: inline-size')
  })

  it('fills whatever box it is given', () => {
    const block = hostBlock()
    expect(block).toContain('height: 100%')
    expect(block).toContain('min-width: 0')
    expect(block).toContain('min-height: 0')
  })

  it('drives every breakpoint off the container, not the viewport', () => {
    expect(CSS).toContain('@container (min-width: 701px)')
    expect(CSS).toContain('@container (max-width: 900px)')
    expect(CSS).toContain('@container (max-width: 700px)')
    expect(CSS).toContain('@container (max-width: 460px)')
    expect(CSS).not.toMatch(/@media\s*\((min|max)-width/)
  })
})
