/**
 * The shared project-id safety predicate. A project id keys the wiki's
 * projects table AND joins filesystem paths (meeting decks under
 * `meetings/<projectId>/`), so every write and every path join must reject
 * ids that could escape the directory.
 *
 * Same shape and the same reasoning as {@link isValidArxivId}: a charset
 * whitelist MINUS `..` anywhere and leading slashes (absolute paths), with
 * backslashes and drive letters excluded by the charset so a Windows host
 * gets the same answer as a POSIX one.
 *
 * A leaf module so `store.ts` (schema), the services, and the import path can
 * share it without an import cycle.
 * @module dsh-mimir/src/project-id
 */

/**
 * Whether one string is safe to use as a project id in filesystem paths.
 *
 * `projectRecord.id` is an unconstrained `z.string()` in the durable schema,
 * deliberately: a legacy bad row must not abort the domain open. So the
 * checking happens where the value is used, not where it is stored, exactly
 * as it does for arXiv ids.
 */
export function isValidProjectId(projectId: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(projectId)
    && !projectId.includes('..')
    && !projectId.startsWith('/')
}
