/**
 * Independent-review orchestration. One round starts a FRESH reviewer subagent
 * that receives only absolute file paths and the review scope — never the
 * executor's summary or interpretation (reviewer independence) — and returns
 * a schema-validated verdict. WARN/FAIL verdicts are handed back to the
 * calling agent as a follow-up revision request.
 * @module dsh-mimir/src/reviewer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Declaration merge only: makes ctx.subagents visible for the reviewer start.
import type {} from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ResearchWikiDomain } from './store.ts'
import type { ReviewIssue, ReviewRound } from './types.ts'

/** Reviewer subagent deployment knobs (see the plugin `Config.reviewer`). */
export interface ReviewerOptions {
  /** Subagent provider route (default `spawn`); reserved for cross-model review. */
  readonly provider: string
  /** Maximum review rounds before /research-review stops looping (default 3). */
  readonly maxRounds: number
  /** Wall-clock budget per reviewer attempt in milliseconds (default 600_000). */
  readonly timeoutMs: number
}

/**
 * Outcome of one review round: a settled verdict, or a round that failed
 * after one fresh retry. A failed round reports its reason instead of
 * throwing, so a transient reviewer crash neither loses the command
 * invocation nor consumes the project's reviewRounds counter. Caller
 * cancellation still rejects — cancellation is not a failure state.
 */
export type ReviewOutcome =
  | { readonly status: 'completed'; readonly round: ReviewRound; readonly retried: boolean }
  | { readonly status: 'failed'; readonly reason: string; readonly attempts: number }

/** One review request. */
export interface ReviewRequest {
  /** The calling agent, used as the subagent parent and follow-up target. */
  readonly parent: Agent
  /** Absolute paths the reviewer must read in full. */
  readonly paths: string[]
  /** Human description of what is under review (e.g. `EXPERIMENT_PLAN.md`). */
  readonly scope: string
  /** Project whose reviewRounds counter this round increments, when known. */
  readonly projectId?: string
  /** Caller cancellation; forwarded to the subagent start request. */
  readonly signal: AbortSignal
}

/** Structured verdict the reviewer child is required to return. */
const VERDICT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'WARN', 'FAIL'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['major', 'minor'] },
          location: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['severity', 'location', 'problem', 'suggestion'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['verdict', 'issues', 'summary'],
  additionalProperties: false,
}

const REVIEWER_PERSONA = 'You are a strict, hostile conference reviewer. Your job is to find flaws: '
  + 'unsupported claims, missing baselines, overclaimed contributions, unclear writing, and any gap between '
  + 'what a document asserts and what it demonstrates. You never praise. You never trust the author\'s '
  + 'self-assessment; you read the listed files yourself and judge only what is on the page.'

