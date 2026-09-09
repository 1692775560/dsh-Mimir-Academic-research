/**
 * Behavior tests for the independent-review round (#246): verdict validation,
 * the reviewRounds counter, the one-fresh-retry policy for crashed or
 * timed-out reviewer children, the failed-round outcome, and caller
 * cancellation passing straight through. The subagent seam is stubbed (no
 * real child provider exists in this repo); the wiki domain is real and
 * memory-backed.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import type { ResearchWikiDomain } from '../src/store.ts'
import { createProject } from '../src/commands/common.ts'
import { runReview } from '../src/reviewer.ts'
import type { ReviewerOptions } from '../src/reviewer.ts'

/** Boot one open research-wiki domain over a throwaway memory medium. */
async function domainHarness(): Promise<ResearchWikiDomain> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  return facility.open(researchWikiDomainSpec)
}

/** One queued reviewer behavior: a settled result, or a per-signal responder. */
type StartBehavior = SubagentResult | ((signal: AbortSignal) => Promise<SubagentResult>)

/** A stubbed ctx.subagents whose starts play back the queued behaviors. */
function fakeSubagents(behaviors: StartBehavior[]): {
  runtime: SubagentRuntime
  starts: { signal: AbortSignal }[]
} {
  const starts: { signal: AbortSignal }[] = []
  const provider = {
    name: 'spawn',
    capabilities: { outputSchema: true, persona: true },
    inheritsParentContext: false,
  }
  const runtime = {
    getProvider: (name: string) => (name === 'spawn' ? provider : undefined),
    start: (_name: string, request: { signal: AbortSignal }) => {
      starts.push({ signal: request.signal })
      const behavior = behaviors[starts.length - 1]
      if (behavior === undefined) throw new Error('unexpected extra reviewer start')
      const result = typeof behavior === 'function' ? behavior(request.signal) : Promise.resolve(behavior)
      return Promise.resolve({
        id: `run-${starts.length}`,
        localAgent: undefined,
        result,
        dispose: () => Promise.resolve(),
      } as unknown as SubagentRun)
    },
  }
  return { runtime: runtime as unknown as SubagentRuntime, starts }
}

const PASS: SubagentResult = {
  output: [],
  stopReason: 'completed',
  structured: { verdict: 'PASS', issues: [], summary: 'survives hostile scrutiny' },
}

const WARN: SubagentResult = {
  output: [],
  stopReason: 'completed',
  structured: {
    verdict: 'WARN',
    issues: [{ severity: 'major', location: 'PLAN.md:10', problem: 'no baseline', suggestion: 'add one' }],
    summary: 'fixable gaps',
  },
}

const CRASHED: SubagentResult = { output: [], stopReason: 'error', diagnostic: 'transport reset' }

/** A child that only settles once its start signal aborts (a timeout). */
const untilAbort = (signal: AbortSignal): Promise<SubagentResult> => new Promise((resolve) => {
  const settled: SubagentResult = { output: [], stopReason: 'aborted', diagnostic: 'cancelled' }
  if (signal.aborted) {
    resolve(settled)
    return
  }
  signal.addEventListener('abort', () => resolve(settled), { once: true })
})

