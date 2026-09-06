/**
 * Package-manager detection for install guidance. Users install the sxng CLI
 * with either npm or pnpm; the one-line fix we emit must name the PM that is
 * actually in front of them, not hardcode one.
 *
 * Detection order — least guesswork first:
 * 1. `npm_config_user_agent` (set by npm/pnpm/corepack/yarn on every install)
 *    is the authoritative source when it names pnpm or npm.
 * 2. `pnpm` on PATH wins over `npm` when both exist (a pnpm-managed Node
 *    installs pnpm globally; npm is almost always present alongside it).
 *    `npm` on PATH is the fallback. A bare `node` invocation without either is
 *    reported as unknown, not guessed.
 * @module dsh-mimir/src/pm-detect
 */

import { execFile } from 'node:child_process'

export type PackageManager = 'pnpm' | 'npm' | 'unknown'

/** Classify the executing environment's package manager. */
export function detectPackageManager(env: NodeJS.ProcessEnv = process.env): PackageManager {
  const userAgent = env.npm_config_user_agent
  if (typeof userAgent === 'string') {
    if (userAgent.includes('pnpm')) return 'pnpm'
    if (userAgent.includes('npm')) return 'npm'
    // yarn/bun/etc. don't install npm-grafted CLIs distinctly; fall through.
  }
  return 'unknown'
}

/** Resolve the PM against PATH when the env hint is absent or ambiguous. */
export async function detectPackageManagerFromPath(env: NodeJS.ProcessEnv = process.env): Promise<PackageManager> {
  const fromEnv = detectPackageManager(env)
  if (fromEnv !== 'unknown') return fromEnv
  const patchPath = { ...process.env, PATH: env.PATH ?? process.env.PATH }
  const [pnpm, npm] = await Promise.all([commandOnPath('pnpm', patchPath), commandOnPath('npm', patchPath)])
  if (pnpm) return 'pnpm'
  if (npm) return 'npm'
  return 'unknown'
}

function commandOnPath(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolveProbe) => {
    execFile(command, ['--version'], { timeout: 10_000, env }, (error) => {
      resolveProbe(!(error !== null && (error as { code?: unknown }).code === 'ENOENT'))
    })
  })
}

/** One-line install command, latest version, for the detected PM. */
export function installCommandFor(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm add -g sxng-cli'
    case 'npm':
      return 'npm install -g sxng-cli'
    case 'unknown':
      return 'npm install -g sxng-cli   # (or: pnpm add -g sxng-cli)'
  }
}