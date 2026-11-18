/**
 * The one place a {@link ResearchServiceConfig} is assembled (#231).
 *
 * The service's dependencies used to be mapped twice: here in `apply`, where
 * the resolved knobs first met the open domain, and again in the
 * `ResearchService` constructor, which copied each optional field onto
 * `this.deps` with its own spread chain. Two mappings of one shape means a
 * field added in one place silently goes missing in the other — and the
 * missing one is invisible, because `exactOptionalPropertyTypes` lets both
 * sides compile.
 *
 * So: `buildDeps` decides what a config IS, and both the plugin entry and the
 * constructor go through it. The constructor's job is then only its own
 * invariants (a non-empty workspace root), not the assembly.
 * @module dsh-mimir/services/wiring
 */

import type { ResearchServiceConfig } from '../service.ts'
import type { ResearchWikiDomain } from '../store.ts'

/**
 * Both halves of a service config: the wiring `apply` resolves and the open
 * domain it just created.
 */
export interface ResearchWiring {
  /** Absolute research workspace root (already resolved against the process cwd). */
  readonly workspaceDir: string
  /** The open research-wiki domain handle owned by the plugin. */
  readonly domain: ResearchWikiDomain
  /** The rest of a service config: every resolved knob, exactly as the service reads it. */
  readonly config: Omit<ResearchServiceConfig, 'workspaceDir' | 'domain'>
}

/**
 * Assemble one service config from its two halves.
 *
 * This is deliberately a plain object construction with no spreading of
 * optionals: `exactOptionalPropertyTypes` is on, and the service reads absence
 * (`config.backup === undefined`) as a documented mode, so a field that is
 * `undefined` must not be present at all. Naming each optional explicitly
 * makes that the default rather than something every caller has to remember.
 * @param wiring - the resolved knobs and the open domain.
 * @returns the config `ResearchService` takes.
 */
export function buildDeps(wiring: ResearchWiring): ResearchServiceConfig {
  const { config } = wiring
  const deps: {
    -readonly [K in keyof ResearchServiceConfig]: ResearchServiceConfig[K]
  } = {
    workspaceDir: wiring.workspaceDir,
    domain: wiring.domain,
    latex: config.latex,
  }
  // Each optional field is copied only when present: an absent one is a
  // documented mode (no backup loop, no web search, no Zotero, …), so writing
  // `undefined` would hand the service a key it must not see.
  if (config.backup !== undefined) deps.backup = config.backup
  if (config.search !== undefined) deps.search = config.search
  if (config.arxiv !== undefined) deps.arxiv = config.arxiv
  if (config.svg !== undefined) deps.svg = config.svg
  if (config.zotero !== undefined) deps.zotero = config.zotero
  if (config.meetings !== undefined) deps.meetings = config.meetings
  if (config.notifyWikiChange !== undefined) deps.notifyWikiChange = config.notifyWikiChange
  if (config.taskHealth !== undefined) deps.taskHealth = config.taskHealth
  if (config.jobs !== undefined) deps.jobs = config.jobs
  if (config.capabilities !== undefined) deps.capabilities = config.capabilities
  if (config.metrics !== undefined) deps.metrics = config.metrics
  return deps
}
