/**
 * File-level operations for the shared paper's `main.tex` (and the same
 * operations reused for `references.bib`): a read snapshot carrying the mtime
 * the content was read from, and an optimistic-concurrency replace. Reads and
 * saves share ONE cross-process writer lock per file (`withFileLock`): the
 * save runs its mtime check and its atomic commit under the lock, and the read
 * now takes the same lock so it cannot observe the check-then-commit
 * half-applied. An agent writing through the file tools, a human saving from
 * the panel, and a reader building an outline/diff base can therefore never
 * interleave a check-then-write or pair new content with a stale mtime. Pure
 * path in, structured outcome out — no wire types.
 * @module dsh-mimir/src/paper-source
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'

/** Paper directory used when neither the request nor the project names one. */
export const DEFAULT_PAPER_DIR = 'paper'

/**
 * Resolve the paper directory for one call: an explicit request directory
 * wins over the project record's `paperDir`, which wins over the default.
 * The chosen candidate must be a relative path that stays inside the
 * workspace — an absolute path or a `..` escape resolves to undefined, which
 * callers report as `invalid-dir` rather than falling back silently.
 * @param workspaceDir - absolute research workspace root.
 * @param requestDir - directory the caller explicitly asked for, if any.
 * @param projectPaperDir - the project record's `paperDir`, if any.
 * @returns the absolute paper directory, or undefined for a violating path.
 */
export function resolvePaperDir(
  workspaceDir: string,
  requestDir?: string,
  projectPaperDir?: string,
): string | undefined {
  const candidate = requestDir ?? projectPaperDir ?? DEFAULT_PAPER_DIR
  if (candidate.trim().length === 0 || isAbsolute(candidate)) return undefined
  const root = resolve(workspaceDir)
  const resolved = resolve(root, candidate)
  return resolved === root || resolved.startsWith(root + sep) ? resolved : undefined
}

/**
 * Realpath-backed variant of {@link resolvePaperDir} (#213): the lexical
 * check first, then the nearest existing ancestor of the resolved directory
 * must realpath INSIDE the workspace's realpath — a symlinked paper
 * directory (or a symlink anywhere along the path) cannot smuggle reads and
 * writes outside the workspace. A directory that does not exist yet passes
 * when its ancestor chain is clean; the caller's mkdir then creates a real
 * directory. Returns undefined for a violating path (`invalid-dir`).
 * @param workspaceDir - absolute research workspace root.
 * @param requestDir - directory the caller explicitly asked for, if any.
 * @param projectPaperDir - the project record's `paperDir`, if any.
 * @returns the absolute paper directory, or undefined for a violating path.
 */
export async function resolvePaperDirReal(
  workspaceDir: string,
  requestDir?: string,
  projectPaperDir?: string,
): Promise<string | undefined> {
  const resolved = resolvePaperDir(workspaceDir, requestDir, projectPaperDir)
  if (resolved === undefined) return undefined
  const rootReal = await realpath(resolve(workspaceDir)).catch(() => undefined)
  if (rootReal === undefined) return undefined
  // realpath rejects on ENOENT; walk up to the nearest existing ancestor.
  let probe = resolved
  for (;;) {
    const probeReal = await realpath(probe).catch(() => undefined)
    if (probeReal !== undefined) {
      return probeReal === rootReal || probeReal.startsWith(rootReal + sep) ? resolved : undefined
    }
    const parent = dirname(probe)
    if (parent === probe) return undefined
    probe = parent
  }
}

/** Content of `main.tex` plus the mtime it was read from. */
export interface PaperSourceSnapshot {
  readonly content: string
  readonly mtimeMs: number
}

/** Structured outcome of one optimistic-concurrency save. */
export type SavePaperOutcome =
  | { readonly kind: 'saved'; readonly mtimeMs: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'conflict'; readonly currentMtimeMs: number }
/** Whether one fs failure names a missing entry (as opposed to a real I/O error). */
export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT'
}

