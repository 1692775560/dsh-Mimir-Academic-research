/**
 * Behavior tests for the research ledger (P0-1): event construction and
 * payload capping, the append + query semantics over the wiki's `events`
 * table, the audit-report renderer, and the decision-grade wiring in
 * ResearchService (panel actor) and the wiki_note tool (agent actor). Real
 * memory-backed domain, no mocks.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import type { ResearchWikiDomain } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import { createWikiNoteTool } from '../src/tools/wiki.ts'
import { CBE_DERIVATION_VERSION, CBE_TIER_E1_USER_EVENTS, QUESTION_SHOWED_ACTION } from '../src/cognitive-map.ts'
import {
  appendEvent,
  buildProgressReport,
  countEvents,
  emitEvent,
  listEvents,
  newEvent,
  truncatePayload,
  EVENT_PAYLOAD_MAX_CHARS,
  JOURNAL_TEXT_MAX_CHARS,
  LIST_EVENTS_MAX_LIMIT,
  PANEL_ACTOR,
  SERVICE_ACTOR,
  WIKI_AGENT_ACTOR,
} from '../src/ledger.ts'
import type { ProjectRecord, ClaimRecord, ExperimentRecord, EventRecord, IdeaRecord } from '../src/types.ts'

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

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function serviceHarness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-ledger-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
  })
  return { domain, workspaceDir, service }
}

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Long-context retrieval',
  stage: 'experiment',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

const CLAIM: ClaimRecord = {
  id: 'c1',
  text: 'Our retriever beats the dense baseline by 12% on the long split.',
  status: 'supported',
  evidence: 'run e3 (mpjpe 92.4 vs 82.0)',
}

const EXPERIMENT: ExperimentRecord = {
  id: 'e1',
  projectId: PROJECT.id,
  name: 'bhx-v2',
  status: 'success',
  metrics: { mpjpe: 92.4 },
  updatedAt: '2026-08-21T00:00:00.000Z',
}

describe('ledger event construction', () => {
  it('builds unique ids for same-millisecond events and carries the given ts', () => {
    const now = new Date('2026-08-24T00:00:00.000Z')
    const first = newEvent({ actor: PANEL_ACTOR, action: 'x.y', now })
    const second = newEvent({ actor: PANEL_ACTOR, action: 'x.y', now })
    expect(first.ts).toBe('2026-08-24T00:00:00.000Z')
    expect(first.id).not.toBe(second.id)
    expect(first.id.startsWith('ev-')).toBe(true)
    expect(first.refs).toEqual({})
    expect(first.payload).toEqual({})
  })

  it('passes a payload under the cap through unchanged', () => {
    const payload = { name: 'run', status: 'success' }
    expect(truncatePayload(payload)).toBe(payload)
  })

  it('truncates an over-cap payload to a marked preview', () => {
    const payload = { blob: 'x'.repeat(EVENT_PAYLOAD_MAX_CHARS + 500) }
    const truncated = truncatePayload(payload)
    expect(truncated['_truncated']).toBe(true)
    expect(typeof truncated['preview']).toBe('string')
    expect(JSON.stringify(truncated).length).toBeLessThan(EVENT_PAYLOAD_MAX_CHARS + 200)
  })
})

describe('ledger append + query', () => {
  it('appends events and orders them by (ts, id)', async () => {
    const domain = await domainHarness()
    const base = new Date('2026-08-01T00:00:00.000Z')
    await appendEvent(domain, { actor: PANEL_ACTOR, action: 'a.first', now: base })
    await appendEvent(domain, { actor: PANEL_ACTOR, action: 'a.second', now: base })
    await appendEvent(domain, { actor: SERVICE_ACTOR, action: 'a.third', now: new Date(base.getTime() + 1000) })
    const all = await listEvents(domain)
    expect(all.map(event => event.action)).toEqual(['a.first', 'a.second', 'a.third'])
  })

  it('filters by project ref, actor kind, action prefix, and time bounds', async () => {
    const domain = await domainHarness()
    const t0 = new Date('2026-08-01T00:00:00.000Z')
    await appendEvent(domain, {
      actor: PANEL_ACTOR, action: 'compute.job.submitted',
      refs: { projectId: 'p1', jobId: 'j1' }, now: t0,
    })
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR, action: 'knowledge.claim.added',
      refs: { projectId: 'p2', claimId: 'c9' }, now: new Date(t0.getTime() + 1000),
    })
    await appendEvent(domain, {
      actor: SERVICE_ACTOR, action: 'compute.job.settled',
      refs: { projectId: 'p1', jobId: 'j1' }, now: new Date(t0.getTime() + 2000),
    })

    const project = await listEvents(domain, { projectId: 'p1' })
    expect(project.map(event => event.action)).toEqual(['compute.job.submitted', 'compute.job.settled'])

    const agents = await listEvents(domain, { actorKind: 'agent' })
    expect(agents.map(event => event.action)).toEqual(['knowledge.claim.added'])

    const compute = await listEvents(domain, { actionPrefix: 'compute.' })
    expect(compute.map(event => event.action)).toEqual(['compute.job.submitted', 'compute.job.settled'])

    // since is inclusive, until exclusive.
    const bounded = await listEvents(domain, {
      since: t0.toISOString(),
      until: new Date(t0.getTime() + 2000).toISOString(),
    })
    expect(bounded.map(event => event.action)).toEqual(['compute.job.submitted', 'knowledge.claim.added'])
  })

  it('orders desc, caps the limit, and rejects illegal limits and bounds', async () => {
    const domain = await domainHarness()
    const base = new Date('2026-08-01T00:00:00.000Z')
    for (let i = 0; i < 5; i += 1) {
      await appendEvent(domain, { actor: PANEL_ACTOR, action: `a.${i}`, now: new Date(base.getTime() + i * 1000) })
    }
    const desc = await listEvents(domain, { order: 'desc', limit: 2 })
    expect(desc.map(event => event.action)).toEqual(['a.4', 'a.3'])
    await expect(listEvents(domain, { limit: 0 })).rejects.toThrow(RangeError)
    await expect(listEvents(domain, { limit: LIST_EVENTS_MAX_LIMIT + 1 })).rejects.toThrow(RangeError)
    await expect(listEvents(domain, { since: 'not-a-date' })).rejects.toThrow(RangeError)
    await expect(listEvents(domain, { until: 'not-a-date' })).rejects.toThrow(RangeError)
  })

  it('caps the NEWEST window, not the oldest, so a long ledger never freezes', async () => {
    const domain = await domainHarness()
    const base = new Date('2026-08-01T00:00:00.000Z')
    for (let i = 0; i < 5; i += 1) {
      await appendEvent(domain, { actor: PANEL_ACTOR, action: `a.${i}`, now: new Date(base.getTime() + i * 1000) })
    }
    // The window is the newest matches, still handed back time-ascending so
    // the downstream folds (sessionize, symbol sequences) keep their order.
    const newest = await listEvents(domain, { limit: 2 })
    expect(newest.map(event => event.action)).toEqual(['a.3', 'a.4'])
    const newestDesc = await listEvents(domain, { limit: 2, order: 'desc' })
    expect(newestDesc.map(event => event.action)).toEqual(['a.4', 'a.3'])
    // `oldest` is opt-in, for callers that really want the head of history.
    const oldest = await listEvents(domain, { limit: 2, anchor: 'oldest' })
    expect(oldest.map(event => event.action)).toEqual(['a.0', 'a.1'])
  })

  it('counts every match uncapped, so a truncated window can say so', async () => {
    const domain = await domainHarness()
    const base = new Date('2026-08-01T00:00:00.000Z')
    for (let i = 0; i < 5; i += 1) {
      await appendEvent(domain, { actor: PANEL_ACTOR, action: `a.${i}`, now: new Date(base.getTime() + i * 1000) })
    }
    await appendEvent(domain, { actor: SERVICE_ACTOR, action: 'b.other', now: new Date(base.getTime() + 5000) })
    expect(await countEvents(domain)).toBe(6)
    expect(await countEvents(domain, { actorKind: 'system' })).toBe(1)
    // The capped window is 2 long; the honest total is 6.
    const window = await listEvents(domain, { limit: 2 })
    expect(window).toHaveLength(2)
    expect(await countEvents(domain)).toBeGreaterThan(window.length)
  })
})

describe('audit report', () => {
  /** Seed a project, claim, experiment, and a handful of decision-grade events. */
  async function seedReportFixture() {
    const domain = await domainHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('claims').put(CLAIM.id, CLAIM)
    await domain.table('experiments').put(EXPERIMENT.id, EXPERIMENT)
    await domain.table('claims').put('c2', {
      id: 'c2',
      text: 'The gap closes under longer context.',
      status: 'pending',
      evidence: '',
    })
    const base = new Date('2026-08-20T09:00:00.000Z')
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR, action: 'knowledge.claim.added',
      refs: { projectId: PROJECT.id, claimId: CLAIM.id },
      payload: { text: CLAIM.text }, now: base,
    })
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR, action: 'knowledge.claim.set',
      refs: { projectId: PROJECT.id, claimId: CLAIM.id },
      payload: { status: 'supported', evidence: CLAIM.evidence }, now: new Date(base.getTime() + 60_000),
    })
    await appendEvent(domain, {
      actor: PANEL_ACTOR, action: 'data.wiki.imported',
      payload: { mode: 'replace', destructive: true }, now: new Date(base.getTime() + 120_000),
    })
    await appendEvent(domain, {
      actor: SERVICE_ACTOR, action: 'compute.job.settled',
      refs: { projectId: PROJECT.id, jobId: 'j1', experimentId: EXPERIMENT.id },
      payload: { status: 'succeeded', exitCode: 0, durationMs: 1_200_000 }, now: new Date(base.getTime() + 180_000),
    })
    await appendEvent(domain, {
      actor: { kind: 'subagent', id: 'reviewer' }, action: 'review.round.settled',
      refs: { projectId: PROJECT.id },
      payload: { verdict: 'PASS', issues: 0, scope: 'plan EXPERIMENT_PLAN.md' }, now: new Date(base.getTime() + 240_000),
    })
    return domain
  }

  it('renders summary, risk, claim ledger, runs, and events sections', async () => {
    const domain = await seedReportFixture()
    const markdown = await buildProgressReport(domain, {}, new Date('2026-08-24T00:00:00.000Z'))
    expect(markdown).toContain('# Mimir Research Progress Report')
    expect(markdown).toContain('all projects (1)') // global scope: the whole library
    expect(markdown).toContain('5 event(s)')
    // The TL;DR line: two claim moves, one settled run, one review round,
    // one destructive op — in the 组会 order.
    expect(markdown).toContain(
      '- **TL;DR:** 2 claim updates · 1 run settled (1 succeeded) · 1 review round (PASS) · 1 destructive op',
    )
    // Progress leads: the full timeline, newest first.
    expect(markdown).toContain('## Progress (newest 5 of 5)')
    expect(markdown).toContain('review.round.settled')
    // Learning: the growth — the claim flip and the review verdict.
    expect(markdown).toContain('## Learning & judgment changes')
    expect(markdown).toContain('knowledge.claim.set')
    // Current-state rows.
    expect(markdown).toContain('## Current state')
    expect(markdown).toContain('Claims | supported 1 · pending 1')
    expect(markdown).toContain('Experiments | success 1')
    expect(markdown).toContain('wall 20m0s')
    expect(markdown).toContain('Review rounds | PASS 1')
    expect(markdown).toContain('user/panel')
    // Claim ledger with the last ledgered change (the set_claim flip).
    expect(markdown).toContain('## Claim ledger')
    expect(markdown).toContain('→ supported')
    // Experiments & runs.
    expect(markdown).toContain('## Experiments & runs')
    expect(markdown).toContain('`e1`')
    expect(markdown).toContain('mpjpe=92.4')
    // Destructive ops flagged as the closing risk footnote.
    expect(markdown).toContain('## Destructive & high-risk operations')
    expect(markdown).toContain('`data.wiki.imported`')
    // Growth-first ordering: progress → learning → state → risk footnote.
    expect(markdown.indexOf('## Progress')).toBeLessThan(markdown.indexOf('## Learning & judgment changes'))
    expect(markdown.indexOf('## Learning & judgment changes')).toBeLessThan(markdown.indexOf('## Current state'))
    expect(markdown.indexOf('## Current state')).toBeLessThan(markdown.indexOf('## Destructive & high-risk operations'))
  })

  it('scopes to one project and to a time window', async () => {
    const domain = await seedReportFixture()
    // A second project with its own event outside p1's scope.
    await domain.table('projects').put('p2', { ...PROJECT, id: 'p2', title: 'Other' })
    await appendEvent(domain, {
      actor: PANEL_ACTOR, action: 'literature.paper.imported',
      refs: { projectId: 'p2', paperId: 'x1' },
      now: new Date('2026-08-20T10:00:00.000Z'),
    })
    const scoped = await buildProgressReport(domain, { projectId: 'p1' })
    expect(scoped).toContain('Long-context retrieval (p1)')
    expect(scoped).not.toContain('literature.paper.imported')
    // A window before all the activity contains no events at all.
    const empty = await buildProgressReport(domain, {
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-02-01T00:00:00.000Z',
    })
    expect(empty).toContain('0 event(s)')
    expect(empty).toContain('quiet window — no decision-grade events')
    expect(empty).toContain('_no activity in window_')
    // A window after the fixture activity keeps only p2's event — the
    // weekly-组会 shape: one literature/writing move in the TL;DR.
    const tight = await buildProgressReport(domain, {
      since: '2026-08-20T09:30:00.000Z',
      until: '2026-08-20T10:30:00.000Z',
    })
    expect(tight).toContain('1 event(s)')
    expect(tight).toContain('- **TL;DR:** 1 literature/writing event')
    expect(tight).toContain('literature.paper.imported')
  })

  it('reports an empty ledger cleanly', async () => {
    const domain = await domainHarness()
    const markdown = await buildProgressReport(domain, {})
    expect(markdown).toContain('all projects (0)')
    expect(markdown).toContain('quiet window — no decision-grade events')
    expect(markdown).toContain('_no activity in window_')
    expect(markdown).toContain('_no judgment changes in window_')
    expect(markdown).toContain('_no claims recorded_')
    expect(markdown).toContain('_no experiment runs recorded_')
    expect(markdown).toContain('_none in window_')
  })
})