/** Build the reviewer prompt: paths and scope only — independence by construction. */
function reviewerPrompt(request: ReviewRequest): string {
  return [
    `Review scope: ${request.scope}`,
    'Read each of the following files in full, then review the work described by the scope:',
    ...request.paths.map(path => `- ${path}`),
    'Verdict rules: PASS only when the work survives hostile scrutiny; WARN for issues that must be fixed '
    + 'but do not invalidate the work; FAIL for fundamental flaws (unsupported core claims, broken '
    + 'methodology, missing evaluation). Every issue needs an exact file location and a concrete fix.',
  ].join('\n\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Defensively decode the child's structured value across the provider boundary. */
function readReviewRound(value: unknown): ReviewRound {
  if (!isRecord(value)) throw new Error('reviewer returned no structured verdict')
  const verdict = value['verdict']
  if (verdict !== 'PASS' && verdict !== 'WARN' && verdict !== 'FAIL') {
    throw new Error(`reviewer returned an unknown verdict ${JSON.stringify(verdict)}`)
  }
  const rawIssues = value['issues']
  if (!Array.isArray(rawIssues)) throw new Error('reviewer verdict carries no issues array')
  const issues: ReviewIssue[] = rawIssues.map((raw) => {
    if (!isRecord(raw)
      || (raw['severity'] !== 'major' && raw['severity'] !== 'minor')
      || typeof raw['location'] !== 'string'
      || typeof raw['problem'] !== 'string'
      || typeof raw['suggestion'] !== 'string') {
      throw new Error('reviewer returned a malformed issue entry')
    }
    return { severity: raw['severity'], location: raw['location'], problem: raw['problem'], suggestion: raw['suggestion'] }
  })
  const summary = value['summary']
  if (typeof summary !== 'string') throw new Error('reviewer verdict carries no summary string')
  return { verdict, issues, summary }
}

/** Render one verdict for the revision follow-up and the command result. */
export function renderReviewRound(round: ReviewRound): string {
  const lines = [`Verdict: ${round.verdict}`, '', `Summary: ${round.summary}`]
  if (round.issues.length > 0) {
    lines.push('', 'Issues:')
    for (const issue of round.issues) {
      lines.push(`- [${issue.severity}] ${issue.location}: ${issue.problem}`, `  Suggestion: ${issue.suggestion}`)
    }
  }
  return lines.join('\n')
}

/**
 * Run one independent review round and record it.
 *
 * The reviewer provider must be registered, support structured output and
 * personas, and not inherit parent context; a provider failing any of these
 * rejects with a named reason. A child that ends abnormally, times out
 * (`options.timeoutMs` per attempt), or returns no structured verdict gets
 * ONE fresh retry with a new reviewer child; a round still failing after the
 * retry settles as a `failed` outcome rather than throwing, leaving earlier
 * rounds untouched. Caller cancellation rejects immediately and never
 * retries. WARN/FAIL verdicts are handed to the parent agent as a revision
 * follow-up.
 *
 * @param ctx - Plugin context carrying the `subagents` service.
 * @param domain - Open research-wiki domain for the reviewRounds counter.
 * @param options - Resolved reviewer config.
 * @param request - Parent agent, absolute paths, scope, and cancellation.
 * @returns the validated verdict of this round, or a failed-round outcome.
 */
export async function runReview(
  ctx: Context,
  domain: ResearchWikiDomain,
  options: ReviewerOptions,
  request: ReviewRequest,
): Promise<ReviewOutcome> {
  if (request.paths.length === 0) throw new Error('research review requires at least one file path')
  const provider = ctx.subagents.getProvider(options.provider)
  if (provider === undefined) {
    throw new Error(`research reviewer subagent provider '${options.provider}' is not registered`)
  }
  if (!provider.capabilities.outputSchema) {
    throw new Error(`research reviewer provider '${options.provider}' does not support structured output`)
  }
  if (!provider.capabilities.persona) {
    throw new Error(`research reviewer provider '${options.provider}' does not support personas`)
  }
  if (provider.inheritsParentContext) {
    throw new Error(`research reviewer provider '${options.provider}' inherits parent context; review requires a fresh reviewer`)
  }
  if (request.projectId !== undefined
    && domain.table('projects').get(request.projectId) === undefined) {
    throw new Error(`research review named unknown project '${request.projectId}'`)
  }

  /** One reviewer attempt: start a fresh child, await its verdict, always dispose. */
  const attemptOnce = async (signal: AbortSignal): Promise<ReviewRound> => {
    const run = await ctx.subagents.start(options.provider, {
      label: `research review: ${request.scope}`,
      prompt: [{ type: 'text', text: reviewerPrompt(request) }],
      parent: request.parent,
      signal,
      outputSchema: VERDICT_SCHEMA,
      persona: REVIEWER_PERSONA,
    })
    try {
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new Error(`research reviewer ended abnormally (${result.stopReason})${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}`)
      }
      return readReviewRound(result.structured)
    } finally {
      await run.dispose()
    }
  }

  let reason = 'unknown reviewer failure'
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    request.signal.throwIfAborted()
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const signal = AbortSignal.any([request.signal, timeout])
    try {
      const round = await attemptOnce(signal)

      if (request.projectId !== undefined) {
        await domain.table('projects').update(request.projectId, current => ({
          ...current,
          reviewRounds: current.reviewRounds + 1,
          updatedAt: new Date().toISOString(),
        }))
      }

      if (round.verdict !== 'PASS') {
        request.parent.followup(createUserMessage({
          content: [{
            type: 'text',
            text: [
              `Independent review of ${request.scope} returned ${round.verdict}.`,
              '',
              renderReviewRound(round),
              '',
              'Address every major issue (and minor ones where cheap), then run /research-review again.',
            ].join('\n'),
          }],
          source: { kind: 'user' },
        }))
      }
      return { status: 'completed', round, retried: attempt > 1 }
    } catch (error) {
      if (request.signal.aborted) throw error
      const what = timeout.aborted
        ? `research reviewer timed out after ${options.timeoutMs}ms`
        : 'research reviewer attempt failed'
      reason = `${what}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return { status: 'failed', reason, attempts: 2 }
}
