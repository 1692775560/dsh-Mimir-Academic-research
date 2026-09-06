# Mimir Code Style

English | [中文](CODE_STYLE.zh.md)

The rules every PR shares. They are extracted from the existing codebase —
when in doubt, copy the file you are touching. Process (branches, CI,
screenshot QA) lives in [CONTRIBUTING.md](CONTRIBUTING.md); this file is
about the code itself.

## 1. Principles

- **Pure logic is separated from shells.** Parsing, math, mapping, and
  layout calculations live in pure, DOM-free, side-effect-free modules
  (`venue-deadlines.ts`, `live-refresh.ts`, `paper-layout.ts`). I/O, timers,
  and ctx wiring live in thin service/controller shells. If it can't be
  unit-tested without mocks, it's in the wrong layer.
- **Fail open for reads, fail loud for writes.** A corrupt cache or a bad
  record degrades to "no data" — the panel still opens. A write that can't
  be validated is rejected before it touches disk.
- **Match the file you're in.** No drive-by reformatting, no personal
  idioms imported from other projects.

## 2. TypeScript

- Every module starts with a JSDoc block explaining **what and why**, ending
  with `@module <package>/src/<path>`.
- Every exported symbol has JSDoc. Document intent and invariants, not the
  obvious. Fields of interfaces are documented individually.
- Immutability by default: `readonly` fields, `readonly T[]` arrays,
  `Object.freeze` for shared constants. No `let` when a fold works.
- No `any`. If a boundary is untyped (remote stubs, JSON.parse), narrow with
  a schema or an explicit `unknown` + checks.
- Interfaces over classes for data; factories (`createX`) returning
  readonly-method interfaces over public class fields.

## 3. Errors & validation

- Validate at the boundary (zod schema, `isValidArxivId`-style predicates),
  then trust the type inside.
- **Schema changes are additive-only.** The wiki domain stays at version 2:
  new fields must be optional or carry `.default(...)`; new tables open
  empty on old snapshots. Never reject an existing record shape at load
  time — a hard `.refine` on stored data is a startup crash for users with
  legacy rows. Clean on load, strictly validate on write.
- Remote errors use typed codes (`invalid-input`, `project-not-found`, …),
  never raw exception text. No secrets, tokens, or absolute paths in error
  messages.

## 4. Async & concurrency

- Every async load path follows the **generation + pending pattern**: a
  per-slice generation counter bumped on `select()`, stale responses dropped
  on arrival, in-flight coalescing with a pending replay. See
  `venuesGeneration` in `controller.ts` for the reference implementation.
- Awaited code must re-check that the world is still the one it started in
  (project still selected, component not disposed) before publishing.
- Every timer, listener, EventSource, and interval has a matching cleanup in
  `dispose()` / effect teardown. Unref host-side timers.
- Read-modify-write on files goes through the file lock / single-flight
  helpers; two paths writing the same file must both hold it.

## 5. Security red lines

- Any user- or model-controlled string that reaches a filesystem path is
  whitelisted first (charset + no `..` + not absolute). Same for shell
  arguments — `execFile`, never string concat, and `--` before user data.
- All CSS colors go through `var(--token, fallback)` so dark mode follows
  the host theme. A bare `var(--x)` without fallback has burned us before.
- Never log or transmit API keys; redact in errors.

## 6. UI (ui-mimir)

- The controller stays **locale-free**: toasts and views receive locale
  keys, not strings. Adding a string = adding both `zh` and `en` entries;
  `locales.spec.ts` enforces parity.
- Interactive elements need `aria-label`; buttons share the `.btn` /
  `.btnPrimary` base classes — don't invent one-off button styles.
- Keep click targets ≥ 28px; compact, not tiny.
- Persisted UI state (localStorage, `mimir.*` keys) is read through a codec
  with try/catch and clamping; dirty or legacy data must never crash the
  first render.
- UI changes ship with screenshots. "Looks fine" means you looked.

## 7. Tests

- New behavior ships with vitest cases in the same PR. Pure logic gets unit
  tests; controller contracts get stubbed-remote tests.
- Parsers must round-trip on real-world fixtures (keep a sample in
  `tests/fixtures/`).
- A bug fix includes a regression test that fails without the fix.
- `pnpm run build && pnpm run typecheck && pnpm test` stays green. No
  `it.skip`, no `.only`, no commented-out tests.

## 8. Commits & PRs

- English, imperative mood, one-line summary; short body when the change
  needs context. `git log` is the style guide.
- PRs land as **merge commits** (not squash) — authorship must survive into
  the contributors graph.
- A PR answers three questions in its description: what breaks without it,
  how it's tested, screenshots if UI.
- Docs move with code: `README.md` + `README.zh.md` stay section-aligned;
  `ROADMAP.md` / `ROADMAP.zh.md` when the plan changes.
