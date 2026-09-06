/**
 * Behavior tests for `/skill-sync`: realpath resolution through a symlinked
 * skills root, the idempotent no-op on identical content, and the git-tree
 * protection that leaves a dotfiles-owned target untouched. Filesystem-only —
 * the command never shells out to git; it detects a work tree by `.git`
 * ancestry. The cached SKILL.md source is faked via the cache-dir env.
 */

import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncFile, realTargetDir, dshSkillsRoot, insideGitWorkTree } from '../src/commands/skill-sync.ts'

async function harness(): Promise<{ home: string; cache: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mimir-skill-sync-'))
  const home = join(root, 'home')
  const cache = join(root, 'cache')
  await mkdir(join(cache, 'skills', 'sxng'), { recursive: true })
  await writeFile(join(cache, 'skills', 'sxng', 'SKILL.md'), SKILL_BODY)
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('MIMIR_SXNG_SKILL_CACHE_DIR', cache)
  return { home, cache }
}

const SKILL_BODY = '---\nname: sxng\ndescription: Web search CLI skill.\n---\n\n# sxng\n'

describe('dshSkillsRoot / realTargetDir', () => {
  it('resolves the root to <dshHome>/skills and follows a symlinked root to its real target', async () => {
    const { home } = await harness()
    expect(dshSkillsRoot()).toBe(join(home, 'skills'))
    const real = join(home, 'real-skills')
    await mkdir(real, { recursive: true })
    await symlink(real, dshSkillsRoot())
    expect(await realTargetDir(dshSkillsRoot())).toBe(await realpath(real))
  })
})

describe('insideGitWorkTree', () => {
  it('flags a path under a .git ancestor and clears one outside any repo', async () => {
    const { home } = await harness()
    const repo = join(home, 'dotfiles')
    await mkdir(join(repo, '.git'), { recursive: true })
    expect(insideGitWorkTree(join(repo, 'skills', 'sxng', 'SKILL.md'))).toBe(true)
    const plain = join(home, 'plain')
    await mkdir(plain, { recursive: true })
    expect(insideGitWorkTree(join(plain, 'sxng', 'SKILL.md'))).toBe(false)
  })
})

describe('syncFile', () => {
  it('writes into a plain directory when absent', async () => {
    const { home } = await harness()
    const root = join(home, 'plain')
    await mkdir(root, { recursive: true })
    const target = join(root, 'sxng', 'SKILL.md')
    const outcome = await syncFile(join(process.env.MIMIR_SXNG_SKILL_CACHE_DIR!, 'skills', 'sxng', 'SKILL.md'), target)
    expect(outcome).toBe('written')
    expect(await import('node:fs/promises').then(m => m.readFile(target, 'utf8'))).toBe(SKILL_BODY)
  })

  it('no-ops when the destination already matches', async () => {
    const { home } = await harness()
    const root = join(home, 'plain')
    await mkdir(join(root, 'sxng'), { recursive: true })
    const target = join(root, 'sxng', 'SKILL.md')
    await writeFile(target, SKILL_BODY)
    const outcome = await syncFile(join(process.env.MIMIR_SXNG_SKILL_CACHE_DIR!, 'skills', 'sxng', 'SKILL.md'), target)
    expect(outcome).toBe('noop')
  })

  it('refuses to overwrite a git-tracked destination', async () => {
    const { home } = await harness()
    const repo = join(home, 'dotfiles')
    await mkdir(join(repo, 'skills', 'sxng', '.git'), { recursive: true })
    const target = join(repo, 'skills', 'sxng', 'SKILL.md')
    await writeFile(target, 'older content that a user keeps')
    const outcome = await syncFile(join(process.env.MIMIR_SXNG_SKILL_CACHE_DIR!, 'skills', 'sxng', 'SKILL.md'), target)
    expect(outcome).toBe('git-kept')
    expect(await import('node:fs/promises').then(m => m.readFile(target, 'utf8'))).toBe('older content that a user keeps')
  })
})

afterEach(() => vi.unstubAllEnvs())
