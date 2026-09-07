/**
 * Behavior tests for the multi-engine LaTeX compile path: engine resolution
 * (auto probe order, explicit names, absolute paths by basename, fail-loud
 * when nothing is found) and parsing of tectonic's console diagnostics.
 */

import { describe, expect, it } from 'vitest'
import { createAutoEngineResolver, parseTectonicErrors, resolveLatexEngine } from '../src/tools/latex.ts'
import type { LatexEngineProbe } from '../src/tools/latex.ts'

/** A probe answering from a fixed set of on-PATH commands. */
function probeWith(onPath: readonly string[]): LatexEngineProbe {
  return command => Promise.resolve(onPath.includes(command))
}

describe('resolveLatexEngine', () => {
  it('passes explicit engine names through without probing', async () => {
    const never: LatexEngineProbe = () => { throw new Error('must not probe explicit names') }
    await expect(resolveLatexEngine('latexmk', never)).resolves.toEqual({ kind: 'latexmk', executable: 'latexmk' })
    await expect(resolveLatexEngine('tectonic', never)).resolves.toEqual({ kind: 'tectonic', executable: 'tectonic' })
  })

  it('auto prefers latexmk over tectonic on PATH', async () => {
    const seen: string[] = []
    const probe: LatexEngineProbe = (command) => { seen.push(command); return Promise.resolve(true) }
    await expect(resolveLatexEngine('auto', probe)).resolves.toEqual({ kind: 'latexmk', executable: 'latexmk' })
    expect(seen).toEqual(['latexmk'])
  })

  it('auto falls back to tectonic when latexmk is absent', async () => {
    await expect(resolveLatexEngine('auto', probeWith(['tectonic'])))
      .resolves.toEqual({ kind: 'tectonic', executable: 'tectonic' })
  })

  it('auto fails loud when neither engine is on PATH', async () => {
    await expect(resolveLatexEngine('auto', probeWith([])))
      .rejects.toThrow(/No LaTeX engine found on PATH.*latexmk.*tectonic/s)
  })

  it('resolves an absolute path by basename', async () => {
    await expect(resolveLatexEngine('/tmp/tectonic'))
      .resolves.toEqual({ kind: 'tectonic', executable: '/tmp/tectonic' })
    await expect(resolveLatexEngine('/opt/texlive/bin/latexmk'))
      .resolves.toEqual({ kind: 'latexmk', executable: '/opt/texlive/bin/latexmk' })
  })

  it('rejects an absolute path whose basename matches no known engine', async () => {
    await expect(resolveLatexEngine('/tmp/pdflatex'))
      .rejects.toThrow(/must point at a tectonic or latexmk executable/)
  })
})

describe('createAutoEngineResolver', () => {
  it('caches a successful probe but re-probes after a failure', async () => {
    let latexmkOnPath = false
    let probes = 0
    const probe: LatexEngineProbe = (command) => {
      probes += 1
      return Promise.resolve(command === 'latexmk' && latexmkOnPath)
    }
    const resolve = createAutoEngineResolver(probe)
    // A failed resolution is not cached: a TeX install later in the session wins.
    await expect(resolve()).rejects.toThrow(/No LaTeX engine found on PATH/)
    latexmkOnPath = true
    await expect(resolve()).resolves.toEqual({ kind: 'latexmk', executable: 'latexmk' })
    // A successful resolution is cached: no further probing.
    const settled = probes
    await expect(resolve()).resolves.toEqual({ kind: 'latexmk', executable: 'latexmk' })
    expect(probes).toBe(settled)
  })
})

describe('parseTectonicErrors', () => {
  it('returns an empty array for a clean run', () => {
    const log = [
      'note: this is a TeX engine',
      'note: downloading https://bundle.example.com/file.tar',
      'note: running TeX ...',
      'note: writing main.pdf',
      'note: running TeX ...',
    ].join('\n')
    expect(parseTectonicErrors(log)).toEqual([])
  })

  it('captures located and unlocated error lines from a realistic failure', () => {
    const log = [
      'note: running TeX ...',
      'error: main.tex:42: Undefined control sequence',
      'error: halted on potentially-recoverable error as specified',
      'warning: main.tex:17: Citation \'doe2024\' on page 1 undefined',
      'note: writing main.log',
    ].join('\n')
    expect(parseTectonicErrors(log)).toEqual([
      { severity: 'error', file: 'main.tex', line: 42, message: 'Undefined control sequence' },
      { severity: 'error', message: 'halted on potentially-recoverable error as specified' },
      { severity: 'warning', file: 'main.tex', line: 17, message: 'Citation \'doe2024\' on page 1 undefined' },
    ])
  })
})
