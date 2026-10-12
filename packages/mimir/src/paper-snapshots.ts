/**
 * File-level operations for per-project paper snapshots: a successful compile
 * captures the paper directory's `.tex`/`.bib` sources into
 * `<workspaceDir>/snapshots/<projectId>/<snapshotId>/` (relative paths
 * preserved, plus a `manifest.json` carrying the file list), and the retained
 * set is trimmed to {@link PAPER_SNAPSHOT_LIMIT} (oldest first). Snapshots are
 * pure filesystem storage — nothing here touches the wiki domain. Pure path
 * in, structured outcome out — no wire types.
 * @module dsh-mimir/src/paper-snapshots
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isNotFound } from './paper-source.ts'

/** Extensions captured into a snapshot (the paper's source files). */
const SNAPSHOT_EXTENSIONS = ['.tex', '.bib'] as const

/** Snapshots retained per project; older ones are deleted after each capture. */
export const PAPER_SNAPSHOT_LIMIT = 50

/**
 * The snapshot id shape: a compact ISO-8601 UTC timestamp
 * (`20260823T063755939Z`), with a `-N` suffix disambiguating same-millisecond
 * captures. Zero-padded and fixed-width, so lexicographic order is
 * chronological order.
 */
const SNAPSHOT_ID_RE = /^\d{8}T\d{9}Z(?:-\d+)?$/

/** One file entry of one snapshot manifest. */
export interface PaperSnapshotManifestFile {
  /** Path relative to the project's paper directory (`main.tex`, `sections/intro.tex`). */
  readonly path: string
  readonly sizeBytes: number
}

/** The `manifest.json` payload of one snapshot directory. */
export interface PaperSnapshotManifest {
  readonly id: string
  /** ISO-8601 timestamp of the capture. */
  readonly createdAt: string
  readonly files: readonly PaperSnapshotManifestFile[]
}

/** One captured file: its paper-directory-relative path and full content. */
export interface PaperSnapshotFileContent {
  readonly path: string
  readonly content: string
}

/** Whether one string is a well-formed snapshot id (and thus escape-free). */
export function isValidSnapshotId(id: string): boolean {
  return SNAPSHOT_ID_RE.test(id)
}

/**
 * Resolve one project's snapshots root, containing escapes: the project id
 * must resolve to a directory strictly inside `<workspaceDir>/snapshots`.
 * @param workspaceDir - absolute research workspace root.
 * @param projectId - wiki project id (untrusted path segment).
 * @returns the absolute snapshots root, or undefined for a violating id.
 */
export function resolveSnapshotsRoot(workspaceDir: string, projectId: string): string | undefined {
  const root = resolve(workspaceDir, 'snapshots')
  const resolved = resolve(root, projectId)
  return resolved.startsWith(root + sep) ? resolved : undefined
}

/**
 * Collect the paper directory's source files (`.tex`/`.bib`), as relative
 * paths in sorted order. Returns undefined when the directory is absent.
 */
async function collectSourceFiles(paperDir: string): Promise<string[] | undefined> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
      } else if (entry.isFile()
        && SNAPSHOT_EXTENSIONS.some(ext => entry.name.toLowerCase().endsWith(ext))) {
        // Manifest paths are workspace-neutral forward-slash paths: they show
        // in the panel and are re-joined on revert, and the snapshot contract
        // is identical across platforms (relative() is platform-sep'd).
        found.push(relative(paperDir, absolute).split(sep).join('/'))
      }
    }
  }
  try {
    await walk(paperDir)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  return found.sort()
}

/** The next free snapshot id for one capture instant (`-N` on collisions). */
async function freshSnapshotId(projectRoot: string, createdAt: string): Promise<string> {
  const base = createdAt.replace(/[-:.]/g, '')
  let id = base
  for (let suffix = 2; ; suffix += 1) {
    try {
      await stat(join(projectRoot, id))
      id = `${base}-${String(suffix)}`
    } catch (error) {
      if (isNotFound(error)) return id
      throw error
    }
  }
}

/**
 * Capture the paper directory's current `.tex`/`.bib` sources as one new
 * snapshot and trim the retained set to {@link PAPER_SNAPSHOT_LIMIT}. Pure
 * filesystem work; the caller decides when a capture is due.
 * @param projectRoot - absolute snapshots root of one project.
 * @param paperDir - absolute paper directory to capture.
 * @param now - capture instant (injectable for tests).
 * @returns the written manifest, or undefined when the paper directory is
 * absent or holds no source files (nothing worth snapshotting).
 */