describe('ResearchService ledger wiring (panel actor)', () => {
  it('saveExperiment appends experiments.saved with refs and a create flag', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const created = await service.saveExperiment({
      experiment: { projectId: PROJECT.id, name: 'bhx-v2', status: 'running', metrics: { mpjpe: 88.1 } },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('unreachable')
    const events = await listEvents(domain, { actionPrefix: 'experiments.' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      action: 'experiments.saved',
      actor: { kind: 'user', id: 'panel' },
      refs: { projectId: PROJECT.id, experimentId: created.value.experiment.id },
      payload: { name: 'bhx-v2', status: 'running', created: true, metricCount: 1 },
    })
  })

  it('deleteExperiment marks the ledger row destructive', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('experiments').put(EXPERIMENT.id, EXPERIMENT)
    await expect(service.deleteExperiment({ id: EXPERIMENT.id })).resolves.toMatchObject({ ok: true })
    const events = await listEvents(domain, { actionPrefix: 'experiments.' })
    expect(events[0]).toMatchObject({
      action: 'experiments.deleted',
      refs: { experimentId: EXPERIMENT.id, projectId: PROJECT.id },
      payload: { name: 'bhx-v2', destructive: true },
    })
  })

  it('importWiki in replace mode is ledgered as destructive', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const outcome = await service.importWiki({
      snapshot: {
        format: 'mimir-wiki',
        version: 2,
        exportedAt: '2026-08-20T00:00:00.000Z',
        tables: {
          papers: [], ideas: [], claims: [], projects: [], experiments: [], servers: [], figures: [],
        },
      },
      mode: 'replace',
      confirmReplace: true,
    })
    expect(outcome.ok).toBe(true)
    const events = await listEvents(domain, { actionPrefix: 'data.' })
    expect(events[0]).toMatchObject({
      action: 'data.wiki.imported',
      payload: { mode: 'replace', destructive: true },
    })
  })

  it('submitJob ledgeres the submit, and the settle lands as a system event', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('experiments').put(EXPERIMENT.id, EXPERIMENT)
    const server = await service.saveServer({
      server: { name: 'gpu01', host: '127.0.0.1', port: 19999, username: 'ops', note: '' },
    })
    if (!server.ok) throw new Error('server create failed')
    const submitted = await service.submitJob({
      serverId: server.value.server.id,
      command: 'echo settle-me',
      experimentId: EXPERIMENT.id,
    })
    expect(submitted.ok).toBe(true)
    if (!submitted.ok) throw new Error('unreachable')
    // The submit event is durable before runJob even starts.
    const submits = (await listEvents(domain, {})).filter(event => event.action === 'compute.job.submitted')
    expect(submits).toHaveLength(1)
    expect(submits[0]).toMatchObject({
      refs: { jobId: submitted.value.job.id, serverId: server.value.server.id, experimentId: EXPERIMENT.id },
      payload: { command: 'echo settle-me' },
    })
    // Wait for the background settle (a closed port / absent ssh fails fast).
    const deadline = Date.now() + 20_000
    let settled: EventRecord | undefined
    for (;;) {
      settled = (await listEvents(domain, {})).find(event => event.action === 'compute.job.settled')
      if (settled !== undefined) break
      if (Date.now() > deadline) throw new Error('job did not settle in time')
      await new Promise(resolve => { setTimeout(resolve, 100) })
    }
    expect(settled).toMatchObject({
      actor: { kind: 'system', id: 'service' },
      refs: { jobId: submitted.value.job.id },
    })
    expect(typeof settled?.payload['durationMs']).toBe('number')
  }, 30_000)

  it('generateProgressReport scopes to a project and rejects an unknown id', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await service.saveExperiment({
      experiment: { projectId: PROJECT.id, name: 'bhx-v2', status: 'success', metrics: {} },
    })
    const scoped = await service.generateProgressReport({ projectId: PROJECT.id })
    expect(scoped.ok).toBe(true)
    if (!scoped.ok) throw new Error('unreachable')
    expect(scoped.value.markdown).toContain('Long-context retrieval (p1)')
    expect(scoped.value.eventCount).toBeGreaterThanOrEqual(1)
    await expect(service.generateProgressReport({ projectId: 'ghost' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
  })

  it('listEvents validates runtime input', async () => {
    const { service } = await serviceHarness()
    await expect(service.listEvents({ actorKind: 'ghost' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.listEvents({ order: 'sideways' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.listEvents({ limit: 99999 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    const ok = await service.listEvents({})
    expect(ok).toEqual({ ok: true, value: { events: [] } })
  })
})

describe('cognitive beidou remotes (CBE service wiring)', () => {
  it('addJournalEntry appends the L2 event with panel actor and queryable refs', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const outcome = await service.addJournalEntry({ text: '这条线要再想想', projectId: PROJECT.id })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.value.event).toMatchObject({
      action: 'journal.entry.added',
      actor: { kind: 'user', id: 'panel' },
      refs: { projectId: PROJECT.id },
      payload: { text: '这条线要再想想' },
    })
    const events = await listEvents(domain, { actionPrefix: 'journal.' })
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe(outcome.value.event.id)
  })

  it('addJournalEntry carries optional self-reported mood ratings, range-checked', async () => {
    const { service } = await serviceHarness()
    const tagged = await service.addJournalEntry({ text: '今天有点乱但兴奋', valence: 4, arousal: 5 })
    expect(tagged.ok).toBe(true)
    if (!tagged.ok) throw new Error('unreachable')
    expect(tagged.value.event.payload).toEqual({ text: '今天有点乱但兴奋', valence: 4, arousal: 5 })
    const oneSided = await service.addJournalEntry({ text: '只标一头', valence: 2 })
    expect(oneSided.ok).toBe(true)
    if (!oneSided.ok) throw new Error('unreachable')
    expect(oneSided.value.event.payload).toEqual({ text: '只标一头', valence: 2 })
    await expect(service.addJournalEntry({ text: 'x', valence: 0 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'valence must be an integer between 1 and 5' } })
    await expect(service.addJournalEntry({ text: 'x', arousal: 2.5 }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'arousal must be an integer between 1 and 5' } })
  })

  it('addJournalEntry rejects blank text, over-cap text, and unknown projects', async () => {
    const { service } = await serviceHarness()
    await expect(service.addJournalEntry({ text: '   ', projectId: 'p1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'journal text must not be empty' } })
    await expect(service.addJournalEntry({ text: 'x'.repeat(JOURNAL_TEXT_MAX_CHARS + 1) }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.addJournalEntry({ text: 'valid text', projectId: 'ghost' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
  })

  it('generateBrief composes the roadbook: dominant line, L2 words, event count', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('ideas').put('i1', {
      id: 'i1',
      title: 'Retrieval-free decoding',
      hypothesis: 'It works without retrieval.',
      status: 'active',
      createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    })
    const now = Date.now()
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'knowledge.idea.added',
      refs: { ideaId: 'i1', projectId: PROJECT.id },
      payload: { title: 'Retrieval-free decoding' },
      now: new Date(now - 3_600_000),
    })
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'experiments.saved',
      refs: { ideaId: 'i1', projectId: PROJECT.id },
      payload: { name: 'rfd-run-1', created: true },
      now: new Date(now - 1_800_000),
    })
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'literature.paper.imported',
      refs: { ideaId: 'i1', projectId: PROJECT.id },
      payload: { title: 'Retrieval-free related work', imported: true },
      now: new Date(now - 600_000),
    })
    await service.addJournalEntry({ text: '这条线起来了', projectId: PROJECT.id, ideaId: 'i1' })
    const brief = await service.generateBrief({
      projectId: PROJECT.id,
      since: new Date(now - 2 * 86_400_000).toISOString(),
    })
    expect(brief.ok).toBe(true)
    if (!brief.ok) throw new Error('unreachable')
    expect(brief.value.markdown).toContain('| `i1` Retrieval-free decoding | dominant')
    expect(brief.value.markdown).toContain('## Your words (the L2 layer)')
    expect(brief.value.markdown).toContain('这条线起来了')
    expect(brief.value.eventCount).toBe(4)
  })

  it('generateBrief carries the derivation version and logs the I4 showed meta event', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('claims').put('c9', {
      id: 'c9',
      text: 'another pending claim text that is long enough to stand in a card',
      status: 'pending',
      evidence: '—',
    })
    const brief = await service.generateBrief({ projectId: PROJECT.id })
    expect(brief.ok).toBe(true)
    if (!brief.ok) throw new Error('unreachable')
    expect(brief.value.derivationVersion).toBe(CBE_DERIVATION_VERSION)
    const meta = await listEvents(domain, { actionPrefix: 'cbe.question.' })
    expect(meta).toHaveLength(1)
    expect(meta[0]).toMatchObject({
      action: 'cbe.question.showed',
      actor: { kind: 'user', id: 'panel' },
      payload: { count: 1, lineIds: ['c9'] },
    })
  })

  it('does not let the instrument’s own observations lift a line’s evidence tier', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('ideas').put('i1', {
      id: 'i1',
      title: 'Observer-proof line',
      hypothesis: 'The tier comes from research, not from looking.',
      status: 'active',
      createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    })
    const now = Date.now()
    // One real event short of the E1 window mass (CBE_TIER_E1_USER_EVENTS).
    for (let i = 0; i < CBE_TIER_E1_USER_EVENTS - 1; i += 1) {
      await appendEvent(domain, {
        actor: WIKI_AGENT_ACTOR,
        action: 'knowledge.claim.set',
        refs: { ideaId: 'i1' },
        payload: { status: 'supported' },
        now: new Date(now - (CBE_TIER_E1_USER_EVENTS - i) * 1000),
      })
    }
    // The instrument's own ticks: without excluding these, opening the panel
    // a few times would push the window over the E1 floor and upgrade the
    // line from e0 to e0+e1 with no research behind it.
    await appendEvent(domain, { actor: PANEL_ACTOR, action: QUESTION_SHOWED_ACTION, refs: {}, payload: { count: 1 } })
    await appendEvent(domain, { actor: PANEL_ACTOR, action: QUESTION_SHOWED_ACTION, refs: {}, payload: { count: 1 } })

    const brief = await service.generateBrief({})
    expect(brief.ok).toBe(true)
    if (!brief.ok) throw new Error('unreachable')
    expect(brief.value.markdown).toContain('| e0 |')
    expect(brief.value.markdown).not.toContain('| e0+e1 |')

    // Control: one more REAL decision-grade event crosses the floor, so the
    // test above is not vacuous — the tier does move when research happens.
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'knowledge.claim.set',
      refs: { ideaId: 'i1' },
      payload: { status: 'supported' },
      now: new Date(now),
    })
    const upgraded = await service.generateBrief({})
    expect(upgraded.ok).toBe(true)
    if (!upgraded.ok) throw new Error('unreachable')
    expect(upgraded.value.markdown).toContain('| e0+e1 |')
  })

  it('addJournalEntry answers a question card with the I4 answered meta event', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('claims').put('c9', {
      id: 'c9',
      text: 'a pending claim the journal entry answers',
      status: 'pending',
      evidence: '—',
    })
    const outcome = await service.addJournalEntry({
      text: '关于这条断言：我的裁定是先放着',
      question: { kind: 'pending-claim', lineId: 'c9' },
    })
    expect(outcome.ok).toBe(true)
    const meta = await listEvents(domain, { actionPrefix: 'cbe.question.' })
    expect(meta).toHaveLength(1)
    expect(meta[0]).toMatchObject({
      action: 'cbe.question.answered',
      refs: { claimId: 'c9' },
      payload: { kind: 'pending-claim', lineId: 'c9' },
    })
    await expect(service.addJournalEntry({ text: 'x', question: { kind: 'nonsense', lineId: 'c9' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('generateBrief rejects an unknown project id', async () => {
    const { service } = await serviceHarness()
    await expect(service.generateBrief({ projectId: 'ghost' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
  })

  it('generateBrief surfaces structured boundary questions with labels', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('ideas').put('idea-r', {
      id: 'idea-r',
      title: 'Side road idea',
      hypothesis: 'A persistent side road.',
      status: 'active',
      createdAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    })
    await domain.table('claims').put('c9', {
      id: 'c9',
      text: '这个断言的文本写得足够长，长到明显超过四十八个字符的上限，从而必须被截断成一个较短的摘要，才能放进那张边界确认卡片里。',
      status: 'pending',
      evidence: '—',
    })
    const now = Date.now()
    // A returning-side line: +1.5 / −1.5 / +1.5 / +1.5 / −1.5 across five
    // far-apart days — five events so the line clears the I2 word floor.
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'experiments.saved',
      refs: { ideaId: 'idea-r', projectId: PROJECT.id },
      payload: { name: 'r0', created: true },
      now: new Date(now - 7 * 86_400_000),
    })
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'experiments.saved',
      refs: { ideaId: 'idea-r', projectId: PROJECT.id },
      payload: { name: 'r1', created: true },
      now: new Date(now - 5 * 86_400_000),
    })
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'experiments.deleted',
      refs: { ideaId: 'idea-r', projectId: PROJECT.id },
      payload: { name: 'r1', destructive: true },
      now: new Date(now - 3 * 86_400_000),
    })
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'experiments.saved',
      refs: { ideaId: 'idea-r', projectId: PROJECT.id },
      payload: { name: 'r2', created: true },
      now: new Date(now - 1 * 86_400_000),
    })
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'experiments.deleted',
      refs: { ideaId: 'idea-r', projectId: PROJECT.id },
      payload: { name: 'r0', destructive: true },
      now: new Date(now - 2 * 86_400_000),
    })
    const brief = await service.generateBrief({ projectId: PROJECT.id })
    expect(brief.ok).toBe(true)
    if (!brief.ok) throw new Error('unreachable')
    const questions = brief.value.questions
    const branch = questions.find(question => question.kind === 'returning-branch')
    expect(branch).toEqual({ kind: 'returning-branch', lineId: 'idea-r', label: 'Side road idea' })
    const pending = questions.find(question => question.kind === 'pending-claim')
    expect(pending?.lineId).toBe('c9')
    expect(pending?.label.endsWith('…')).toBe(true)
    expect(pending?.label.length).toBeLessThanOrEqual(48)
  })
})

