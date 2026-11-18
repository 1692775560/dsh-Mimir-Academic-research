/**
 * Mimir's automated lint gate (#239).
 *
 * `scripts/check-style.mjs` covers the rules that can be decided one line at a
 * time from raw text. It cannot decide type-aware questions — above all
 * "is this promise awaited?", which needs the checker to know that `.run()`
 * returns a promise and `console.error()` does not. That is what this config
 * adds, and it is deliberately the narrowest version of it.
 *
 * Three rules, chosen because each one has already been violated in this repo:
 *
 *   @typescript-eslint/no-floating-promises
 *       A promise nobody awaits is a failure nobody sees. `startScheduledLoop`
 *       in `task-health.ts` chains `.catch(...)` precisely because an unhandled
 *       rejection there would kill the backup loop silently.
 *   @typescript-eslint/await-thenable
 *       `await` on a non-promise hides a missing call: the surrounding code
 *       reads as if something asynchronous happened, so a dropped `()` on a
 *       factory call passes review.
 *   @typescript-eslint/no-misused-promises
 *       An async function handed to a callback slot that ignores the returned
 *       promise (an event handler, a timer, a `forEach`) is the floating
 *       promise again, one frame deeper.
 *
 * Everything else — formatting, import order, naming — stays out. The repo has
 * its own answers for those in CODE_STYLE.md, and a lint rule that disagrees
 * with the code around it only produces noise.
 *
 * The three existing `react-hooks/exhaustive-deps` suppressions in the client
 * keep working because the plugin is registered for its rule id only — the rule
 * itself stays off. Turning it on is a separate question about the effect
 * dependency lists, not about promises.
 *
 * Historical debt is not waived wholesale. A site that needs an exemption
 * carries an inline `eslint-disable-next-line` with a reason, exactly like
 * `style-gate: allow` in check-style.mjs: a suppression is a claim a reviewer
 * can check, and it is visible in the diff that introduced it.
 *
 * @module dsh-Mimir-Academic-research/eslint.config
 */

import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Build output carries the compiled copies of both source trees; linting it
    // would report every finding twice and would also choke on the inlined
    // `eslint-disable` comments whose rules are not installed here.
    ignores: ['**/lib/**', '**/dist/**', '**/node_modules/**', 'packages/*/lib/**'],
  },
  {
    // Only the source trees. Tests reach into fakes and stubs where an
    // unawaited promise is often the point, and `scripts/` is plain Node with
    // no project in either tsconfig.
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // The two packages have different compiler shapes (node vs browser),
        // and `allowDefaultProject` is what lets one run cover both without
        // asking each file which project it belongs to by hand.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      // Registered, not enabled: three client effects carry an
      // `eslint-disable-next-line react-hooks/exhaustive-deps` with a reason,
      // and an unknown rule id turns those into errors.
      'react-hooks': reactHooks,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', {
        // `void promise` is this repo's documented way of saying "deliberately
        // fire-and-forget" (CODE_STYLE §4 code uses it throughout
        // controller.ts), so it must not be an error here.
        ignoreVoid: true,
        // `.catch(...)` / `.finally(...)` chains are the other accepted shape;
        // `task-health.ts` depends on it.
        ignoreIIFE: false,
      }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: false,
      }],
    },
  },
)
