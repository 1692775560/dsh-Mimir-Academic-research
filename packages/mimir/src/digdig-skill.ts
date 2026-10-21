/**
 * Remote `digdig` skill provider: exposes the upstream `digdig` skill (shipped in
 * the hkwuks/digdig repository) through the registry without vendoring a
 * copy. The provider clones the repo shallowly into the dsh home cache
 * (`<dshHome>/cache/skills/digdig`) on first `list()`, then reads the
 * `skills/digdig/SKILL.md` body from the cached checkout. A cached checkout is
 * pulled to upstream HEAD once it is older than {@link REFRESH_STALE_MS}, so
 * the body tracks upstream edits without a vendored copy, and a missing cache
 * is self-healing.
 *
 * The plugin cannot npm-install or npx-bootstrap a skill into dsh's skill
 * directory: the filesystem provider reads `~/.dsh/skills`, but a plugin has
 * no durable place to write dsh-home state. A provider is the registry-native
 * way to contribute a skill whose content lives outside the bundle.
 * @module dsh-mimir/src/digdig-skill
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.skills Context merge and the provider types; the
// service itself is consumed optionally through ctx.inject below.
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'

/** Unique provider name in the `ctx.skills` registry. */
const PROVIDER_NAME = 'digdig'

/** Shallow clone URL of the upstream digdig repository (the skill's source of truth). */
const DIGDIG_REPO_URL = 'https://github.com/hkwuks/digdig.git'

/** Skill body path inside the upstream checkout. */
const DIGDIG_SKILL_REL = join('skills', 'digdig', 'SKILL.md')

/** Cache dir override for tests (mirrors the fs cache-root key). */
const CACHE_DIR_ENV = 'MIMIR_DIGDIG_SKILL_CACHE_DIR'

/** Default dsh home cache root when `$DSH_HOME` is unset. */
function defaultDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Resolve the cache directory the provider clones the repository into. */
function cacheDir(): string {
  return process.env[CACHE_DIR_ENV] ?? join(defaultDshHome(), 'cache', 'skills', 'digdig')
}

/** Resolve the cache directory the provider clones the repository into. */
export function skillCacheDir(): string {
  return cacheDir()
}

/** Upstream repository URL (exported for tests). */
export const SKILL_REPO_URL = DIGDIG_REPO_URL

/** Skill body relative path (exported for tests). */
export const SKILL_SKILL_REL = DIGDIG_SKILL_REL

/** How old the cache checkout may be before `list()` refreshes it upstream. */
const REFRESH_STALE_MS = 24 * 60 * 60 * 1000

/** Refresh window override for tests. */
const REFRESH_INTERVAL_ENV = 'MIMIR_DIGDIG_SKILL_REFRESH_MS'

/**
 * Run one `git` command; resolves with the child's stdout and rejects when git
 * is missing or the command exits non-zero.
 */
function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const gitBin = process.env.MIMIR_DIGDIG_SKILL_GIT ?? 'git'
    execFile(gitBin, args, { cwd, signal, timeout: 30_000 }, (error, stdout) => {
      if (error !== null) {
        reject(new Error(`git ${args[0] ?? ''} failed: ${(error as Error).message}`))
        return
      }
      resolvePromise(stdout)
    })
  })
}

/**
 * Refresh the shallow checkout to upstream HEAD when it is older than
 * {@link REFRESH_STALE_MS}. The clone is `--depth 1` with no local commits, so
 * a fast-forward `pull --ff-only` keeps the SKILL.md body at upstream latest.
 * Network failures stay silent: a stale body is better than a missing skill.
 * @param signal - registration abort signal; cancels the refresh when it fires.
 */
async function refreshCheckout(signal?: AbortSignal): Promise<void> {
  const staleMs = Number(process.env[REFRESH_INTERVAL_ENV] ?? REFRESH_STALE_MS)
  if (!Number.isFinite(staleMs) || staleMs <= 0) return
  try {
    const marker = await stat(join(cacheDir(), '.git'))
    if (Date.now() - marker.mtimeMs < staleMs) return
    await runGit(['pull', '--ff-only'], cacheDir(), signal)
  } catch {
    /* offline or transient git failure — keep the cached body */
  }
}

