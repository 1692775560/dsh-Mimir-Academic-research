/**
 * Behavior tests for the remote `sxng` skill provider's cache lifecycle:
 * first-use shallow clone, the silent stale refresh (24 h TTL), and the
 * offline fallback. Git is replaced with an in-memory fake (`MIMIR_SXNG_SKILL_GIT`
 * points at `tests/fixtures/fake-sxng-git.sh`) — no test touches a real clone,
 * network, or `$HOME`.
 */

import { mkdtemp, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSxngSkillProvider } from '../src/sxng-skill.ts'
import { fileURLToPath } from 'node:url'

const FAKE_GIT = fileURLToPath(new URL('fixtures/fake-sxng-git.sh', import.meta.url))

/** Start a provider with an isolated cache dir, a fake git, and a 24 h TTL. */
async function harness(): Promise<{ provider: ReturnType<typeof createSxngSkillProvider>; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mimir-sxng-skill-'))
  const cacheDir = join(root, 'cache', 'sxng-cli')
  vi.stubEnv('MIMIR_SXNG_SKILL_CACHE_DIR', cacheDir)
  vi.stubEnv('MIMIR_SXNG_SKILL_REFRESH_MS', String(24 * 60 * 60 * 1000))
  vi.stubEnv('MIMIR_SXNG_SKILL_GIT', FAKE_GIT)
  return { provider: createSxngSkillProvider(), cacheDir }
}

/** Make `.git` look old enough to trigger the stale refresh on the next list. */
async function ageGitDir(cacheDir: string): Promise<void> {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  await utimes(join(cacheDir, '.git'), old, old)
}

afterEach(() => vi.unstubAllEnvs())

describe('sxng skill provider cache lifecycle', () => {
  it('lists the upstream skill after a first-use clone and loads its body', async () => {
    const { provider } = await harness()
    const listed = await provider.list({ signal: new AbortController().signal })
    const [candidate] = Array.isArray(listed) ? listed : listed.candidates ?? []
    expect(candidate).toBeDefined()
    expect(candidate?.name).toBe('sxng')
    expect(candidate?.rank).toBe(600)
    expect(candidate?.locator).toMatchObject({ kind: 'sxng-skill' })
    const definition = await provider.get(candidate)
    expect(definition?.content).toContain('Run a web search')
  })

  it('silently pulls the checkout upstream once the cache is stale, keeping the body', async () => {
    const { provider, cacheDir } = await harness()
    await provider.list({ signal: new AbortController().signal })
    await ageGitDir(cacheDir)
    // After the stale pull, the body is still loadable (fake git never changes it).
    const listed = await provider.list({ signal: new AbortController().signal })
    const [candidate] = Array.isArray(listed) ? listed : listed.candidates ?? []
    const definition = await provider.get(candidate)
    expect(definition?.content).toContain('Run a web search')
  })

  it('keeps the cached body when the refresh pull fails offline', async () => {
    const { provider, cacheDir } = await harness()
    await provider.list({ signal: new AbortController().signal })
    await ageGitDir(cacheDir)
    vi.stubEnv('MIMIR_FAKE_GIT_FAIL_PULL', '1')
    const listed = await provider.list({ signal: new AbortController().signal })
    const [candidate] = Array.isArray(listed) ? listed : listed.candidates ?? []
    expect(candidate).toBeDefined()
    const definition = await provider.get(candidate)
    expect(definition?.content).toContain('Run a web search')
  })
})
