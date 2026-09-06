/**
 * Behavior tests for package-manager detection and its install guidance.
 * Detection is pure over the env (plus PATH probing) so tests never need a
 * real npm/pnpm binary — the env-classified path is covered directly, and the
 * PATH probe path is covered with a fake binary on PATH.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectPackageManager, detectPackageManagerFromPath, installCommandFor } from '../src/pm-detect.ts'

const NPM_UA = 'npm/10.8.2 node/v22.14.0 linux x64'
const PNPM_UA = 'pnpm/9.15.0 npm/? node/v22.14.0 linux x64'

afterEach(() => vi.unstubAllEnvs())

describe('detectPackageManager', () => {
  it('classifies npm by its user agent', () => {
    expect(detectPackageManager({ npm_config_user_agent: NPM_UA })).toBe('npm')
  })

  it('classifies pnpm by its user agent', () => {
    expect(detectPackageManager({ npm_config_user_agent: PNPM_UA })).toBe('pnpm')
  })

  it('returns unknown when no package-manager hint is present', () => {
    expect(detectPackageManager({})).toBe('unknown')
  })

  it('prefers pnpm over npm when both appear in the user agent', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'pnpm/9.0.0 npm/10.0.0 node/v22 linux' })).toBe('pnpm')
  })
})

describe('detectPackageManagerFromPath', () => {
  it('falls back to pnpm on PATH when the env hint is absent', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'mimir-pm-'))
    const { chmod } = await import('node:fs/promises')
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\necho pnpm\n')
    await writeFile(join(bin, 'npm'), '#!/bin/sh\necho npm\n')
    await chmod(join(bin, 'pnpm'), 0o755)
    await chmod(join(bin, 'npm'), 0o755)
    const PATH = `${bin}:/usr/bin:/bin`
    expect(await detectPackageManagerFromPath({ npm_config_user_agent: undefined as never, PATH })).toBe('pnpm')
  })

  it('falls back to npm when only npm is on PATH', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'mimir-pm-'))
    const { chmod } = await import('node:fs/promises')
    await writeFile(join(bin, 'npm'), '#!/bin/sh\necho npm\n')
    await chmod(join(bin, 'npm'), 0o755)
    const PATH = `${bin}:/usr/bin:/bin`
    expect(await detectPackageManagerFromPath({ npm_config_user_agent: undefined as never, PATH })).toBe('npm')
  })

  it('stays unknown when neither is on PATH', async () => {
    const PATH = '/nonexistent'
    expect(await detectPackageManagerFromPath({ npm_config_user_agent: undefined as never, PATH })).toBe('unknown')
  })
})

describe('installCommandFor', () => {
  it('emits a pnpm command for pnpm and an npm command for npm', () => {
    expect(installCommandFor('pnpm')).toBe('pnpm add -g sxng-cli')
    expect(installCommandFor('npm')).toBe('npm install -g sxng-cli')
    expect(installCommandFor('unknown')).toContain('npm install -g sxng-cli')
  })
})