describe('worktree remotes (S2 service wiring)', () => {
  const ACTIVE: IdeaRecord = {
    id: 'i1',
    title: 'Bayes overflow',
    hypothesis: 'h',
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
  }
  const SIDE: IdeaRecord = {
    id: 'i2',
    title: 'Side branch',
    hypothesis: 'h',
    status: 'active',
    createdAt: '2026-08-02T00:00:00.000Z',
  }

  it('getWorktree derives an empty tree over a fresh wiki', async () => {
    const { service } = await serviceHarness()
    const outcome = await service.getWorktree()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.value.worktree.lanes).toEqual([])
    expect(outcome.value.worktree.mainline).toBeNull()
    expect(outcome.value.worktree.counts).toEqual({ open: 0, failed: 0, adopted: 0 })
  })

  it('setMainline moves the ref, and getWorktree reads it back label-resolved', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('ideas').put(ACTIVE.id, ACTIVE)
    const declared = await service.setMainline({ ideaId: 'i1' })
    expect(declared.ok).toBe(true)
    if (!declared.ok) throw new Error('unreachable')
    expect(declared.value.event).toMatchObject({
      action: 'cbe.mainline.set',
      actor: { kind: 'user', id: 'panel' },
      refs: { ideaId: 'i1' },
    })
    const tree = await service.getWorktree()
    expect(tree.ok).toBe(true)
    if (!tree.ok) throw new Error('unreachable')
    expect(tree.value.worktree.mainline).toEqual({ lineId: 'i1', label: 'Bayes overflow', declaredAt: declared.value.event.ts })
    expect(tree.value.worktree.mainlineHistory).toHaveLength(1)
  })

  it('setMainline validates arity, unknown ids, and live-line status', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('ideas').put(ACTIVE.id, ACTIVE)
    await domain.table('ideas').put('i3', { ...ACTIVE, id: 'i3', status: 'failed', failureReason: 'no effect' })
    await expect(service.setMainline({}))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'setMainline takes exactly one of ideaId or projectId' } })
    await expect(service.setMainline({ ideaId: 'i1', projectId: 'p1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    await expect(service.setMainline({ ideaId: 'ghost' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'unknown ideaId: ghost' } })
    await expect(service.setMainline({ projectId: 'ghost' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'project-not-found' } })
    await expect(service.setMainline({ ideaId: 'i3' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'only an active line can be the mainline (this one is failed)' } })
    const projectMainline = await service.setMainline({ projectId: PROJECT.id })
    expect(projectMainline.ok).toBe(true)
  })

  it('setIdeaParent declares edges, rejects cycles, and clears with null', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('ideas').put(ACTIVE.id, ACTIVE)
    await domain.table('ideas').put(SIDE.id, SIDE)
    await expect(service.setIdeaParent({ ideaId: 'ghost', parentIdeaId: 'i1' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'unknown ideaId: ghost' } })
    await expect(service.setIdeaParent({ ideaId: 'i2', parentIdeaId: 'ghost' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'unknown parentIdeaId: ghost' } })
    await expect(service.setIdeaParent({ ideaId: 'i2', parentIdeaId: 'i2' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'a line cannot derive from itself' } })
    const declared = await service.setIdeaParent({ ideaId: 'i2', parentIdeaId: 'i1' })
    expect(declared.ok).toBe(true)
    if (!declared.ok) throw new Error('unreachable')
    expect(declared.value.event).toMatchObject({
      action: 'cbe.idea.parent.set',
      refs: { ideaId: 'i2' },
      payload: { parentIdeaId: 'i1' },
    })
    // i1 → i2 would close a loop through the just-declared i2 → i1 edge.
    await expect(service.setIdeaParent({ ideaId: 'i1', parentIdeaId: 'i2' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'that derivation would create a cycle' } })
    const tree = await service.getWorktree()
    expect(tree.ok).toBe(true)
    if (!tree.ok) throw new Error('unreachable')
    const lane = tree.value.worktree.lanes.find(item => item.lineId === 'i2')
    expect(lane?.parentLineId).toBe('i1')
    expect(lane?.parentLabel).toBe('Bayes overflow')
    const cleared = await service.setIdeaParent({ ideaId: 'i2', parentIdeaId: null })
    expect(cleared.ok).toBe(true)
    const after = await service.getWorktree()
    expect(after.ok).toBe(true)
    if (!after.ok) throw new Error('unreachable')
    expect(after.value.worktree.lanes.find(item => item.lineId === 'i2')?.parentLineId).toBeNull()
  })

  it('closeIdea writes the documented No end to end: record, event, origin, GUT', async () => {
    // The close below rides the REAL clock, so the anchor must too — a
    // hardcoded date makes GUT drift by however many days have passed since.
    const now = Date.now()
    const { domain, service } = await serviceHarness()
    await domain.table('ideas').put(SIDE.id, SIDE)
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'knowledge.idea.added',
      refs: { ideaId: SIDE.id },
      payload: { title: SIDE.title },
      now: new Date(now - 10 * 86_400_000),
    })
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'experiments.saved',
      refs: { ideaId: SIDE.id },
      payload: { name: 'run1', created: true },
      now: new Date(now - 6 * 86_400_000),
    })
    await expect(service.closeIdea({ ideaId: 'i2', reason: '   ' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'close reason must not be empty' } })
    await expect(service.closeIdea({ ideaId: 'i2', reason: 'x'.repeat(49) }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'close reason is capped at 48 characters' } })
    await expect(service.closeIdea({ ideaId: 'ghost', reason: 'no effect' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'unknown ideaId: ghost' } })
    const closed = await service.closeIdea({ ideaId: 'i2', reason: 'no effect under load' })
    expect(closed.ok).toBe(true)
    if (!closed.ok) throw new Error('unreachable')
    expect(closed.value.event).toMatchObject({
      action: 'knowledge.idea.failed',
      actor: { kind: 'user', id: 'panel' }, // origin: the user's explicit, refusable action
      refs: { ideaId: 'i2' },
      payload: { reason: 'no effect under load' },
    })
    expect(domain.table('ideas').get('i2')).toMatchObject({ status: 'failed', failureReason: 'no effect under load' })
    // Re-closing is rejected: a documented No is written once.
    await expect(service.closeIdea({ ideaId: 'i2', reason: 'again' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'that line is already closed (a documented No)' } })
    const tree = await service.getWorktree()
    expect(tree.ok).toBe(true)
    if (!tree.ok) throw new Error('unreachable')
    const lane = tree.value.worktree.lanes.find(item => item.lineId === 'i2')
    expect(lane?.status).toBe('failed')
    expect(lane?.closeReason).toBe('no effect under load')
    // GUT: last touch 6 days before the close (the close rides the real
    // clock). The derivation rounds to 3 decimals, so "6 days plus the
    // milliseconds it takes to close" reads as exactly 6 — hence >= not >.
    expect(lane?.gutDays).toBeGreaterThanOrEqual(6)
    expect(lane?.gutDays).toBeLessThan(7)
  })

  it('closeIdea refuses an adopted line: a merge is not a dead end', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('ideas').put('i4', { ...ACTIVE, id: 'i4', status: 'adopted' })
    await expect(service.closeIdea({ ideaId: 'i4', reason: 'wrong kind of ending' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'an adopted line is a merge, not a dead end' } })
  })
})

