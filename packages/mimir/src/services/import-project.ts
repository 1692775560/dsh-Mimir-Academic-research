/**
 * ImportProject domain module: adopt one existing local LaTeX project into
 * the research workspace. The source tree is COPIED (never referenced) into
 * `<workspaceDir>/imported/<slug>/` so the result satisfies the paperDir
 * confinement model (`resolvePaperDir` rejects escapes), and a wiki project
 * record at the `writing` stage points at the copy. Thin forwarding of the
 * `importProject` Remote method lives in `service.ts`.
 * @module dsh-mimir/src/services/import-project
 */

import { cp, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { emitEvent, PANEL_ACTOR } from '../ledger.ts'
import type { ResearchWikiDomain } from '../store.ts'
import type {
  ProjectRecord,
  ResearchImportProjectRequest,
  ResearchImportProjectResult,
  ResearchImportedProject,
} from '../types.ts'
import { rejected, success } from './common.ts'

/**
 * Everything the importProject domain function needs from the service scope.
 * Inlined (rather than referencing `service.ts`'s config type) so this module
 * never imports the facade — no cycle.
 */
export interface ImportProjectDeps {
  /** Absolute research workspace root. */
  readonly workspaceDir: string
  /** Open research-wiki domain handle. */
  readonly domain: ResearchWikiDomain
}

/** Directory names never copied into the workspace. */
const EXCLUDED_DIRS = new Set(['.git', 'node_modules'])

/** Image extensions counted as figures (matching the figures view's set). */
const FIGURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.svg'])

/**
 * Expand a leading `~` against the user's home directory.
 * @param input - the raw path the user typed.
 * @returns the path with any home prefix expanded.
 */
export function expandHome(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

/**
 * Slugify one directory name for the workspace copy: lowercase, every
 * non-alphanumeric run becomes one dash, edges trimmed. Falls back to
 * `project` when nothing survives (e.g. an all-CJK name).
 * @param name - the source directory's basename.
 * @returns the slug candidate.
 */
export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  return slug === '' ? 'project' : slug
}

/**
 * Extract the argument of the first `\title{...}` in one tex source,
 * tolerating multi-line content and nested brace groups (basic balanced-brace
 * walk, not a full TeX parse).
 * @param tex - the entry file's source.
 * @returns the title text, or undefined when no complete `\title{...}` exists.
 */
export function extractTexTitle(tex: string): string | undefined {
  const marker = tex.search(/\\title\s*\{/u)
  if (marker === -1) return undefined
  const open = tex.indexOf('{', marker)
  let depth = 0
  for (let index = open; index < tex.length; index += 1) {
    const char = tex.charAt(index)
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const title = tex.slice(open + 1, index).replace(/\s+/gu, ' ').trim()
        return title === '' ? undefined : title
      }
    }
  }
  return undefined
}

/**
 * Find the entry .tex of one project directory: a top-level file containing
 * `\documentclass`, preferring `main.tex`.
 * @param dir - absolute directory to scan (top level only).
 * @returns the entry file's basename, or undefined when none qualifies.
 */
async function findEntryTex(dir: string): Promise<string | undefined> {
  const names = (await readdir(dir)).filter(name => name.endsWith('.tex')).sort()
  const withClass: string[] = []
  for (const name of names) {
    const content = await readFile(join(dir, name), 'utf8').catch(() => '')
    if (content.includes('\\documentclass')) withClass.push(name)
  }
  return withClass.find(name => name === 'main.tex') ?? withClass[0]
}

/**
 * Count figure files under one directory, recursively.
 * @param dir - absolute root.
 * @returns how many `.png`/`.jpg`/`.jpeg`/`.pdf`/`.svg` files it holds.
 */
async function countFigures(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true })
  let count = 0
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      count += await countFigures(join(dir, entry.name))
    } else if (FIGURE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase())) {
      count += 1
    }
  }
  return count
}

/**
 * Collect every symlink under `root` (the source tree's realpath). Each must
 * resolve to a live target INSIDE the source tree: `cp` preserves links
 * rather than dereferencing them, so an escaping or dangling symlink would
 * smuggle out-of-tree content into the import or leave the workspace copy
 * holding a link that later defeats paperDir confinement (#213).
 * @param root - the source tree's realpath.
 * @returns the clean tree's symlink paths, or the first offending symlink.
 */
export async function collectInTreeSymlinks(
  root: string,
): Promise<{ readonly symlinks: string[] } | { readonly offending: string }> {
  const symlinks: string[] = []
  const walk = async (dir: string): Promise<string | undefined> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const real = await realpath(path).catch(() => undefined)
        if (real === undefined || (real !== root && !real.startsWith(root + sep))) return path
        symlinks.push(path)
      } else if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
        const hit = await walk(path)
        if (hit !== undefined) return hit
      }
    }
    return undefined
  }
  const offending = await walk(root)
  return offending === undefined ? { symlinks } : { offending }
}

