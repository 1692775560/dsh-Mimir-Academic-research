/**
 * `/skill-sync`: sync the `sxng` skill into the host's dsh skills directory so
 * any dsh boot (with or without the Mimir plugin) sees it. The source of truth
 * is the cached upstream checkout the runtime provider already uses — the same
 * cache that the automatic 24 h pull keeps at sxng-cli's latest SKILL.md — so
 * the synced copy always reflects current upstream.
 *
 * The target root is `<dshHome>/skills` (`$DSH_HOME` or `~/.dsh`), the exact
 * `user-dsh` root the dsh filesystem skill provider scans (rank 400). The
 * dshHome/skills and the final `sxng` entry may be symlinks (dotfiles trees,
 * npx-managed homes); the write follows the real target so the file those
 * setups actually read is the one updated, and a git-tracked target is left
 * untouched for the user to adopt (a plugin must not rewrite a dotfiles repo
 * without consent). Idempotent: an identical existing copy is left alone.
 *
 * The command is explicit and offline-friendly — it reads the cache written by
 * any prior boot, so it works without network and never needs a skill dir shim.
 * @module dsh-mimir/src/commands/skill-sync
 */

import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

/** The one skill this command syncs (matches the provider's upstream layout). */
const SKILL_NAME = 'sxng'

/** The provider's cache sub-path inside the checkout. */
const SKILL_REL = join('skills', 'sxng', 'SKILL.md')

/** Resolve `<dshHome>/skills`: `$DSH_HOME`, else `~/.dsh`. */
export function dshSkillsRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'skills')
}

/** Real target of a possibly-symlinked root, resolved when the root exists. */
export async function realTargetDir(root: string): Promise<string> {
  return existsSync(root) ? await realpath(root) : root
}

/** Source SKILL.md: the cache the runtime provider maintains. */
async function cachedSkillBody(): Promise<string | undefined> {
  const cacheRoot = process.env.MIMIR_SXNG_SKILL_CACHE_DIR ??
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', 'skills', 'sxng-cli')
  const body = join(cacheRoot, SKILL_REL)
  return existsSync(body) ? body : undefined
}

/** Whether a path or any ancestor is a git work tree. */
export function insideGitWorkTree(path: string): boolean {
  let dir = dirname(path)
  for (let hop = 0; hop < 64; hop += 1) {
    if (existsSync(join(dir, '.git'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
  return false
}

/**
 * Copy the source into place when content differs. A destination inside a git
 * work tree (e.g. a symlinked dotfiles repo that tracks SKILL.md) is a
 * `git-kept` outcome — reported, never written.
 */
export async function syncFile(source: string, destination: string): Promise<'written' | 'noop' | 'git-kept'> {
  const [sourceBody, destBody] = await Promise.all([readFile(source), readFile(destination).catch(() => undefined)])
  if (destBody?.equals(sourceBody)) return 'noop'
  if (insideGitWorkTree(destination)) return 'git-kept'
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, sourceBody)
  return 'written'
}

/**
 * Register the `/skill-sync` command. It needs no workspace or domain — only
 * the command registry and the cache the runtime provider writes — so it is
 * safe to mount unconditionally.
 * @param ctx - Plugin context.
 */
export function registerSkillSyncCommand(ctx: Context): void {
  ctx.commands.register({
    name: 'skill-sync',
    description: 'copy the latest sxng skill into the dsh skills directory (for hosts booted without this plugin)',
    input: { hint: '' },
    async handler(): Promise<CommandResult> {
      const source = await cachedSkillBody()
      if (source === undefined) {
        return {
          kind: 'error',
          text: '[skill-sync] No cached sxng skill to copy — the runtime provider clones it on first use. Boot the plugin once, then re-run /skill-sync.',
        }
      }
      const root = await realTargetDir(dshSkillsRoot())
      const target = join(root, SKILL_NAME, 'SKILL.md')
      const outcome = await syncFile(source, target)
      if (outcome === 'noop') {
        return { kind: 'success', text: `[skill-sync] ${target} is already up to date.` }
      }
      if (outcome === 'git-kept') {
        return {
          kind: 'error',
          text: `[skill-sync] ${target} lives in a git work tree (a symlinked dotfiles repo or npx-managed skills dir) — left untouched for you to adopt. Review the diff and commit the newer SKILL.md, or point this command at a non-git skills root.`,
        }
      }
      return { kind: 'success', text: `[skill-sync] Wrote ${target}` }
    },
  })
}