describe('evidence engine remotes (S3 service wiring)', () => {
  it('getEvidenceProfile folds the priors over an empty ledger', async () => {
    const { service } = await serviceHarness()
    const outcome = await service.getEvidenceProfile()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.value.profile.terminalsFolded).toBe(0)
    expect(outcome.value.profile.actions.length).toBeGreaterThan(0)
    const saved = outcome.value.profile.actions.find(row => row.action === 'experiments.saved')
    expect(saved?.effectiveValue).toBe(saved?.prior)
  })

  it('getEvidenceProfile folds a attributed terminal into a learned row', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'experiments.saved',
      refs: { ideaId: 'i1', projectId: PROJECT.id },
      payload: { name: 'run', created: true },
      now: new Date(Date.now() - 2 * 86_400_000),
    })
    // Synthetic rich refs: today's real claim emit carries only claimId —
    // attribution enrichment is the standing P2 item (see cbe-engine.spec).
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'knowledge.claim.set',
      refs: { ideaId: 'i1', projectId: PROJECT.id },
      payload: { status: 'supported' },
      now: new Date(Date.now() - 1 * 86_400_000),
    })
    const outcome = await service.getEvidenceProfile()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.value.profile.terminalsFolded).toBe(1)
    const saved = outcome.value.profile.actions.find(row => row.action === 'experiments.saved')
    expect(saved?.mass).toBeGreaterThan(0)
    expect(saved?.effectiveValue).not.toBe(saved?.prior)
  })
})

