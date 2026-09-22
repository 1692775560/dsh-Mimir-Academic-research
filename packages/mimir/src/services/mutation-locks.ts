/**
 * Process-wide keyed async mutexes serializing wiki read-modify-write
 * critical sections. Two locks live here: the paper mutation lock (per arXiv
 * id — library updates vs the project-delete cascade's unlink pass) and the
 * project mutation lock (per project id — `wiki_note` project-scoped writes
 * vs the delete/rename verbs). ponytail: split by domain only if contention
 * is measurable.
 * @module dsh-mimir/src/services/mutation-locks
 */

/** One keyed lock's tails: the promise one waiter must settle behind. */
type LockTails = Map<string, Promise<void>>

/** Serialize `mutation` behind every prior critical section of the same key. */
async function withKeyedLock<T>(tails: LockTails, key: string, mutation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  tails.set(key, current)
  await previous
  try {
    return await mutation()
  } finally {
    release()
    if (tails.get(key) === current) tails.delete(key)
  }
}

const paperMutationTails: LockTails = new Map()
const projectMutationTails: LockTails = new Map()

/**
 * Serialize paper read-modify-write commits within this host process.
 * @param arxivId - the paper the section mutates.
 * @param mutation - the critical section.
 * @returns the section's result.
 */
export async function withPaperMutationLock<T>(arxivId: string, mutation: () => Promise<T>): Promise<T> {
  return withKeyedLock(paperMutationTails, arxivId, mutation)
}

/**
 * Serialize project-scoped writes within this host process: the delete/rename
 * verbs hold the lock for their whole run, so a `wiki_note` write aimed at a
 * project being deleted lands either before the cascade (and is cleaned by
 * it) or after it (and fails the project existence check) — never inside it.
 * @param projectId - the project the section mutates.
 * @param mutation - the critical section.
 * @returns the section's result.
 */
export async function withProjectMutationLock<T>(projectId: string, mutation: () => Promise<T>): Promise<T> {
  return withKeyedLock(projectMutationTails, projectId, mutation)
}
