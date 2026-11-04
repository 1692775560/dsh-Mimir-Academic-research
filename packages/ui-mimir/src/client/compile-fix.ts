/**
 * The "fix with AI" prompt builder: turns one compile issue plus the source
 * window around its line into one self-contained user message for the current
 * session's agent. Pure string assembly — the send itself lives in the
 * plugin apply (sessions binding), the button in the paper view.
 * @module dsh-client-ui-mimir/client/compile-fix
 */

import type { LatexIssue } from 'dsh-mimir'

/** Draft lines quoted above and below the issue's line. */
export const FIX_CONTEXT_RADIUS = 3

/** Fallback paper directory, mirroring the host's DEFAULT_PAPER_DIR. */
const DEFAULT_PAPER_DIR = 'paper'

/** Everything the prompt needs that the issue row alone does not carry. */
export interface CompileFixRequest {
  /** The compile issue being handed to the agent. */
  readonly issue: LatexIssue
  /** The current entry-file draft (unsaved edits included), when loaded. */
  readonly source: string | null
  /** The project's paper directory relative to the workspace root, when overridden. */
  readonly dir: string | undefined
  /** The project's entry .tex basename; defaults to `main.tex` (legacy projects — #249). */
  readonly entryFile?: string | undefined
}

/** The issue's file resolved against the paper directory for display. */
function issuePath(issue: LatexIssue, dir: string, entryFile: string): string {
  if (issue.file === undefined) return `${dir}/${entryFile}`
  const bare = issue.file.replace(/^\.\//, '')
  return bare.includes('/') ? bare : `${dir}/${bare}`
}

/** Whether the loaded draft is the file the issue points at. */
function isEntrySource(issue: LatexIssue, entryFile: string): boolean {
  if (issue.file === undefined) return true
  const bare = issue.file.replace(/^\.\//, '')
  return bare === entryFile || bare.endsWith(`/${entryFile}`)
}

/**
 * Assemble the user message sent to the current session's agent for one
 * "fix with AI" click. English regardless of the UI locale: the reader is
 * the agent, not the user. The message names the issue verbatim, quotes the
 * draft window around its line when the draft is the issue's file, and asks
 * for the edit plus a `latex_compile` re-run loop.
 * @param request - the issue, the current draft, and the paper directory.
 * @returns the prompt text, ready to send verbatim.
 */
export function buildCompileFixPrompt(request: CompileFixRequest): string {
  const { issue, source } = request
  const dir = request.dir ?? DEFAULT_PAPER_DIR
  const entryFile = request.entryFile ?? 'main.tex'
  const where = issue.line === undefined ? issuePath(issue, dir, entryFile) : `${issuePath(issue, dir, entryFile)}:${issue.line}`
  const lines: string[] = [
    'The paper\'s LaTeX compile reported the issue below. Please fix it.',
    '',
    `Issue: [${issue.severity}] ${where} ${issue.message}`,
    `Paper directory: ${dir} (relative to the workspace root)`,
  ]
  if (issue.line !== undefined && source !== null && isEntrySource(issue, entryFile)) {
    const draft = source.split('\n')
    const from = Math.max(1, issue.line - FIX_CONTEXT_RADIUS)
    const to = Math.min(draft.length, issue.line + FIX_CONTEXT_RADIUS)
    lines.push(
      '',
      `Source context (${issuePath(issue, dir, entryFile)}, lines ${from}-${to}; the issue is at line ${issue.line}):`,
      '```latex',
    )
    for (let line = from; line <= to; line += 1) lines.push(`${line} | ${draft[line - 1] ?? ''}`)
    lines.push('```')
  }
  lines.push(
    '',
    `Edit the file(s) to resolve this issue, then re-run the latex_compile tool with project_dir "${dir}" and keep fixing until it reports success. Do not change unrelated content.`,
  )
  return lines.join('\n')
}