describe('adopt remotes (worktree merge)', () => {
  const MAIN: IdeaRecord = {
    id: 'i9', title: 'Chunk-graph reranking', hypothesis: 'h',
    status: 'active', createdAt: '2026-08-01T00:00:00.000Z',
  }
  const SIDE_BRANCH: IdeaRecord = {
    id: 'i10', title: 'Late-interaction pooling', hypothesis: 'h',
    status: 'active', createdAt: '2026-08-02T00:00:00.000Z',
  }

  it('adoptIdea declares the merge end to end: record, event, origin, lane', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('ideas').put(MAIN.id, MAIN)
    await expect(service.adoptIdea({ ideaId: 'ghost' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'unknown ideaId: ghost' } })
    const merged = await service.adoptIdea({ ideaId: MAIN.id })
    expect(merged.ok).toBe(true)
    if (!merged.ok) throw new Error('unreachable')
    expect(merged.value.event).toMatchObject({
      action: 'knowledge.idea.adopted',
      actor: { kind: 'user', id: 'panel' }, // origin: the user's explicit, refusable action
      refs: { ideaId: MAIN.id },
    })
    expect(domain.table('ideas').get(MAIN.id)).toMatchObject({ status: 'adopted' })
    // A merge is written once; a documented No is not a merge.
    await expect(service.adoptIdea({ ideaId: MAIN.id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'that line is already merged (an adoption is written once)' } })
    await domain.table('ideas').put(SIDE_BRANCH.id, SIDE_BRANCH)
    await service.closeIdea({ ideaId: SIDE_BRANCH.id, reason: 'no effect' })
    await expect(service.adoptIdea({ ideaId: SIDE_BRANCH.id }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-input', message: 'a documented No is a dead end, not a merge' } })
    const tree = await service.getWorktree()
    expect(tree.ok).toBe(true)
    if (!tree.ok) throw new Error('unreachable')
    expect(tree.value.worktree.counts.adopted).toBe(1)
    const lane = tree.value.worktree.lanes.find(item => item.lineId === MAIN.id)
    expect(lane?.status).toBe('adopted')
  })

  it('the merge folds +1 in the evidence engine (credit on prior actions)', async () => {
    const { domain, service } = await serviceHarness()
    await domain.table('ideas').put(MAIN.id, MAIN)
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'knowledge.idea.added',
      refs: { ideaId: MAIN.id },
      payload: { title: MAIN.title },
      now: new Date(Date.now() - 5 * 86_400_000),
    })
    await service.adoptIdea({ ideaId: MAIN.id })
    const profile = await service.getEvidenceProfile()
    expect(profile.ok).toBe(true)
    if (!profile.ok) throw new Error('unreachable')
    expect(profile.value.profile.terminalsFolded).toBe(1)
    // The +1 lands on the line's prior eligible action (share form).
    const added = profile.value.profile.actions.find(item => item.action === 'knowledge.idea.added')
    expect(added?.mass ?? 0).toBeGreaterThanOrEqual(1)
    // The +1 outcome pulls the effective value toward +1 from its +2 prior.
    expect(Math.abs((added?.effectiveValue ?? 1) - 1)).toBeLessThan(Math.abs((added?.prior ?? 1) - 1))
  })
})

