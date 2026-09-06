#!/usr/bin/env node
/**
 * Mimir style gate — the mechanically decidable slice of CODE_STYLE.md.
 *
 * Four rules, each with a precise file:line report naming the clause:
 *
 *   css-var-fallback  A CSS color must not reference a token the same file
 *                     does not define without a fallback: `var(--x)` with no
 *                     comma (CODE_STYLE §5 — a bare `var(--x)` has burned us
 *                     before; locally defined `--mimir-*` tokens are exempt
 *                     because the file itself guarantees them).
 *   no-focused-test   No `it.only` / `it.skip` / `test.only` / `test.skip` /
 *                     `describe.only` / `describe.skip` in tests
 *                     (CODE_STYLE §7).
 *   no-crlf           No CRLF line endings in the src/tests trees of each
 *                     package for .ts/.tsx/.css — whole-file EOL flips make
 *                     two-line fixes review as 200-line rewrites
 *                     (CODE_STYLE §8 diff hygiene).
 *   no-console-log    No `console.log` in each package's src tree;
 *
 * Suppression: a line carrying `style-gate: allow <rule-id>` is exempt from
 * that rule. Use sparingly — a suppression is a claim a reviewer will check.
 *
 * Exit 0 when clean, 1 with the full report otherwise. Wired into CI
 * (.github/workflows/ci.yml, build-test job) and runnable locally via
 * `pnpm run check-style`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages')

/** Recursively collect files under `dir` matching one of `exts`. */
function walk(dir, exts, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path, exts, out)
    else if (exts.some(ext => entry.endsWith(ext))) out.push(path)
  }
  return out
}

function* packageDirs() {
  for (const pkg of readdirSync(PACKAGES)) {
    const dir = join(PACKAGES, pkg)
    if (statSync(dir).isDirectory()) yield dir
  }
}

const findings = []
function report(rule, clause, path, line, message) {
  findings.push({ rule, clause, path: relative(ROOT, path), line, message })
}

/** Whether one line carries an inline suppression for `rule`. */
function allowed(text, rule) {
  return text.includes(`style-gate: allow ${rule}`)
}

/* a) css-var-fallback ------------------------------------------------------ */
for (const pkg of packageDirs()) {
  for (const file of walk(join(pkg, 'src'), ['.css'])) {
    const text = readFileSync(file, 'utf8')
    // Custom properties this file defines itself (`--x:` at a declaration
    // site) — referencing those bare is safe, the file guarantees them.
    const defined = new Set(
      [...text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map(match => match[1]),
    )
    text.split('\n').forEach((lineText, index) => {
      if (allowed(lineText, 'css-var-fallback')) return
      for (const match of lineText.matchAll(/var\((--[^),]*)\)/g)) {
        if (defined.has(match[1])) continue
        report(
          'css-var-fallback', '§5', file, index + 1,
          `bare var(${match[1]}) has no fallback and the token is not defined in this file — write var(${match[1]}, <fallback>)`,
        )
      }
    })
  }
}

/* b) no-focused-test ------------------------------------------------------- */
const FOCUSED = /^\s*(it|test|describe)\.(only|skip)\(/
for (const pkg of packageDirs()) {
  for (const file of walk(join(pkg, 'tests'), ['.ts', '.tsx'])) {
    readFileSync(file, 'utf8').split('\n').forEach((lineText, index) => {
      if (allowed(lineText, 'no-focused-test')) return
      const match = FOCUSED.exec(lineText)
      if (match !== null) {
        report(
          'no-focused-test', '§7', file, index + 1,
          `${match[1]}.${match[2]} must not reach CI — no skipped/focused tests`,
        )
      }
    })
  }
}

/* c+d) per-file source rules ----------------------------------------------- */
for (const pkg of packageDirs()) {
  for (const scope of ['src', 'tests']) {
    for (const file of walk(join(pkg, scope), ['.ts', '.tsx', '.css'])) {
      const text = readFileSync(file, 'utf8')
      // c) no-crlf: one finding per file is enough — it is a whole-file fault.
      if (text.includes('\r')) {
        report(
          'no-crlf', '§8', file, 0,
          'CRLF line endings — convert to LF so small fixes do not review as whole-file rewrites',
        )
      }
      if (scope !== 'src') continue
      // d) no-console-log
      text.split('\n').forEach((lineText, index) => {
        if (allowed(lineText, 'no-console-log')) return
        if (/console\.log\(/.test(lineText)) {
          report(
            'no-console-log', '§5', file, index + 1,
            'console.log in src/ — use console.warn/console.error for noteworthy events, or drop the line',
          )
        }
      })
    }
  }
}

if (findings.length > 0) {
  console.error(`style gate: ${findings.length} violation(s)`)
  for (const finding of findings) {
    const where = finding.line === 0 ? finding.path : `${finding.path}:${finding.line}`
    console.error(`  ${where}  [${finding.rule} / CODE_STYLE ${finding.clause}] ${finding.message}`)
  }
  process.exit(1)
}
console.log('style gate: clean')
