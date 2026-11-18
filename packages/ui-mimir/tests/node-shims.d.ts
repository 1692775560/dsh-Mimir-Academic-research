/**
 * Minimal ambient declarations for the two node builtins the source-reading
 * specs use (folded-head-actions, unmount-timer-cleanup).
 *
 * `tsconfig.test.json` keeps `types: []` on purpose — pulling in the full node
 * typings makes the client views' `setTimeout` handles collide with
 * `NodeJS.Timeout` (see tsconfig.test.md). Declaring just these two modules
 * gives the specs their types without touching the global scope, so the
 * deliberate `types: []` stays intact.
 */
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string
}