describe('foraging remotes (S4 service wiring)', () => {
  it('getForaging derives an empty layer over a fresh wiki', async () => {
    const { service } = await serviceHarness()
    const outcome = await service.getForaging()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.value.foraging.territories).toEqual([])
    expect(outcome.value.foraging.baseline.speaks).toBe(false)
  })

  it('getForaging returns territory rows with the clean-compile harvest proxy', async () => {
    const now = Date.now()
    const { domain, service } = await serviceHarness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await appendEvent(domain, {
      actor: WIKI_AGENT_ACTOR,
      action: 'experiments.saved',
      refs: { projectId: PROJECT.id },
      payload: { name: 'run', created: true },
      now: new Date(now - 3 * 86_400_000),
    })
    await appendEvent(domain, {
      actor: SERVICE_ACTOR,
      action: 'writing.compile.settled',
      refs: { projectId: PROJECT.id },
      payload: { issues: 0 },
      now: new Date(now - 1 * 86_400_000),
    })
    const outcome = await service.getForaging()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    const territory = outcome.value.foraging.territories.find(item => item.projectId === PROJECT.id)
    expect(territory?.label).toBe(PROJECT.title)
    expect(territory?.eventCount).toBe(2)
    expect(territory?.harvestCount).toBe(1)
    expect(territory?.daysSinceHarvest).toBeGreaterThanOrEqual(1)
    expect(territory?.daysSinceHarvest).toBeLessThan(2)
    const card = outcome.value.foraging.cards.find(item => item.projectId === PROJECT.id)
    expect(card?.baselineMedianDays).toBeNull() // the baseline stays silent below five closes
  })
})

