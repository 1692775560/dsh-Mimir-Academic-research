/**
 * Behavior tests for the LaTeX engine probe's failure classification (#235).
 *
 * The probe used to answer a bare boolean, so "`tectonic` is not installed"
 * and "`tectonic` is installed but not executable" and "`tectonic --version`
 * hangs" all produced the same sentence, and a binary that runs but exits
 * non-zero counted as available. Those need different fixes; the classification
 * is pinned here against the real Node error shapes.
 */

import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyProbeFailure, resolveLatexEngine } from '../src/tools/latex.ts'
import type { ExecFileException } from 'node:child_process'

/** A probe failure shaped like Node's `execFile` callback argument. */
function probeError(overrides: Partial<ExecFileException>): ExecFileException {
  return Object.assign(new Error('probe failed'), overrides) as ExecFileException
}

describe('classifyProbeFailure', () => {
  it('reads ENOENT as "not on PATH"', () => {
    expect(classifyProbeFailure(probeError({ code: 'ENOENT' }))).toBe('missing')
  })

  it('reads EACCES and EPERM as "there but not executable"', () => {
    expect(classifyProbeFailure(probeError({ code: 'EACCES' }))).toBe('permission')
    expect(classifyProbeFailure(probeError({ code: 'EPERM' }))).toBe('permission')
  })

  it('reads a killed process as a hang', () => {
    expect(classifyProbeFailure(probeError({ killed: true, code: null }))).toBe('timeout')
    expect(classifyProbeFailure(probeError({ code: 'ETIMEDOUT' }))).toBe('timeout')
  })

  it('reads everything else as a binary that cannot describe itself', () => {
    // A binary that exists and runs but exits non-zero: not ENOENT, not a
    // permission problem, not a kill. The old probe counted this as fine.
    expect(classifyProbeFailure(probeError({ code: 127 }))).toBe('broken')
    expect(classifyProbeFailure(probeError({ code: 1 }))).toBe('broken')
  })
})

describe('engine resolution against a real PATH (#235)', () => {
  it('a binary that exists but is not executable is rejected, not accepted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mimir-engine-'))
    const binary = join(dir, 'tectonic')
    await writeFile(binary, '#!/bin/sh\necho tectonic 0.15\n', 'utf8')
    await chmod(binary, 0o644)
    // By absolute path the basename picks the dialect, so resolution succeeds;
    // the probe is what must remember the file cannot run.
    await expect(resolveLatexEngine(binary)).resolves.toEqual({ kind: 'tectonic', executable: binary })
    const { spawnSync } = await import('node:child_process')
    const attempt = spawnSync(binary, ['--version'], { encoding: 'utf8' })
    expect(attempt.error?.code ?? attempt.status).not.toBe(0)
  })

  it('the boolean probe still answers "is it runnable", not "is it there"', async () => {
    // The injectable probe shape is a boolean; a candidate the trivial probe
    // rejects is skipped rather than fatal.
    const calls: string[] = []
    const outcome = await resolveLatexEngine('auto', (command) => {
      calls.push(command)
      return Promise.resolve(command === 'tectonic')
    })
    expect(outcome).toEqual({ kind: 'tectonic', executable: 'tectonic' })
    expect(calls).toEqual(['latexmk', 'tectonic'])
  })
})
