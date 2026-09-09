/**
 * Behavior tests for the research slash commands' argument resolution: a
 * natural-language argument (the way users actually type, e.g.
 * `/research-plan 请你帮我做实验计划`) must not fail the command — it targets
 * the most recently updated project and rides into the model instruction as
 * guidance. Real memory-backed domain, real temp workspace, no mocks.
 */

import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import type { ResearchWikiDomain } from '../src/store.ts'
import { createProject } from '../src/commands/common.ts'
import type { ResearchCommandDeps } from '../src/commands/common.ts'
import { registerPlanCommand } from '../src/commands/plan.ts'
import { registerPaperCommands } from '../src/commands/paper.ts'

/** Boot the command registry over a memory-backed domain and a fresh temp workspace. */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-commands-'))
  const deps: ResearchCommandDeps = {
    workspaceDir,
    domain,
    reviewer: { provider: 'spawn', maxRounds: 3, timeoutMs: 1000 },
    latex: { engine: 'auto', timeoutMs: 1000 },
  }
  return { ctx, domain, workspaceDir, deps }
}

/** A command-receiving agent on a real session, capturing follow-up instructions. */
function fakeAgent(ctx: Context, name: string): { agent: Agent; followups: UserMessage[] } {
  const session = ctx.sessions.create(SessionId(name))
  const followups: UserMessage[] = []
  const agent = {
    id: session.id,
    session,
    followup: (message: UserMessage): void => { followups.push(message) },
  } as unknown as Agent
  return { agent, followups }
}

/** Extract the text of one captured follow-up instruction. */
function followupText(message: UserMessage): string {
  const block = message.content[0]
  if (block === undefined || block.type !== 'text') throw new Error('expected a text follow-up')
  return block.text
}

/** Register a fresh project with one of two controlled update orderings. */
async function seedProject(domain: ResearchWikiDomain, title: string, updatedAt: string) {
  const project = await createProject(domain, title, ['IDEA_REPORT.md'])
  await domain.table('projects').update(project.id, current => ({ ...current, updatedAt }))
  return project
}

describe('/research-plan argument resolution', () => {
  it('targets the latest project and threads natural-language input into the instruction', async () => {
    const { ctx, domain, deps } = await harness()
    registerPlanCommand(ctx, deps)
    const older = await seedProject(domain, 'older', '2026-08-20T00:00:00.000Z')
    const latest = await seedProject(domain, 'latest', '2026-08-21T00:00:00.000Z')
    const { agent, followups } = fakeAgent(ctx, 'plan-guidance')

    const execution = await ctx.commands.execute(agent, '/research-plan 请你帮我做实验计划', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    expect(execution?.result.text).toContain(latest.id)
    expect(execution?.result.text).not.toContain(older.id)
    expect(execution?.result.text).toContain('请你帮我做实验计划')
    expect(followups).toHaveLength(1)
    expect(followupText(followups[0]!)).toContain('The user adds this direction for the plan: 请你帮我做实验计划')
    expect((await domain.table('projects').get(latest.id))?.stage).toBe('plan')
  })

  it('selects the exact project id with no guidance', async () => {
    const { ctx, domain, deps } = await harness()
    registerPlanCommand(ctx, deps)
    const older = await seedProject(domain, 'older', '2026-08-20T00:00:00.000Z')
    await seedProject(domain, 'latest', '2026-08-21T00:00:00.000Z')
    const { agent, followups } = fakeAgent(ctx, 'plan-exact')

    const execution = await ctx.commands.execute(agent, `/research-plan ${older.id}`, [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    expect(execution?.result.text).toContain(older.id)
    expect(execution?.result.text).not.toContain('Direction:')
    expect(followupText(followups[0]!)).not.toContain('The user adds this direction')
  })

  it('still fails loud when no project exists at all', async () => {
    const { ctx, deps } = await harness()
    registerPlanCommand(ctx, deps)
    const { agent, followups } = fakeAgent(ctx, 'plan-empty')

    const execution = await ctx.commands.execute(agent, '/research-plan anything', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('error')
    expect(execution?.result.text).toContain('/research-idea')
    expect(followups).toHaveLength(0)
  })
})

describe('/paper-write argument resolution', () => {
  it('targets the latest project, scaffolds the skeleton, and threads guidance', async () => {
    const { ctx, domain, workspaceDir, deps } = await harness()
    registerPaperCommands(ctx, deps)
    const project = await seedProject(domain, 'only project', '2026-08-21T00:00:00.000Z')
    const { agent, followups } = fakeAgent(ctx, 'paper-guidance')

    const execution = await ctx.commands.execute(agent, '/paper-write 重点写实验部分', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    expect(execution?.result.text).toContain(project.id)
    expect(followupText(followups[0]!)).toContain('The user adds this direction for the draft: 重点写实验部分')
    await stat(join(workspaceDir, 'paper', 'main.tex'))
    expect((await domain.table('projects').get(project.id))?.stage).toBe('writing')
  })
})
