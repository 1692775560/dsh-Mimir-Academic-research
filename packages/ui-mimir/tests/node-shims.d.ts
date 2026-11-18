/**
 * The two Node builtins the spec tree uses, declared by hand.
 *
 * The shared spec tsconfig sets `types: []` on purpose: with `@types/node` in
 * scope, `setTimeout` resolves to `NodeJS.Timeout` while the client views store
 * it as `number`, and half the panel stops compiling. Loading the real Node
 * types just for two specs would put them back, so the specs that read files
 * get exactly the two functions they call and nothing else.
 * @module dsh-client-ui-mimir/tests/node-shims
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
}

declare module 'node:url' {
  export function fileURLToPath(url: URL): string
}
