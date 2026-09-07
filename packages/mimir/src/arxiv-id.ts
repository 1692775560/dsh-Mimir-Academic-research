/**
 * The shared arXiv-id safety predicate. An arXiv id keys the wiki's papers
 * table AND joins filesystem paths (the cached PDF under `papers/`, figure
 * crops under `meetings/.paper-figures/`), so every write and every path
 * join must reject ids that could escape the directory: the fetch charset
 * whitelist (letters, digits, dots, dashes, slashes) MINUS `..` anywhere,
 * leading slashes (absolute paths), and — via the charset — backslashes and
 * drive letters. A leaf module so `store.ts` (schema), the services, and the
 * tools can all share it without an import cycle.
 * @module dsh-mimir/src/arxiv-id
 */

/**
 * Whether one string is safe to use as an arXiv id in filesystem paths. The
 * network fetch (`fetchArxivPdf`) tolerates `..` (it only builds an
 * arxiv.org URL); every filesystem join and every wiki write must not.
 */
export function isValidArxivId(arxivId: string): boolean {
  return /^[a-zA-Z0-9._/-]+$/.test(arxivId)
    && !arxivId.includes('..')
    && !arxivId.startsWith('/')
}