/**
 * Ensure a shallow upstream checkout exists in the cache; when one does not,
 * clone it (sparse-checkout is NOT used — the repo is small, and a plain
 * shallow clone keeps future git operations simple). An existing checkout is
 * then refreshed when stale (see {@link refreshCheckout}).
 * @param signal - registration abort signal; cancels the clone when it fires.
 * @returns whether the checkout now exists.
 */
async function ensureCheckout(signal?: AbortSignal): Promise<boolean> {
  if (existsSync(join(cacheDir(), '.git'))) {
    await refreshCheckout(signal)
    return true
  }
  await mkdir(cacheDir(), { recursive: true })
  try {
    await runGit(['clone', '--depth', '1', DIGDIG_REPO_URL, '.'], cacheDir(), signal)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[mimir] digdig skill provider: failed to clone ${DIGDIG_REPO_URL}: ${message}`)
    return false
  }
}

/** Parse the `name`/`description` frontmatter off one skill body. */
function readSkillMetadata(content: string): { readonly name: string; readonly description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  const yaml = match?.[1] ?? ''
  const field = (key: string): string => {
    const line = yaml.split(/\r?\n/).find((row) => row.startsWith(`${key}:`))
    if (line === undefined) return ''
    return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '')
  }
  const name = field('name')
  const description = field('description')
  if (name === '' || description === '') {
    throw new TypeError(`[mimir] digdig skill: frontmatter requires name and description (${DIGDIG_SKILL_REL})`)
  }
  return { name, description }
}

/** Strip the YAML frontmatter so the body is pure Markdown instructions. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

/**
 * Build the provider handed to `ctx.skills.registerProvider()`. `list()` does
 * the first-time clone; `get()` reads the SKILL.md body from the checkout and
 * parses its frontmatter. All heavy work settles promptly on abort.
 */
export function createDigdigSkillProvider(): SkillProvider {
  const skillPath = () => join(cacheDir(), DIGDIG_SKILL_REL)

  return {
    name: PROVIDER_NAME,

    async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
      const checkout = await ensureCheckout(options.signal)
      if (!checkout) return { candidates: [], complete: false }
      const raw = await readFile(skillPath(), 'utf8').catch(() => '')
      if (raw === '') return { candidates: [], complete: false }
      const { name, description } = readSkillMetadata(raw)
      const candidate: SkillCandidate = {
        name,
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        rank: 600,
        source: 'custom',
        provider: PROVIDER_NAME,
        locator: { kind: 'digdig-skill', path: skillPath() },
        path: skillPath(),
      }
      return [candidate]
    },

    async get(
      candidate: SkillCandidate,
    ): Promise<SkillDefinition | undefined> {
      const raw = await readFile(candidate.path ?? skillPath(), 'utf8').catch(() => '')
      if (raw === '') return undefined
      const metadata = readSkillMetadata(raw)
      return {
        name: metadata.name,
        description: metadata.description,
        invocation: candidate.invocation,
        source: candidate.source,
        provider: PROVIDER_NAME,
        content: stripFrontmatter(raw),
        ...(candidate.path === undefined ? {} : { path: candidate.path }),
        ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
      }
    },
  }
}

/**
 * Register the remote `digdig` skill provider when a skill registry is mounted.
 * Mirrors `registerResearchSkills`: the `skills` service is deliberately not
 * in the plugin's `inject`, so registrations only happen when a registry is
 * present, and `ctx.inject` scopes them to the child context's effect stack.
 *
 * `list()` clones the upstream repo on first use and pulls it when the cache
 * is older than {@link REFRESH_STALE_MS}, so the skill body always tracks the
 * upstream `digdig` repo's latest SKILL.md without any vendored copy.
 * @param ctx - the plugin's context.
 */
export function registerDigdigSkill(ctx: Context): void {
  ctx.inject(['skills'], (skillsCtx: Context) => {
    skillsCtx.skills.registerProvider(() => createDigdigSkillProvider())
  })
}
