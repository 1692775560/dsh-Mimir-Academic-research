/**
 * `/research-review <scope and paths>`: one independent review round through a
 * fresh reviewer subagent. Relative paths resolve against the research
 * workspace root; a token naming a known project id attaches the round to
 * that project's reviewRounds counter. Review targets are confined to the
 * workspace (symlinks resolved) unless the caller passes `--allow-external`,
 * in which case the result echoes the full path list and file count (#212).
 * @module dsh-mimir/src/commands/review
 */

import { isAbsolute, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { emitEvent, REVIEWER_ACTOR } from '../ledger.ts'
import { renderReviewRound, runReview } from '../reviewer.ts'
import { resolveProject } from './common.ts'
import type { ResearchCommandDeps } from './common.ts'

const USAGE = 'Usage: /research-review <what is under review> <file paths...> [project id] [--allow-external]'

/**
 * Opt-in flag lifting the workspace confinement: the reviewer child may then
 * read out-of-workspace files, and the command echoes the full path list and
 * file count with the result (#212).
 */
export const ALLOW_EXTERNAL_FLAG = '--allow-external'

/** True when a token names an existing project id. */
function isProjectId(deps: ResearchCommandDeps, token: string): boolean {
  return deps.domain.table('projects').get(token) !== undefined
}

/** Resolve one user-supplied path against the workspace root. */
function resolvePath(deps: ResearchCommandDeps, token: string): string {
  return isAbsolute(token) ? token : resolve(deps.workspaceDir, token)
}

/**
 * The paths whose realpath sits OUTSIDE the workspace's realpath (#212). The
 * reviewer child reads everything it is handed, so by default each target —
 * symlinks resolved — must stay inside the workspace; an unreadable path
 * counts as outside (defense in depth alongside the stat check).
 * @param workspaceDir - absolute research workspace root.
 * @param paths - the resolved absolute review targets.
 * @returns the violating paths, empty when all are confined.
 */
export async function reviewPathsOutsideWorkspace(
  workspaceDir: string,
  paths: readonly string[],
): Promise<string[]> {
  const rootReal = await realpath(resolve(workspaceDir))
  const outside: string[] = []
  for (const path of paths) {
    const real = await realpath(path).catch(() => undefined)
    if (real === undefined || (real !== rootReal && !real.startsWith(rootReal + sep))) outside.push(path)
  }
  return outside
}

/**
 * Register the `/research-review` command.
 * @param ctx - Plugin context carrying the commands registry and subagents service.
 * @param deps - Shared command dependencies.
 */
export function registerReviewCommand(ctx: Context, deps: ResearchCommandDeps): void {
  ctx.commands.register({
    name: 'research-review',
    description: 'run one independent reviewer pass over artifact files; WARN/FAIL verdicts are handed back for revision',
    input: { hint: '<scope> <file paths...> [project id]' },
    async handler(invocation): Promise<CommandResult> {
      const input = invocation.rawInput.trim()
      if (input.length === 0) return { kind: 'error', text: `A review scope and at least one file are required.\n${USAGE}` }

      const tokens = input.split(/\s+/).filter(token => token !== ALLOW_EXTERNAL_FLAG)
      const allowExternal = tokens.length !== input.split(/\s+/).length
      const projectToken = tokens.find(token => isProjectId(deps, token))
      const pathTokens = tokens.filter(token => token !== projectToken && (token.includes('/') || /\.[a-z0-9]+$/i.test(token)))
      const scopeWords = tokens.filter(token => token !== projectToken && !pathTokens.includes(token))
      if (pathTokens.length === 0) return { kind: 'error', text: `No file path given; the reviewer reads files, not summaries.\n${USAGE}` }

      const paths = pathTokens.map(token => resolvePath(deps, token))
      const missing: string[] = []
      for (const path of paths) {
        const stats = await stat(path).catch(() => undefined)
        if (stats === undefined) missing.push(path)
      }
      if (missing.length > 0) {
        return { kind: 'error', text: `Review target(s) do not exist:\n${missing.map(path => `- ${path}`).join('\n')}` }
      }

      // Confinement (#212): the reviewer child reads every path it is
      // handed, so targets must stay inside the workspace unless the caller
      // explicitly opted out with --allow-external.
      if (!allowExternal) {
        const outside = await reviewPathsOutsideWorkspace(deps.workspaceDir, paths)
        if (outside.length > 0) {
          return {
            kind: 'error',
            text: `Review paths must stay inside the research workspace; these do not:\n${outside.map(path => `- ${path}`).join('\n')}\nPass ${ALLOW_EXTERNAL_FLAG} to review out-of-workspace files explicitly.`,
          }
        }
      }

      const project = resolveProject(deps.domain, projectToken)
      if (project !== undefined && project.reviewRounds >= deps.reviewer.maxRounds) {
        return {
          kind: 'error',
          text: `Project ${project.id} already used its ${deps.reviewer.maxRounds} review rounds. Inspect the artifact manually or raise reviewer.maxRounds in the plugin config.`,
        }
      }

      const scope = scopeWords.length > 0 ? scopeWords.join(' ') : input
      const outcome = await runReview(ctx, deps.domain, deps.reviewer, {
        parent: invocation.agent,
        paths,
        scope,
        ...(project === undefined ? {} : { projectId: project.id }),
        signal: invocation.signal,
      })
      if (outcome.status === 'failed') {
        // The reviewer crashed (and the fresh retry crashed too): record the
        // failure so the claim-evidence trail sees it, and report without
        // touching the project's reviewRounds budget.
        await emitEvent(deps.domain, {
          actor: REVIEWER_ACTOR,
          action: 'review.round.failed',
          refs: project === undefined ? {} : { projectId: project.id },
          payload: { reason: outcome.reason, attempts: outcome.attempts, scope },
        })
        return {
          kind: 'error',
          text: `Independent review of ${scope} failed after ${outcome.attempts} attempts (${outcome.reason}). `
            + 'Earlier completed rounds are unaffected and no review-round budget was consumed; re-run /research-review to try again.',
        }
      }
      const round = outcome.round
      // The round's verdict joins the ledger as a subagent action — the
      // claim-evidence trail needs to see who graded what and how. Awaited
      // (best-effort inside): the verdict is durable before the command
      // reports back.
      await emitEvent(deps.domain, {
        actor: REVIEWER_ACTOR,
        action: 'review.round.settled',
        refs: project === undefined ? {} : { projectId: project.id },
        payload: { verdict: round.verdict, issues: round.issues.length, scope },
      })
      const counted = project === undefined ? '' : ` Round ${project.reviewRounds + 1}/${deps.reviewer.maxRounds} for project ${project.id}.`
      const followup = round.verdict === 'PASS' ? '' : ' A revision request was handed to the agent.'
      const retried = outcome.retried ? ' The first reviewer attempt failed; the round was retried with a fresh reviewer.' : ''
      // An external-scope review echoes exactly what the child read (#212).
      const external = allowExternal
        ? `External review (${ALLOW_EXTERNAL_FLAG}) of ${paths.length} file(s):\n${paths.map(path => `- ${path}`).join('\n')}\n`
        : ''
      return { kind: 'success', text: `${external}${renderReviewRound(round)}\n${counted}${followup}${retried}` }
    },
  })
}
