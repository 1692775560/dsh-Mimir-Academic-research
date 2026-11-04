/**
 * Workspace artifact reads and paper-figure discovery for the research
 * workbench: a whitelisted markdown-artifact read (no path segments, so no
 * traversal is expressible) and an image scan of a project's paper directory
 * top level plus its whole `figures/` subtree. Pure paths in, structured
 * outcomes out — no wire types.
 * @module dsh-mimir/src/artifacts
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { isNotFound } from './paper-source.ts'

/** Markdown artifacts the workbench's overview/experiment views may read. */
export const ARTIFACT_NAMES = [
  'IDEA_REPORT.md',
  'EXPERIMENT_PLAN.md',
  'EXPERIMENT_LOG.md',
  'NARRATIVE_REPORT.md',
] as const

/** One whitelisted artifact name. */
export type ArtifactName = typeof ARTIFACT_NAMES[number]

/** Whether one string names a readable artifact (the whitelist check). */
export function isArtifactName(name: string): name is ArtifactName {
  return (ARTIFACT_NAMES as readonly string[]).includes(name)
}

/** Image extensions the figures view and figure route serve. */
export const FIGURE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.pdf'] as const

/** The compile artifact is a PDF but never a figure; the scan skips it. */
const COMPILED_PAPER = 'main.pdf'

/** Whether one file name carries a servable figure extension. */
export function isFigureFile(name: string): boolean {
  if (name === COMPILED_PAPER) return false
  return (FIGURE_EXTENSIONS as readonly string[]).includes(extname(name).toLowerCase())
}

/** One figure file discovered under a paper directory. */
export interface FigureFile {
  readonly name: string
  /** Path relative to the paper directory (`foo.png` or `figures/bar.svg`). */
  readonly relPath: string
  readonly sizeBytes: number
  readonly mtimeMs: number
}

/**
 * Read one whitelisted markdown artifact from the workspace root.
 * @param workspaceDir - absolute research workspace root.
 * @param name - a member of {@link ARTIFACT_NAMES} (checked by the caller).
 * @returns content and mtime, or undefined when the artifact does not exist.
 */
export async function readWorkspaceArtifact(
  workspaceDir: string,
  name: ArtifactName,
): Promise<{ content: string; mtimeMs: number } | undefined> {
  const path = join(workspaceDir, name)
  try {
    const content = await readFile(path, 'utf8')
    return { content, mtimeMs: (await stat(path)).mtimeMs }
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/**
 * List the image files of one paper directory: its top level (files only,
 * the `sections/` convention stays out of the figure list) plus the whole
 * `figures/` subtree, filtered to the servable extensions. Directory entries
 * come from `readdir`'s lstat view, so a symlinked directory is never
 * followed and the scan stays inside the paper directory; an unreadable
 * directory or file is skipped instead of failing the whole listing. A
 * missing paper directory yields an empty list — the caller decides whether
 * that is `paper-not-found`.
 * @param paperDir - absolute paper directory (already workspace-confined).
 * @returns figure entries, top-level files first, each directory's files
 * name-sorted, nested directories walked in name order.
 */
export async function listPaperFigures(paperDir: string): Promise<FigureFile[]> {
  const scan = async (dir: string, relPrefix: string, deep: boolean): Promise<FigureFile[]> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Missing or unreadable directory: no scan entry, the listing survives.
      return []
    }
    const figures: FigureFile[] = []
    const subdirs: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (deep) subdirs.push(entry.name)
        continue
      }
      if (!entry.isFile() || !isFigureFile(entry.name)) continue
      // An unreadable file fails its stat; skip it rather than fail the list.
      const stats = await stat(join(dir, entry.name)).catch(() => undefined)
      if (stats === undefined) continue
      figures.push({
        name: entry.name,
        relPath: relPrefix + entry.name,
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
      })
    }
    figures.sort((left, right) => left.name.localeCompare(right.name))
    const nested: FigureFile[] = []
    for (const sub of subdirs.sort((left, right) => left.localeCompare(right))) {
      nested.push(...await scan(join(dir, sub), `${relPrefix}${sub}/`, deep))
    }
    return [...figures, ...nested]
  }
  return [...await scan(paperDir, '', false), ...await scan(join(paperDir, 'figures'), 'figures/', true)]
}
