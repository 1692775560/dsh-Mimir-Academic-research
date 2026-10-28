/**
 * Behavior tests for the `wiki_note` tool's project/experiment write actions:
 * schema-guarded validation (unknown ids, bad status enums), the paperDir
 * pointer, and the experiment record lifecycle.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import type { ResearchWikiDomain } from '../src/store.ts'
import { createWikiNoteTool } from '../src/tools/wiki.ts'
import type { ProjectRecord } from '../src/types.ts'

/** Boot a context with the storage hub, one memory backend, and a domain facility over it. */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  return facility.open(researchWikiDomainSpec)
}

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Project',
  stage: 'experiment',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

/** The tool's execute needs a ToolRunContext it never reads in these paths. */
const NO_EXEC = {} as ToolRunContext

/** Execute one wiki_note action against one domain. */
async function run(domain: ResearchWikiDomain, args: Record<string, unknown>) {
  const tool = createWikiNoteTool(domain)
  return await tool.execute(args, NO_EXEC) as Record<string, unknown>
}

describe('wiki_note project/experiment actions', () => {
  it('set_project points a project at its paper directory', async () => {
    const domain = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const outcome = await run(domain, { action: 'set_project', id: 'p1', paper_dir: 'ego-wholebody-paper' })
    expect(outcome).toMatchObject({ ok: true, table: 'projects', id: 'p1' })
    expect(domain.table('projects').get('p1')?.paperDir).toBe('ego-wholebody-paper')
    await expect(run(domain, { action: 'set_project', id: 'missing', paper_dir: 'x' }))
      .rejects.toThrow("no project with id 'missing'")
  })

  it('set_project records the lifecycle stage the skills instruct (idea|plan|experiment|writing|done)', async () => {
    const domain = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)

    // Stage-only update: the skills' standing rule passes stage without a
    // paper_dir, which used to fail the paper_dir requirement.
    const outcome = await run(domain, { action: 'set_project', id: 'p1', stage: 'writing' })
    expect(outcome).toMatchObject({ ok: true, table: 'projects', id: 'p1', stage: 'writing' })
    expect(domain.table('projects').get('p1')?.stage).toBe('writing')
    // A stage-only update leaves the paper directory untouched (absent here).
    expect(domain.table('projects').get('p1')?.paperDir).toBeUndefined()

    // Both fields together.
    await run(domain, { action: 'set_project', id: 'p1', stage: 'done', paper_dir: 'paper' })
    expect(domain.table('projects').get('p1')).toMatchObject({ stage: 'done', paperDir: 'paper' })

    // An unknown stage is rejected at the schema boundary, an empty update
    // by the action itself.
    await expect(run(domain, { action: 'set_project', id: 'p1', stage: 'bogus' }))
      .rejects.toThrow('must be one of ["idea","plan","experiment","writing","done"]')
    await expect(run(domain, { action: 'set_project', id: 'p1' }))
      .rejects.toThrow("at least one of 'paper_dir' or 'stage'")
  })

  it('add_experiment requires an existing project and validates the status', async () => {
    const domain = await harness()
    await expect(run(domain, { action: 'add_experiment', project_id: 'p1', name: 'baseline' }))
      .rejects.toThrow("no project with id 'p1'")
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await expect(run(domain, { action: 'add_experiment', project_id: 'p1', name: 'baseline', status: 'bogus' }))
      .rejects.toThrow('running|success|failed')
    const outcome = await run(domain, {
      action: 'add_experiment',
      project_id: 'p1',
      name: 'baseline',
      metrics: { accuracy: 0.91, note: 'seed 42' },
      log_path: 'logs/baseline.log',
    }) as { ok: true; id: string }
    const stored = domain.table('experiments').get(outcome.id)
    expect(stored).toMatchObject({
      projectId: 'p1',
      name: 'baseline',
      status: 'running',
      metrics: { accuracy: 0.91, note: 'seed 42' },
      logPath: 'logs/baseline.log',
    })
  })

  it('set_experiment updates only the provided fields', async () => {
    const domain = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const added = await run(domain, { action: 'add_experiment', project_id: 'p1', name: 'baseline' }) as { id: string }
    await run(domain, { action: 'set_experiment', id: added.id, status: 'success', metrics: { accuracy: 0.93 } })
    expect(domain.table('experiments').get(added.id)).toMatchObject({
      name: 'baseline',
      status: 'success',
      metrics: { accuracy: 0.93 },
    })
    await expect(run(domain, { action: 'set_experiment', id: 'missing', status: 'failed' }))
      .rejects.toThrow("no experiment with id 'missing'")
  })
})


