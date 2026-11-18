/**
 * #239: what the lint gate has to keep catching.
 *
 * `eslint.config.mjs` is configuration, so a rule can be dropped, loosened, or
 * silently stop resolving without any test file changing. This spec drives the
 * real binary over a temporary source file inside `packages/mimir/src` — the
 * tree the config claims — and asserts each of the three rules still reports.
 *
 * The probe file is written under a name that the ignore list does not cover,
 * and it is removed in a `finally` so a failed assertion cannot leave lintable
 * garbage behind for the next run.
 *
 * A floating promise is the one bug class the compiler cannot see: `load()`
 * returns a promise, nobody awaits it, and the rejection lands on the process
 * instead of the caller. That is why this gate exists at all.
 */

import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const SRC_DIR = join(ROOT, 'packages', 'mimir', 'src')

/** Lint one probe file and return the rule ids that fired. */
async function lintProbe(source: string): Promise<readonly string[]> {
  const path = join(SRC_DIR, `zz-lint-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`)
  await writeFile(path, source)
  try {
    const { stdout } = await run(
      process.execPath,
      [join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'), '--format', 'json', relative(ROOT, path)],
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
    ).catch((error: unknown) => error as { stdout?: string })
    const parsed = JSON.parse(stdout ?? '[]') as readonly { messages: readonly { ruleId: string | null }[] }[]
    return parsed.flatMap(entry => entry.messages.flatMap(message => (message.ruleId === null ? [] : [message.ruleId])))
  } finally {
    await rm(path, { force: true })
  }
}

describe('lint gate (#239)', () => {
  it('reports a promise nobody awaits', async () => {
    const rules = await lintProbe([
      'export function probe(load: () => Promise<number>): void {',
      '  load()',
      '}',
    ].join('\n'))
    expect(rules).toContain('@typescript-eslint/no-floating-promises')
  })

  it('accepts the two shapes the repo uses to fire and forget', async () => {
    // CODE_STYLE §4 sites say `void this.loadX()`; task-health.ts chains
    // `.catch(...)`. Both are deliberate, so the gate must stay quiet.
    const rules = await lintProbe([
      'export function probe(load: () => Promise<number>): void {',
      '  void load()',
      '  load().catch(() => undefined)',
      '}',
    ].join('\n'))
    expect(rules).not.toContain('@typescript-eslint/no-floating-promises')
  })

  it('reports an await on a non-promise', async () => {
    const rules = await lintProbe([
      'export async function probe(count: () => number): Promise<number> {',
      '  return await count()',
      '}',
    ].join('\n'))
    expect(rules).toContain('@typescript-eslint/await-thenable')
  })

  it('reports a promise handed to a slot that cannot carry it', async () => {
    const rules = await lintProbe([
      'export function probe(rows: readonly number[], keep: (n: number) => Promise<boolean>): readonly number[] {',
      '  return rows.filter(keep)',
      '}',
    ].join('\n'))
    expect(rules).toContain('@typescript-eslint/no-misused-promises')
  })

  it('stays out of the test tree, where an unawaited promise is often the point', async () => {
    // The config scopes itself to `packages/*/src`; a spec that resolves a
    // deferred by hand would otherwise fight the gate.
    const rules = await lintProbe('export function probe(): void {}\n')
    expect(rules).toEqual([])
  })
})

describe('lint wiring (#239)', () => {
  it('is reachable from the package scripts and from CI', async () => {
    const manifest = JSON.parse(
      await readFile(join(ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(manifest.scripts['lint']).toBe('eslint')
    const workflow = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    // The gate has to run before tests: a floating promise in src is a defect,
    // not a flake, and it should fail the cheapest job first.
    expect(workflow).toContain('pnpm run lint')
    expect(workflow.indexOf('pnpm run lint')).toBeLessThan(workflow.indexOf('pnpm test'))
  })

  it('keeps the workspace the config is supposed to cover', async () => {
    const config = await readFile(join(ROOT, 'eslint.config.mjs'), 'utf8')
    for (const rule of ['no-floating-promises', 'await-thenable', 'no-misused-promises']) {
      expect(config).toContain(rule)
    }
    // An ignore list that swallows the source tree would make every other
    // assertion in this file pass for the wrong reason.
    expect(config).not.toMatch(/ignores:\s*\[[^\]]*'packages\/\*\/src/)
  })
})
