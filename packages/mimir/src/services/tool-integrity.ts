/**
 * Lightweight integrity for externally cloned skills/tools (#237).
 *
 * Mimir clones a third-party pipeline on first use and then trusts the
 * directory forever. Two failure modes follow, and neither has a good error:
 * a clone killed halfway leaves a present-but-truncated tree, and an operator
 * updating the tool by hand leaves a file that exists but is not runnable. The
 * extractor then fails somewhere else entirely and the message names the wrong
 * thing.
 *
 * This module is deliberately not a supply-chain system. It records *which*
 * source and commit the clone came from, and it answers one question before
 * use — "is this file here and does it have content" — with a remedy sentence
 * when the answer is no. That is the whole contract: enough to tell a stale
 * tool from a broken one, cheap enough to run on every use.
 *
 * @module dsh-mimir/services/tool-integrity
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** File name of the provenance record kept beside a clone. */
export const PROVENANCE_FILE_NAME = 'PROVENANCE.json'

/** What was cloned, and from which commit. */
export interface ToolProvenance {
  /** The upstream URL the clone came from. */
  readonly source: string
  /** The commit the clone sat at, so a later reader can tell stale from current. */
  readonly commit: string
}

/** Why an external tool cannot be used right now. */
export type ToolCheckFailure = 'missing' | 'broken'

/** The verdict of {@link checkExternalTool}. */
export type ToolCheckOutcome =
  | { readonly ok: true }
  | { readonly ok: false, readonly failure: ToolCheckFailure, readonly remedy: string }

/**
 * Record the provenance of one clone. Written after a successful clone, so a
 * directory without this file is the signal that the clone never finished.
 * @param dir - the clone's root directory.
 * @param provenance - the source URL and the commit it was cloned at.
 */
export async function writeToolProvenance(dir: string, provenance: ToolProvenance): Promise<void> {
  await writeFile(join(dir, PROVENANCE_FILE_NAME), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
}

/**
 * Read one clone's provenance.
 *
 * A missing or malformed record reads as `undefined` rather than throwing:
 * directories cloned before this module existed are legitimate, and a corrupt
 * record must not be the thing that breaks a use that would otherwise work.
 * @param dir - the clone's root directory.
 * @returns the recorded provenance, or undefined when there is none to trust.
 */
export async function readToolProvenance(dir: string): Promise<ToolProvenance | undefined> {
  let raw: string
  try {
    raw = await readFile(join(dir, PROVENANCE_FILE_NAME), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as { source?: unknown, commit?: unknown }
  if (typeof record.source !== 'string' || record.source === '') return undefined
  if (typeof record.commit !== 'string' || record.commit === '') return undefined
  return Object.freeze({ source: record.source, commit: record.commit })
}

/**
 * The sentence a caller shows when the check fails. Kept here so the wording
 * that names the remedy lives next to the failure that produced it.
 * @param failure - which check failed.
 * @param path - the file that was checked.
 * @returns one line naming the state and the way out.
 */
function remedyFor(failure: ToolCheckFailure, path: string): string {
  return failure === 'missing'
    ? `missing ${path} — re-fetch the skill with a fresh clone (delete the directory and run the extract again)`
    : `empty ${path} — the clone looks truncated; re-fetch the skill with a fresh clone`
}

/**
 * Check that an external tool file is present and has content.
 *
 * Emptiness is a real state and a distinct one: a `git clone` interrupted after
 * creating the file but before writing it leaves something that `stat` reports
 * as a regular file, which is exactly the case that used to sail through and
 * fail inside the runner.
 * @param path - the script or executable to check.
 * @returns `{ok: true}`, or the failure plus a remedy sentence.
 */
export async function checkExternalTool(path: string): Promise<ToolCheckOutcome> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch {
    return Object.freeze({ ok: false, failure: 'missing', remedy: remedyFor('missing', path) })
  }
  if (!info.isFile() || info.size === 0) {
    return Object.freeze({ ok: false, failure: 'broken', remedy: remedyFor('broken', path) })
  }
  return Object.freeze({ ok: true })
}