describe('wiki_note ledger wiring (agent actor)', () => {
  /** The tool's execute needs a ToolRunContext it never reads in these paths. */
  const NO_EXEC = {} as ToolRunContext

  async function run(domain: ResearchWikiDomain, args: Record<string, unknown>) {
    const tool = createWikiNoteTool(domain)
    return await tool.execute(args, NO_EXEC) as Record<string, unknown>
  }

  it('set_claim ledgeres the transition with the claim ref', async () => {
    const domain = await domainHarness()
    await domain.table('claims').put(CLAIM.id, CLAIM)
    const outcome = await run(domain, {
      action: 'set_claim', id: CLAIM.id, status: 'invalidated', evidence: 'run e7 contradicts',
    })
    expect(outcome).toMatchObject({ ok: true, status: 'invalidated' })
    const events = await listEvents(domain, { actionPrefix: 'knowledge.claim.' })
    expect(events[0]).toMatchObject({
      action: 'knowledge.claim.set',
      actor: { kind: 'agent', id: 'wiki_note' },
      refs: { claimId: CLAIM.id },
      payload: { status: 'invalidated', evidence: 'run e7 contradicts' },
    })
  })

  it('fail_idea ledgeres the failure with the reason', async () => {
    const domain = await domainHarness()
    await domain.table('ideas').put('i1', {
      id: 'i1',
      title: 'Retrieval-free decoding',
      hypothesis: 'It works without retrieval.',
      status: 'active',
      createdAt: '2026-08-01T00:00:00.000Z',
    })
    const outcome = await run(domain, {
      action: 'fail_idea', id: 'i1', reason: 'collapses without retrieval on long splits',
    })
    expect(outcome).toMatchObject({ ok: true, status: 'failed' })
    const events = await listEvents(domain, { actionPrefix: 'knowledge.idea.' })
    expect(events[0]).toMatchObject({
      action: 'knowledge.idea.failed',
      actor: { kind: 'agent', id: 'wiki_note' },
      refs: { ideaId: 'i1' },
      payload: { reason: 'collapses without retrieval on long splits' },
    })
  })
})


