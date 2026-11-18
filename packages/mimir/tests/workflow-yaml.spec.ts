/**
 * Every workflow file must parse (#239).
 *
 * GitHub does not fail a pull request over an invalid workflow file — it simply
 * creates no run, so the PR sits there with an empty check list and looks
 * healthy. That happened once already on this branch: a step name containing
 * `: ` broke the mapping and CI never ran at all. A local parse is the only
 * signal that costs nothing.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/** The repository root, three levels up from `packages/mimir/tests`. */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const WORKFLOW_DIR = join(ROOT, '.github/workflows')

/**
 * Parse one workflow document into its job map.
 * @param text - the workflow file's contents.
 * @returns the parsed document.
 */
function parseWorkflow(text: string): Record<string, unknown> {
  const document: unknown = parse(text)
  if (document === null || typeof document !== 'object') throw new Error('a workflow must be a mapping')
  return document as Record<string, unknown>
}

/** The workflow files checked in today. */
function workflowFiles(): readonly string[] {
  return readdirSync(WORKFLOW_DIR).filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
}

describe('workflow files (#239)', () => {
  it('parses every checked-in workflow', () => {
    const files = workflowFiles()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
      expect(() => parseWorkflow(text), `${file} does not parse`).not.toThrow()
    }
  })

  it('gives every workflow a trigger and at least one job', () => {
    for (const file of workflowFiles()) {
      const document = parseWorkflow(readFileSync(join(WORKFLOW_DIR, file), 'utf8'))
      // `on` is a real key in YAML 1.2; the parser keeps it as the string "on".
      expect(Object.hasOwn(document, 'on'), `${file} has no trigger`).toBe(true)
      const jobs = document.jobs
      expect(jobs !== null && typeof jobs === 'object', `${file} has no jobs`).toBe(true)
      expect(Object.keys(jobs as Record<string, unknown>).length).toBeGreaterThan(0)
    }
  })

  it('gives every job steps or a reusable-workflow reference', () => {
    for (const file of workflowFiles()) {
      const jobs = parseWorkflow(readFileSync(join(WORKFLOW_DIR, file), 'utf8')).jobs as Record<string, Record<string, unknown>>
      for (const [name, job] of Object.entries(jobs)) {
        const steps = job.steps
        const reusable = job.uses
        const hasSteps = Array.isArray(steps) && steps.length > 0
        expect(hasSteps || typeof reusable === 'string', `${file}: job ${name} has neither steps nor uses`).toBe(true)
      }
    }
  })

  it('rejects the shape that silently disabled CI', () => {
    // A colon inside an unquoted plain scalar ends the key, so the step list
    // becomes a mapping and the file stops parsing. This is the exact edit that
    // left this branch with no checks at all.
    expect(() => parseWorkflow([
      'on:',
      '  push:',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Lint gate (type-aware: promise rules)',
      '        run: pnpm run lint',
    ].join('\n'))).toThrow()
  })
})