export async function capturePaperSnapshot(
  projectRoot: string,
  paperDir: string,
  now: Date = new Date(),
): Promise<PaperSnapshotManifest | undefined> {
  const files = await collectSourceFiles(paperDir)
  if (files === undefined || files.length === 0) return undefined
  const createdAt = now.toISOString()
  const id = await freshSnapshotId(projectRoot, createdAt)
  const snapshotDir = join(projectRoot, id)
  const manifestFiles: PaperSnapshotManifestFile[] = []
  for (const path of files) {
    const content = await readFile(join(paperDir, path))
    const target = join(snapshotDir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
    manifestFiles.push({ path, sizeBytes: content.byteLength })
  }
  const manifest: PaperSnapshotManifest = { id, createdAt, files: manifestFiles }
  await writeFileAtomic(join(snapshotDir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o666 })
  await prunePaperSnapshots(projectRoot, PAPER_SNAPSHOT_LIMIT)
  return manifest
}

/**
 * List one project's snapshots, newest first. Directories without a readable
 * manifest (foreign or half-written entries) are skipped, as are ids that
 * fail the format check.
 * @param projectRoot - absolute snapshots root of one project.
 * @returns the snapshot manifests, newest first.
 */
export async function listPaperSnapshots(projectRoot: string): Promise<PaperSnapshotManifest[]> {
  let entries
  try {
    entries = await readdir(projectRoot, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
  const manifests: PaperSnapshotManifest[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSnapshotId(entry.name)) continue
    try {
      const manifest = JSON.parse(
        await readFile(join(projectRoot, entry.name, 'manifest.json'), 'utf8'),
      ) as PaperSnapshotManifest
      if (manifest.id !== entry.name) continue
      manifests.push(manifest)
    } catch (error) {
      if (!isNotFound(error) && !(error instanceof SyntaxError)) throw error
    }
  }
  // Fixed-width zero-padded ids sort chronologically as plain strings.
  return manifests.sort((left, right) => right.id.localeCompare(left.id))
}

/**
 * Delete the oldest snapshots beyond `keep`. Ids sort chronologically, so the
 * retained set is the lexicographic tail.
 * @param projectRoot - absolute snapshots root of one project.
 * @param keep - how many snapshots to retain.
 */
export async function prunePaperSnapshots(projectRoot: string, keep: number): Promise<void> {
  let entries
  try {
    entries = await readdir(projectRoot, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  const ids = entries
    .filter(entry => entry.isDirectory() && isValidSnapshotId(entry.name))
    .map(entry => entry.name)
    .sort()
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) {
    await rm(join(projectRoot, id), { recursive: true, force: true })
  }
}

/**
 * Whether one manifest path is safe to read back or write back: relative,
 * escape-free, and a captured extension. Tampered manifests fail closed.
 */
function isSafeSnapshotPath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path)) return false
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false
  return SNAPSHOT_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext))
}

/**
 * Read one snapshot's files with their content, following its manifest.
 * @param projectRoot - absolute snapshots root of one project.
 * @param id - the snapshot id (format-checked by callers; re-checked here).
 * @returns the id plus file contents, or undefined when the snapshot (or one
 * of its manifest entries) is absent or the manifest is malformed.
 */
export async function readPaperSnapshot(
  projectRoot: string,
  id: string,
): Promise<{ readonly id: string; readonly files: readonly PaperSnapshotFileContent[] } | undefined> {
  if (!isValidSnapshotId(id)) return undefined
  let manifest: PaperSnapshotManifest
  try {
    manifest = JSON.parse(
      await readFile(join(projectRoot, id, 'manifest.json'), 'utf8'),
    ) as PaperSnapshotManifest
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined
    throw error
  }
  if (!Array.isArray(manifest.files)) return undefined
  const files: PaperSnapshotFileContent[] = []
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !isSafeSnapshotPath(entry.path)) return undefined
    try {
      files.push({ path: entry.path, content: await readFile(join(projectRoot, id, entry.path), 'utf8') })
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }
  return { id, files }
}