/**
 * Import one existing local LaTeX project into the research workspace.
 * Validation (path exists and is a directory, an entry .tex with
 * `\documentclass` exists, no symlink dangles or escapes the source tree)
 * runs BEFORE anything is copied or recorded, so a rejected import changes
 * nothing. The copy excludes `.git` and `node_modules`; a slug collision
 * gains a `-2`/`-3`… suffix. The title is the explicit request title, else
 * the entry file's `\title{...}`, else the source directory name. The
 * created record starts at the `writing` stage with `paperDir` pointing at
 * the copy, and the import lands in the ledger.
 * @param deps - workspace root plus the open wiki domain.
 * @param request - the source path and the optional explicit title.
 * @returns the imported project's summary, or the settled failure.
 */
export async function importProject(
  deps: ImportProjectDeps,
  request: ResearchImportProjectRequest,
): Promise<ResearchImportProjectResult> {
  const source = expandHome(request.path)
  if (!isAbsolute(source)) {
    return rejected({
      code: 'invalid-path',
      path: request.path,
    })
  }
  const stats = await stat(source).catch(() => undefined)
  if (stats === undefined) {
    return rejected({ code: 'invalid-path', path: request.path })
  }
  if (!stats.isDirectory()) {
    return rejected({ code: 'invalid-input', message: `not a directory: ${source}` })
  }

  // Symlink confinement before anything is read in bulk or copied: every
  // symlink in the tree must resolve inside the source (#213).
  const sourceReal = await realpath(source)
  const scan = await collectInTreeSymlinks(sourceReal)
  if ('offending' in scan) {
    return rejected({
      code: 'invalid-input',
      message: `symlink dangling or escaping the source tree: ${scan.offending}; remove it before importing`,
    })
  }

  const entryTex = await findEntryTex(source)
  if (entryTex === undefined) {
    return rejected({
      code: 'invalid-input',
      message: `no .tex file with \\documentclass found in ${source}; only directories containing a LaTeX project are supported`,
    })
  }
  const entrySource = await readFile(join(source, entryTex), 'utf8')

  const warnings: string[] = []
  const sourceName = basename(source)
  const slugBase = slugify(sourceName)
  const importedRoot = join(deps.workspaceDir, 'imported')
  await mkdir(importedRoot, { recursive: true })
  let slug = slugBase
  for (let suffix = 2; ; suffix += 1) {
    if (await stat(join(importedRoot, slug)).catch(() => undefined) === undefined) break
    slug = `${slugBase}-${String(suffix)}`
  }
  const target = join(importedRoot, slug)
  await cp(source, target, {
    recursive: true,
    // The root itself is always kept even when the source directory happens
    // to be NAMED like an excluded one.
    filter: path => path === source || !EXCLUDED_DIRS.has(basename(path)),
  })
  // cp preserves links as links; replace each verified in-tree symlink with
  // a real copy of its target so the workspace tree holds NO symlink at all.
  for (const link of scan.symlinks) {
    const real = await realpath(link)
    const copiedPath = join(target, relative(sourceReal, link))
    await rm(copiedPath, { force: true, recursive: true })
    // A target the copy filter excluded (.git/node_modules) stays excluded.
    if (relative(sourceReal, real).split(sep).some(part => EXCLUDED_DIRS.has(part))) continue
    await cp(real, copiedPath, { recursive: (await stat(real)).isDirectory() })
  }

  const title = request.title?.trim() ?? ''
  const resolvedTitle = title !== '' ? title : extractTexTitle(entrySource) ?? sourceName

  const figuresDir = join(target, 'figures')
  const hasFiguresDir = (await stat(figuresDir).catch(() => undefined))?.isDirectory() === true
  const figureCount = hasFiguresDir ? await countFigures(figuresDir) : await countFigures(target)
  if (!hasFiguresDir) warnings.push('no figures/ directory; counted image files across the project instead')
  if (entryTex !== 'main.tex') warnings.push(`entry file is ${entryTex}, not main.tex; the paper view reads main.tex by default`)
  const hasBib = (await readdir(target)).some(name => name.endsWith('.bib'))
  if (!hasBib) warnings.push('no .bib file found; the bibliography starts empty')

  const paperDir = `imported/${slug}`
  const record: ProjectRecord = {
    id: randomUUID(),
    title: resolvedTitle,
    stage: 'writing',
    paperDir,
    artifacts: [],
    reviewRounds: 0,
    updatedAt: new Date().toISOString(),
  }
  await deps.domain.table('projects').put(record.id, record)
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'project.imported',
    refs: { projectId: record.id },
    payload: {
      sourcePath: source,
      paperDir,
      entryTex,
      figureCount,
      warnings: warnings.length,
    },
  })
  return success({
    projectId: record.id,
    title: resolvedTitle,
    paperDir,
    entryTex,
    figureCount,
    warnings: Object.freeze(warnings),
  } satisfies ResearchImportedProject)
}