describe('wiki_note set_paper', () => {
  const PAPER = {
    arxivId: '2103.00020v2',
    title: 'EgoSync & Friends',
    authors: ['Doe, Jane'],
    summary: 'Abstract.',
    url: 'https://arxiv.org/abs/2103.00020v2',
    notes: 'keep me',
    tags: ['mesh'],
    projectIds: [],
    addedAt: '2026-08-20T00:00:00.000Z',
  }

  it('records a relevance score against a project and links the paper to it', async () => {
    const domain = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('papers').put(PAPER.arxivId, PAPER)
    const outcome = await run(domain, {
      action: 'set_paper',
      arxiv_id: PAPER.arxivId,
      project_id: 'p1',
      relevance_score: 8,
      relevance_reason: 'Directly addresses the project direction.',
    })
    expect(outcome).toMatchObject({ ok: true, table: 'papers', id: PAPER.arxivId })
    const stored = domain.table('papers').get(PAPER.arxivId)
    expect(stored?.relevance?.['p1']?.score).toBe(8)
    expect(stored?.relevance?.['p1']?.reason).toContain('Directly')
    expect(stored?.projectIds).toEqual(['p1'])
    // Untouched fields survive.
    expect(stored?.notes).toBe('keep me')
    expect(stored?.tags).toEqual(['mesh'])
  })

  it('updates tags and notes without a score, and validates its inputs', async () => {
    const domain = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('papers').put(PAPER.arxivId, PAPER)
    const outcome = await run(domain, {
      action: 'set_paper',
      arxiv_id: PAPER.arxivId,
      tags: ['mesh', 'video', 'mesh', ' '],
      notes: 'updated',
    })
    expect(outcome).toMatchObject({ ok: true })
    const stored = domain.table('papers').get(PAPER.arxivId)
    expect(stored?.tags).toEqual(['mesh', 'video'])
    expect(stored?.notes).toBe('updated')
    await expect(run(domain, { action: 'set_paper', arxiv_id: 'nope', notes: 'x' }))
      .rejects.toThrow("no paper with id 'nope'")
    await expect(run(domain, {
      action: 'set_paper', arxiv_id: PAPER.arxivId, project_id: 'p1', relevance_score: 12, relevance_reason: 'r',
    })).rejects.toThrow('between 0 and 10')
    await expect(run(domain, {
      action: 'set_paper', arxiv_id: PAPER.arxivId, project_id: 'nope', relevance_score: 5, relevance_reason: 'r',
    })).rejects.toThrow("no project with id 'nope'")
    await expect(run(domain, {
      action: 'set_paper', arxiv_id: PAPER.arxivId, relevance_score: 5,
    })).rejects.toThrow("requires a non-empty 'project_id'")
  })

  it('add_paper re-add preserves the curated notes and relevance', async () => {
    const domain = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('papers').put(PAPER.arxivId, {
      ...PAPER,
      relevance: { p1: { score: 7, reason: 'kept', at: '2026-08-20T00:00:00.000Z' } },
    })
    const outcome = await run(domain, {
      action: 'add_paper',
      arxiv_id: PAPER.arxivId,
      title: PAPER.title,
      summary: 'Refreshed abstract.',
    })
    expect(outcome).toMatchObject({ ok: true })
    const stored = domain.table('papers').get(PAPER.arxivId)
    expect(stored?.notes).toBe('keep me')
    expect(stored?.tags).toEqual(['mesh'])
    expect(stored?.relevance?.['p1']?.score).toBe(7)
    expect(stored?.summary).toBe('Refreshed abstract.')
  })
})

describe('wiki_note add_idea auto-adoption', () => {
  it('adopts an idea registered into a project at creation', async () => {
    const domain = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const created = await run(domain, {
      action: 'add_idea',
      title: 'Whole-body ego pose',
      hypothesis: 'Egocentric frames improve pose',
      project_id: 'p1',
    }) as { ok: true; id: string }
    const stored = domain.table('ideas').get(created.id)
    expect(stored).toBeDefined()
    expect(stored?.status).toBe('adopted')
    expect(stored?.projectId).toBe('p1')
    const adoptEvent = [...domain.table('events').entries()]
      .map(([, e]) => e)
      .find((e) => e.action === 'knowledge.idea.adopted' && e.refs.ideaId === created.id)
    expect(adoptEvent).toBeDefined()
    expect(adoptEvent?.refs.projectId).toBe('p1')
  })

  it('keeps a standalone idea active (no project) and emits knowledge.idea.added', async () => {
    const domain = await harness()
    const created = await run(domain, {
      action: 'add_idea',
      title: 'Loose thought',
      hypothesis: 'Maybe',
    }) as { ok: true; id: string }
    const stored = domain.table('ideas').get(created.id)
    expect(stored?.status).toBe('active')
    expect(stored?.projectId).toBeUndefined()
    const addedEvent = [...domain.table('events').entries()]
      .map(([, e]) => e)
      .find((e) => e.action === 'knowledge.idea.added' && e.refs.ideaId === created.id)
    expect(addedEvent).toBeDefined()
  })

  it('rejects a project-scoped idea whose project does not exist', async () => {
    const domain = await harness()
    await expect(run(domain, {
      action: 'add_idea',
      title: 'Orphan',
      hypothesis: 'No project',
      project_id: 'ghost',
    })).rejects.toThrow("no project with id 'ghost'")
  })
})
