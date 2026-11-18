# Type-check the ui-mimir test tree (`tsc` gate)

## What this is

`packages/ui-mimir/tsconfig.json` includes `src` only, so `pnpm run typecheck`
never looks at `tests/**`. Vitest transpiles specs without checking them, which
means a fixture that drifted behind a widened view type stayed invisible until
some runtime assertion happened to trip on it.

`packages/ui-mimir/tsconfig.test.json` closes that hole: it compiles `src`, the
vendored protocol sources, and every spec together in `noEmit` mode. It is
wired into `pnpm run typecheck`, which CI already runs, so the gate is live on
both branches.

## The debt this surfaced (fixed here, not deferred)

The first clean run of the new config reported **28 errors that had never been
seen by a compiler**:

| Fixture | What drifted |
|---|---|
| `tests/server-tags.spec.ts` | typed `ServerRecord` where the helpers take `ServerView` (missing `hasPassword`) |
| `tests/evidence-canvas.spec.tsx`, `tests/evidence-graph-layout.spec.ts` | `actor: { kind: 'panel' }` — `panel` is not a `LedgerActorKind`; `Object.freeze` over a `Partial` spread also widened the literal to `{ kind: string }` |
| `tests/evidence-canvas.spec.tsx` | `EvidenceGraphCanvas` grew focus-mode props (`focusedBandKey` / `onFocusBand`) and the render calls were never updated |
| `tests/ledger-render.spec.tsx`, `controller.client.spec.ts` | `ResearchBriefView` / `ResearchGenerateBriefResult` grew `lines`, `transitions`, `openLoops`, `moments`; the fixtures still had the old shape |
| `controller.client.spec.ts` (evidence graph) | four `deferred<ResearchGetEvidenceGraphResult>` where the stub resolves `RemoteResult<…>` — the helper already returned a `RemoteResult`, so the deferred payload type was wrong |

## Verifying the gate actually gates

A gate that has never failed is decoration. Proof it fails on a real regression:

```sh
printf "\nconst probe: number = 'not a number'\n" >> packages/ui-mimir/tests/line-hue.spec.ts
pnpm run typecheck   # → tests/line-hue.spec.ts(44,7): error TS2322 ... exit 2
git checkout packages/ui-mimir/tests/line-hue.spec.ts
pnpm run typecheck   # → exit 0
```

## Why `noEmit` + repo-root `rootDir`

- `rootDir` has to be the repo root: the specs live outside `src` and the gate
  also pulls in `packages/typert-protocol/src` (the root `paths` map resolves
  `@deepseek-ai/dsh-typert-protocol` there, and without it alongside `ui-mimir`
  the compiler rejects it as "not under rootDir", TS6059).
- `composite: false` / `noEmit: true`: a project reference would demand
  declaration output for the test tree, which nothing consumes. This is a gate,
  not a build artifact.
- `types: []` (inherited from `tsconfig.base.client.json`) is deliberate. Adding
  `"node"` makes the three client views that type their timer handle as
  `ReturnType<typeof setTimeout>` collide with `NodeJS.Timeout`:
  `Type 'number' is not assignable to type 'Timeout'`.
