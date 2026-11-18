/**
 * #244: the root export is the compatibility promise, so it has to be small.
 *
 * The audit found the package root re-exporting the fold primitives, the
 * cognitive-map derivations, the evidence graph and the rendered reports — 320
 * specifiers, almost all of them implementation detail. Every one of those was
 * an implicit promise: renaming a fold helper became a breaking change.
 *
 * The split puts the moving parts on `dsh-mimir/experimental` and leaves the
 * root to the plugin entry, `Config`, and the types the client and Remote
 * speak. These tests are the ratchet: they fail if something creeps back onto
 * the root, and they fail if the experimental subpath stops carrying what moved
 * out of it.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT_INDEX = join(import.meta.dirname, '../src/index.ts')
const EXPERIMENTAL = join(import.meta.dirname, '../src/experimental.ts')
const PACKAGE_JSON = join(import.meta.dirname, '../package.json')

/** Data modules that moved off the root; the root must not re-export them. */
const RELOCATED = [
  'time.ts', 'vocabulary.ts', 'ledger.ts', 'cognitive-map.ts', 'registry.ts',
  'worktree.ts', 'cbe-engine.ts', 'foraging.ts', 'library-themes.ts', 'habits.ts',
  'eureka.ts', 'window-features.ts', 'report-capsules.ts', 'report-tier.ts',
  'render-digest.ts', 'ledger-ews.ts', 'moment-index.ts', 'evidence-graph.ts',
  'evidence-identity.ts', 'moment-candidates.ts',
] as const

const rootSource = readFileSync(ROOT_INDEX, 'utf8')
const experimentalSource = readFileSync(EXPERIMENTAL, 'utf8')

describe('root export surface (#244)', () => {
  it('does not re-export any relocated module', () => {
    const leaking = RELOCATED.filter(module => rootSource.includes(`from './${module}'`))
    expect(leaking).toEqual([])
  })

  it('keeps the plugin entry and the client-facing contract', () => {
    // What a third party actually builds on: the entry, the schema, and the
    // storage contract the service config names.
    expect(rootSource).toContain('export async function apply(')
    expect(rootSource).toContain('export const Config')
    expect(rootSource).toContain("export const name = 'mimir'")
    expect(rootSource).toContain('export { researchWikiDomainSpec }')
    expect(rootSource).toContain('export { ResearchService }')
    // The panel's compile-fix view reads this type by name.
    expect(rootSource).toContain("export type { LatexIssue } from './latex-log.ts'")
  })

  it('carries the relocated surface on the experimental subpath instead', () => {
    for (const module of RELOCATED) {
      expect(experimentalSource).toContain(`from './${module}'`)
    }
  })

  it('marks the experimental module as such', () => {
    expect(experimentalSource).toContain('@experimental')
    // The rule that keeps the split from rotting is written down where the
    // next person will read it: next to the exports.
    expect(experimentalSource).toContain('nothing in this file is re-exported from `index.ts`')
  })

  it('declares the subpath so the import resolves at runtime, not only in types', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      exports: Record<string, { types: string; default: string } | string>
    }
    const entry = manifest.exports['./experimental']
    expect(entry).toBeDefined()
    expect(entry).toMatchObject({
      types: './lib/types/experimental.d.ts',
      default: './lib/experimental.js',
    })
  })

  it('keeps the specifier count on the root from creeping back up', () => {
    // A number rather than a shape: the point of the issue is that the surface
    // is small enough to review. Raising this ceiling is a deliberate act.
    const names = new Set<string>()
    for (const match of rootSource.matchAll(/export (?:type )?\{([^}]*)\}/g)) {
      for (const raw of match[1]!.split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
        if (name !== undefined && name.length > 0) names.add(name)
      }
    }
    expect(names.size).toBeLessThanOrEqual(200)
  })
})