describe('emitEvent transient-failure retry (R28)', () => {
  /** Real storage underneath; only the transport hiccups on demand. */
  const flakyDomain = (domain: ResearchWikiDomain, failures: { left: number }): ResearchWikiDomain => ({
    table: () => {
      const handle = domain.table('events')
      return {
        put: async (key: string, value: EventRecord): Promise<void> => {
          if (failures.left > 0) {
            failures.left -= 1
            throw new Error('transient storage hiccup')
          }
          await handle.put(key, value)
        },
      }
    },
  }) as unknown as ResearchWikiDomain

  it('retries a transient storage failure and still lands the event', async () => {
    const domain = await domainHarness()
    const failures = { left: 2 }
    await emitEvent(flakyDomain(domain, failures), {
      actor: PANEL_ACTOR, action: 'a.retried', now: new Date('2026-08-01T00:00:00.000Z'),
    })
    expect(failures.left).toBe(0)
    const all = await listEvents(domain)
    expect(all.map(event => event.action)).toContain('a.retried')
  })

  it('warns once after the bounded retries and never throws', async () => {
    const domain = await domainHarness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failures = { left: Number.MAX_SAFE_INTEGER }
    await expect(emitEvent(flakyDomain(domain, failures), {
      actor: PANEL_ACTOR, action: 'a.doomed',
    })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toBe('[mimir] ledger append failed after retries:')
    warn.mockRestore()
    const all = await listEvents(domain)
    expect(all.map(event => event.action)).not.toContain('a.doomed')
  })
})