/** stat one path, mapping absence to undefined. */
async function statOrUndefined(path: string): Promise<{ mtimeMs: number; mode: number } | undefined> {
  try {
    const stats = await stat(path)
    return { mtimeMs: stats.mtimeMs, mode: stats.mode }
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/**
 * Read a workspace text file with the mtime its content belongs to. The read
 * and the stat are both inside the file's cross-process writer lock, so a
 * save (which commits under the same lock) can never land between them: the
 * caller gets a snapshot whose content matches the mtime it carries. Without
 * the lock, a read/stat pair could straddle a writer's atomic rename and pair
 * the new content with the old inode's mtime — a stale-mtime base that would
 * wrongly accept (or wrongly reject) the next optimistic save.
 *
 * The lock is the same `withFileLock` the save path holds, so a read is
 * mutually exclusive with a save of the same file. The writer lock is NOT
 * re-entrant: callers that already hold the lock for `texPath` (a
 * read-modify-write like {@link appendBibEntries}) must read via the exported
 * {@link readPaperSourceUnlocked} instead of nesting this helper, which would
 * self-deadlock until the lock times out.
 * @param texPath - absolute path of the paper's `main.tex`.
 * @returns the snapshot, or undefined when the paper has not been scaffolded.
 */
export async function readPaperSource(texPath: string): Promise<PaperSourceSnapshot | undefined> {
  // The writer lock requires the parent directory to exist; a missing file or
  // directory is reported absent without joining the lock — the same
  // pre-check the save path uses for `missing`, keeping a `paper-not-found`
  // from surfacing as a lock-setup ENOENT. The pre-check carries no mtime
  // claim, so it introduces no read/save coherence hazard.
  if (await statOrUndefined(texPath) === undefined) return undefined
  return await withFileLock(texPath, () => readPaperSourceUnlocked(texPath))
}

/**
 * Read a workspace text file without taking the writer lock. For callers that
 * already hold the lock for the same path (the outer read-modify-write of
 * {@link appendBibEntries}) — nesting the locking read would self-deadlock.
 * Prefer {@link readPaperSource} for standalone reads: this unlocked variant
 * can pair new content with a stale mtime if it straddles an atomic rename.
 * @param texPath - absolute path of the file to read.
 * @returns the snapshot, or undefined when the file has not been scaffolded.
 */
export async function readPaperSourceUnlocked(texPath: string): Promise<PaperSourceSnapshot | undefined> {
  try {
    const content = await readFile(texPath, 'utf8')
    const stats = await stat(texPath)
    return { content, mtimeMs: stats.mtimeMs }
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/**
 * Replace a workspace text file only when its current mtime still equals the
 * mtime the caller's draft is based on — the generalized form of the
 * `main.tex` save, shared by `references.bib`. A null `baseMtimeMs` means
 * "the caller read an absent file": the save then CREATES the file, and an
 * existing file conflicts (someone created it since). A mismatch means
 * another writer (the agent's file tools, a `/paper-*` command) landed a
 * change the caller never saw; the draft is preserved client-side and the
 * conflict is reported instead of overwriting. The commit preserves an
 * existing file's permission bits. The parent directory must exist (callers
 * resolve and stat it first, reporting `invalid-dir`/`paper-not-found`).
 * @param filePath - absolute path of the file to replace.
 * @param content - complete next file content.
 * @param baseMtimeMs - mtime the draft is based on, or null for create-only.
 * @returns `saved` with the committed mtime, `missing` when the file was
 * expected but is gone, or `conflict` with the mtime that displaced the base.
 * The save shares the file's cross-process writer lock with
 * {@link readPaperSource}, so a read and a save of the same file are mutually
 * exclusive and a save's check-then-commit pair is never observable halfway.
 */
export async function saveTextFileOptimistic(
  filePath: string,
  content: string,
  baseMtimeMs: number | null,
): Promise<SavePaperOutcome> {
  // The writer lock requires the parent directory to exist; a missing file
  // with a non-null base must report `missing`, not a lock-setup failure.
  if (baseMtimeMs !== null && await statOrUndefined(filePath) === undefined) return { kind: 'missing' }
  return await withFileLock(filePath, async (): Promise<SavePaperOutcome> => {
    const current = await statOrUndefined(filePath)
    if (current === undefined) {
      if (baseMtimeMs !== null) return { kind: 'missing' }
      // Fresh inode: the standard user-default bits (the umask applies).
      await writeFileAtomic(filePath, content, { mode: 0o666 })
    } else {
      if (baseMtimeMs === null || current.mtimeMs !== baseMtimeMs) {
        return { kind: 'conflict', currentMtimeMs: current.mtimeMs }
      }
      await writeFileAtomic(filePath, content, { mode: current.mode & 0o777 })
    }
    const committed = await statOrUndefined(filePath)
    // A lock-free third party deleting the file between the rename and this
    // stat is an I/O race the wire union cannot name; fail loud instead of
    // reporting the stale base mtime as the commit's.
    if (committed === undefined) {
      throw new Error(`research: '${filePath}' disappeared during an atomic save`)
    }
    return { kind: 'saved', mtimeMs: committed.mtimeMs }
  })
}

/**
 * Replace `main.tex` only when its current mtime still equals the mtime the
 * caller's draft is based on. Thin wrapper over {@link saveTextFileOptimistic}
 * keeping the paper-save contract: the file must already exist.
 * @param texPath - absolute path of the paper's `main.tex`.
 * @param content - complete next file content.
 * @param baseMtimeMs - mtime the draft was last read from or saved as.
 * @returns `saved` with the committed mtime, `missing` when the file is gone,
 * or `conflict` with the mtime that displaced the caller's base.
 */
export async function savePaperSourceFile(
  texPath: string,
  content: string,
  baseMtimeMs: number,
): Promise<SavePaperOutcome> {
  return await saveTextFileOptimistic(texPath, content, baseMtimeMs)
}
