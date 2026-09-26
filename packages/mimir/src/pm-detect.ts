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
 *    reported as unknown, not guessed. The PATH probe is a plain file scan,
 *    not a spawn: `execFile('pnpm')` cannot run the `.cmd` shims npm/pnpm
 *    install on Windows (and would execute the binary just to learn it
 *    exists). Windows PATHs may be probed with `:` or `;` separators.
 * @module dsh-mimir/src/pm-detect
 */

import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

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
export function detectPackageManagerFromPath(env: NodeJS.ProcessEnv = process.env): PackageManager {
  const fromEnv = detectPackageManager(env)
  if (fromEnv !== 'unknown') return fromEnv
  const patchPath = { ...process.env, PATH: env.PATH ?? process.env.PATH }
  // pnpm wins when both exist; the probe order encodes the precedence.
  if (commandOnPath('pnpm', patchPath)) return 'pnpm'
  if (commandOnPath('npm', patchPath)) return 'npm'
  return 'unknown'
}

/**
 * Whether one command name resolves on PATH. Scans the directories instead of
 * spawning, so it behaves identically on POSIX and on Windows (where the
 * package managers are `.cmd`/`.exe` shims a bare `execFile` cannot launch).
 */
function commandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  // Windows shims carry extensions, and test/CI PATH fixtures written with a
  // POSIX separator must still probe there; POSIX directories may contain the
  // other separator only pathologically, so accept both on Windows only.
  const separators = process.platform === 'win32' ? /[;:]/ : delimiter
  const extensions = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : ['']
  for (const dir of (env.PATH ?? '').split(separators)) {
    if (dir.trim().length === 0) continue
    for (const ext of extensions) {
      if (existsSync(join(dir, `${command}${ext}`))) return true
    }
  }
  return false
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