describe('runReview (#246)', () => {
  async function harness(behaviors: StartBehavior[], timeoutMs = 60_000) {
    const domain = await domainHarness()
    const { runtime, starts } = fakeSubagents(behaviors)
    const ctx = { subagents: runtime } as unknown as Context
    const followups: UserMessage[] = []
    const parent = { followup: (message: UserMessage): void => { followups.push(message) } } as unknown as Agent
    const reviewer: ReviewerOptions = { provider: 'spawn', maxRounds: 3, timeoutMs }
    const signal = new AbortController().signal
    return { ctx, domain, parent, followups, starts, reviewer, signal }
  }

  it('settles a completed verdict, counts the round, and hands WARN back for revision', async () => {
    const { ctx, domain, parent, followups, starts, reviewer, signal } = await harness([WARN])
    const project = await createProject(domain, 'paper', [])
    const outcome = await runReview(ctx, domain, reviewer, {
      parent, paths: ['/tmp/PLAN.md'], scope: 'EXPERIMENT_PLAN.md', projectId: project.id, signal,
    })
    expect(outcome).toMatchObject({ status: 'completed', retried: false })
    if (outcome.status !== 'completed') throw new Error('unreachable')
    expect(outcome.round.verdict).toBe('WARN')
    expect(starts).toHaveLength(1)
    expect(domain.table('projects').get(project.id)?.reviewRounds).toBe(1)
    expect(followups).toHaveLength(1)
  })

  it('retries once with a fresh reviewer after an abnormal stop', async () => {
    const { ctx, domain, parent, starts, reviewer, signal } = await harness([CRASHED, PASS])
    const outcome = await runReview(ctx, domain, reviewer, {
      parent, paths: ['/tmp/PLAN.md'], scope: 'plan', signal,
    })
    expect(outcome).toMatchObject({ status: 'completed', retried: true })
    expect(starts).toHaveLength(2)
  })

  it('retries a completed child whose structured verdict is malformed', async () => {
    const malformed: SubagentResult = { output: [], stopReason: 'completed', structured: { verdict: 'MEH' } }
    const { ctx, domain, parent, starts, reviewer, signal } = await harness([malformed, PASS])
    const outcome = await runReview(ctx, domain, reviewer, {
      parent, paths: ['/tmp/PLAN.md'], scope: 'plan', signal,
    })
    expect(outcome).toMatchObject({ status: 'completed', retried: true })
    expect(starts).toHaveLength(2)
  })

  it('settles a failed round after both attempts crash, without consuming budget', async () => {
    const { ctx, domain, parent, followups, starts, reviewer, signal } = await harness([CRASHED, CRASHED])
    const project = await createProject(domain, 'paper', [])
    const outcome = await runReview(ctx, domain, reviewer, {
      parent, paths: ['/tmp/PLAN.md'], scope: 'plan', projectId: project.id, signal,
    })
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') throw new Error('unreachable')
    expect(outcome.attempts).toBe(2)
    expect(outcome.reason).toContain('ended abnormally (error)')
    expect(outcome.reason).toContain('transport reset')
    expect(starts).toHaveLength(2)
    expect(domain.table('projects').get(project.id)?.reviewRounds).toBe(0)
    expect(followups).toHaveLength(0)
  })

  it('caller cancellation rejects immediately and never retries', async () => {
    const controller = new AbortController()
    const { ctx, domain, parent, starts, reviewer } = await harness([(signal) => {
      void signal
      controller.abort()
      return Promise.resolve<SubagentResult>({ output: [], stopReason: 'aborted', diagnostic: 'cancelled' })
    }])
    await expect(runReview(ctx, domain, reviewer, {
      parent, paths: ['/tmp/PLAN.md'], scope: 'plan', signal: controller.signal,
    })).rejects.toThrow('ended abnormally (aborted)')
    expect(starts).toHaveLength(1)
  })

  it('a per-attempt timeout triggers the fresh retry', async () => {
    const { ctx, domain, parent, starts, reviewer, signal } = await harness([untilAbort, PASS], 30)
    const outcome = await runReview(ctx, domain, reviewer, {
      parent, paths: ['/tmp/PLAN.md'], scope: 'plan', signal,
    })
    expect(outcome).toMatchObject({ status: 'completed', retried: true })
    expect(starts).toHaveLength(2)
  })

  it('a round timing out twice settles failed with the timeout as reason', async () => {
    const { ctx, domain, parent, reviewer, signal } = await harness([untilAbort, untilAbort], 30)
    const outcome = await runReview(ctx, domain, reviewer, {
      parent, paths: ['/tmp/PLAN.md'], scope: 'plan', signal,
    })
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed') throw new Error('unreachable')
    expect(outcome.reason).toContain('timed out after 30ms')
    expect(outcome.attempts).toBe(2)
  })

  it('an unknown project rejects before any reviewer starts', async () => {
    const { ctx, domain, parent, starts, reviewer, signal } = await harness([PASS])
    await expect(runReview(ctx, domain, reviewer, {
      parent, paths: ['/tmp/PLAN.md'], scope: 'plan', projectId: 'nope', signal,
    })).rejects.toThrow("unknown project 'nope'")
    expect(starts).toHaveLength(0)
  })
})
