/**
 * `/research-review <scope and paths>`: one independent review round through a
 * fresh reviewer subagent. Relative paths resolve against the research
 * workspace root; a token naming a known project id attaches the round to
 * that project's reviewRounds counter.
 * @module dsh-mimir/src/commands/review
 */

import { isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { emitEvent, REVIEWER_ACTOR } from '../ledger.ts'
import { renderReviewRound, runReview } from '../reviewer.ts'
import { resolveProject } from './common.ts'
import type { ResearchCommandDeps } from './common.ts'

const USAGE = 'Usage: /research-review <what is under review> <file paths...> [project id]'

/** True when a token names an existing project id. */
function isProjectId(deps: ResearchCommandDeps, token: string): boolean {
  return deps.domain.table('projects').get(token) !== undefined
}

/** Resolve one user-supplied path against the workspace root. */
function resolvePath(deps: ResearchCommandDeps, token: string): string {
  return isAbsolute(token) ? token : resolve(deps.workspaceDir, token)
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

      const tokens = input.split(/\s+/)
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
      return { kind: 'success', text: `${renderReviewRound(round)}\n${counted}${followup}${retried}` }
    },
  })
}
