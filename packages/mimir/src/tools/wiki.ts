/**
 * The `wiki_note` tool: the model's single read/write surface over the
 * research-wiki domain (papers, ideas with their never-deleted failures,
 * claims, projects). One flat parameter set keyed by `action`; each action
 * validates its own required fields at execution time.
 * @module dsh-mimir/src/tools/wiki
 */

import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { emitEvent, WIKI_AGENT_ACTOR } from '../ledger.ts'
import type { ResearchWikiDomain } from '../store.ts'
import type { LedgerJsonValue } from '../types.ts'
import { isValidArxivId } from './arxiv.ts'

const ACTIONS = [
  'add_paper', 'set_paper', 'add_idea', 'fail_idea', 'add_claim', 'set_claim', 'set_project',
  'add_experiment', 'set_experiment', 'list', 'get',
] as const
const TABLES = ['papers', 'ideas', 'claims', 'projects', 'experiments'] as const
const EXPERIMENT_STATUSES = ['running', 'success', 'failed'] as const

type Action = typeof ACTIONS[number]
type TableName = typeof TABLES[number]

interface WikiArgs {
  readonly action: Action
  readonly table?: TableName
  readonly id?: string
  readonly arxiv_id?: string
  readonly title?: string
  readonly authors?: string[]
  readonly summary?: string
  readonly url?: string
  readonly notes?: string
  readonly tags?: string[]
  readonly project_ids?: string[]
  readonly relevance_score?: number
  readonly relevance_reason?: string
  readonly hypothesis?: string
  readonly reason?: string
  readonly text?: string
  readonly status?: string
  readonly evidence?: string
  readonly paper_dir?: string
  readonly project_id?: string
  readonly name?: string
  readonly metrics?: Record<string, JsonValue>
  readonly log_path?: string
}

/** Require one non-empty string field for the current action. */
function requireField(value: string | undefined, field: string, action: Action): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`wiki_note action '${action}' requires a non-empty '${field}'`)
  }
  return value
}

/** Read one table by name, failing loud on a typo the schema could not rule out. */
function tableOf(domain: ResearchWikiDomain, table: TableName) {
  return domain.table(table)
}

/** Keep only scalar metric values (the record schema admits any JsonValue). */
function metricsOf(value: Record<string, JsonValue> | undefined): Record<string, number | string> | undefined {
  if (value === undefined) return undefined
  const metrics: Record<string, number | string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' || typeof entry === 'string') metrics[key] = entry
  }
  return metrics
}

/** Validate one experiment status string. */
function requireExperimentStatus(value: string | undefined, action: Action): typeof EXPERIMENT_STATUSES[number] {
  const status = value ?? 'running'
  if (!(EXPERIMENT_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`wiki_note action '${action}' requires status running|success|failed, got '${status}'`)
  }
  return status as typeof EXPERIMENT_STATUSES[number]
}

/**
 * Append one decision-grade ledger event for an agent action. Awaited by the
 * call site so the event is durable before the tool call acknowledges — and
 * best-effort by the ledger's call-site contract: a trail failure warns and
 * is swallowed, never failing the tool call itself.
 */
async function emit(domain: ResearchWikiDomain, action: string, refs: Record<string, string | undefined>, payload: Record<string, LedgerJsonValue>): Promise<void> {
  await emitEvent(domain, { actor: WIKI_AGENT_ACTOR, action, refs, payload })
}

/** Execute one validated action against the domain. */
async function runAction(domain: ResearchWikiDomain, args: WikiArgs): Promise<JsonValue> {
  switch (args.action) {
    case 'add_paper': {
      const arxivId = requireField(args.arxiv_id, 'arxiv_id', args.action)
      // The id keys the papers table AND joins filesystem paths (cached PDF,
      // figure crops) — reject anything that could escape a directory join.
      if (!isValidArxivId(arxivId)) {
        throw new Error(`wiki_note action 'add_paper' got an unsafe arxiv_id '${arxivId}'`)
      }
      const existing = domain.table('papers').get(arxivId)
      const record = {
        arxivId,
        title: requireField(args.title, 'title', args.action),
        authors: args.authors ?? [],
        summary: requireField(args.summary, 'summary', args.action),
        url: args.url ?? `https://arxiv.org/abs/${arxivId}`,
        // An agent-driven re-add must not wipe workbench-curated fields.
        notes: args.notes ?? existing?.notes ?? '',
        tags: [...(existing?.tags ?? [])],
        projectIds: [...(existing?.projectIds ?? [])],
        ...(existing?.relevance === undefined ? {} : { relevance: existing.relevance }),
        addedAt: new Date().toISOString(),
      }
      await domain.table('papers').put(arxivId, record)
      await emit(domain, 'literature.paper.imported', { paperId: arxivId }, { title: record.title, imported: existing === undefined })
      return { ok: true, table: 'papers', id: arxivId, record: record as unknown as JsonValue }
    }
    case 'set_paper': {
      const arxivId = requireField(args.arxiv_id, 'arxiv_id', args.action)
      const table = domain.table('papers')
      const existing = table.get(arxivId)
      if (existing === undefined) throw new Error(`wiki_note: no paper with id '${arxivId}'`)
      let projectIds = [...(args.project_ids ?? existing.projectIds)]
      let relevance = existing.relevance
      if (args.relevance_score !== undefined) {
        const projectId = requireField(args.project_id, 'project_id', args.action)
        if (domain.table('projects').get(projectId) === undefined) {
          throw new Error(`wiki_note: no project with id '${projectId}'`)
        }
        if (!Number.isFinite(args.relevance_score) || args.relevance_score < 0 || args.relevance_score > 10) {
          throw new Error(`wiki_note action 'set_paper' requires relevance_score between 0 and 10, got '${args.relevance_score}'`)
        }
        const reason = requireField(args.relevance_reason, 'relevance_reason', args.action)
        relevance = {
          ...relevance,
          [projectId]: { score: args.relevance_score, reason, at: new Date().toISOString() },
        }
        // Scoring a paper against a project implies the link.
        if (!projectIds.includes(projectId)) projectIds = [...projectIds, projectId]
      }
      for (const projectId of projectIds) {
        if (domain.table('projects').get(projectId) === undefined) {
          throw new Error(`wiki_note: no project with id '${projectId}'`)
        }
      }
      const record = {
        ...existing,
        notes: args.notes ?? existing.notes,
        tags: args.tags === undefined
          ? existing.tags
          : [...new Set(args.tags.map(tag => tag.trim()).filter(tag => tag !== ''))],
        projectIds,
        ...(relevance === undefined ? {} : { relevance }),
      }
      await table.put(arxivId, record)
      return { ok: true, table: 'papers', id: arxivId, record: record as unknown as JsonValue }
    }
    case 'add_idea': {
      const id = randomUUID()
      const projectId = args.project_id
      if (projectId !== undefined && domain.table('projects').get(projectId) === undefined) {
        throw new Error(`wiki_note: no project with id '${projectId}'`)
      }
      // An idea registered into a project is auto-adopted (status `adopted`)
      // at creation — it is already part of that project's research process,
      // so the worktree and brief surface it without a separate manual merge.
      // A standalone idea stays `active` for the user to adopt later.
      const status: 'active' | 'adopted' = projectId !== undefined ? 'adopted' : 'active'
      const record = {
        id,
        title: requireField(args.title, 'title', args.action),
        hypothesis: requireField(args.hypothesis, 'hypothesis', args.action),
        status,
        projectId: projectId ?? undefined,
        createdAt: new Date().toISOString(),
      }
      await domain.table('ideas').put(id, record)
      if (projectId !== undefined) {
        await emit(domain, 'knowledge.idea.adopted', { ideaId: id, projectId }, { title: record.title })
      } else {
        await emit(domain, 'knowledge.idea.added', { ideaId: id }, { title: record.title })
      }
      return { ok: true, table: 'ideas', id, record: record as unknown as JsonValue }
    }
    case 'fail_idea': {
      const id = requireField(args.id, 'id', args.action)
      const reason = requireField(args.reason, 'reason', args.action)
      if (domain.table('ideas').get(id) === undefined) {
        throw new Error(`wiki_note: no idea with id '${id}'`)
      }
      await domain.table('ideas').update(id, current => ({ ...current, status: 'failed' as const, failureReason: reason }))
      await emit(domain, 'knowledge.idea.failed', { ideaId: id }, { reason })
      return { ok: true, table: 'ideas', id, status: 'failed' }
    }
    case 'add_claim': {
      const id = randomUUID()
      const record = {
        id,
        text: requireField(args.text, 'text', args.action),
        status: 'pending' as const,
        evidence: args.evidence ?? '',
      }
      await domain.table('claims').put(id, record)
      await emit(domain, 'knowledge.claim.added', { claimId: id }, { text: record.text, evidence: record.evidence })
      return { ok: true, table: 'claims', id, record: record as unknown as JsonValue }
    }
    case 'set_claim': {
      const id = requireField(args.id, 'id', args.action)
      const status = requireField(args.status, 'status', args.action)
      if (status !== 'supported' && status !== 'invalidated' && status !== 'pending') {
        throw new Error(`wiki_note action 'set_claim' requires status supported|invalidated|pending, got '${status}'`)
      }
      if (domain.table('claims').get(id) === undefined) {
        throw new Error(`wiki_note: no claim with id '${id}'`)
      }
      await domain.table('claims').update(id, current => ({
        ...current,
        status,
        evidence: args.evidence ?? current.evidence,
      }))
      await emit(domain, 'knowledge.claim.set', { claimId: id }, { status, evidence: args.evidence ?? null })
      return { ok: true, table: 'claims', id, status }
    }
    case 'set_project': {
      const id = requireField(args.id, 'id', args.action)
      const paperDir = requireField(args.paper_dir, 'paper_dir', args.action)
      if (domain.table('projects').get(id) === undefined) {
        throw new Error(`wiki_note: no project with id '${id}'`)
      }
      await domain.table('projects').update(id, current => ({
        ...current,
        paperDir,
        updatedAt: new Date().toISOString(),
      }))
      await emit(domain, 'knowledge.project.paperdir', { projectId: id }, { paperDir })
      return { ok: true, table: 'projects', id, paperDir }
    }
    case 'add_experiment': {
      const projectId = requireField(args.project_id, 'project_id', args.action)
      if (domain.table('projects').get(projectId) === undefined) {
        throw new Error(`wiki_note: no project with id '${projectId}'`)
      }
      const id = randomUUID()
      const record = {
        id,
        projectId,
        name: requireField(args.name, 'name', args.action),
        status: requireExperimentStatus(args.status, args.action),
        metrics: metricsOf(args.metrics) ?? {},
        ...(args.log_path === undefined ? {} : { logPath: args.log_path }),
        updatedAt: new Date().toISOString(),
      }
      await domain.table('experiments').put(id, record)
      await emit(domain, 'experiments.saved', { experimentId: id, projectId }, {
        name: record.name, status: record.status, created: true, metricCount: Object.keys(record.metrics).length,
      })
      return { ok: true, table: 'experiments', id, record: record as unknown as JsonValue }
    }
    case 'set_experiment': {
      const id = requireField(args.id, 'id', args.action)
      const current = domain.table('experiments').get(id)
      if (current === undefined) {
        throw new Error(`wiki_note: no experiment with id '${id}'`)
      }
      const metrics = metricsOf(args.metrics)
      await domain.table('experiments').update(id, record => ({
        ...record,
        ...(args.name === undefined ? {} : { name: args.name }),
        ...(args.status === undefined ? {} : { status: requireExperimentStatus(args.status, args.action) }),
        ...(metrics === undefined ? {} : { metrics }),
        ...(args.log_path === undefined ? {} : { logPath: args.log_path }),
        updatedAt: new Date().toISOString(),
      }))
      await emit(domain, 'experiments.saved', { experimentId: id, projectId: current.projectId }, {
        name: args.name ?? current.name, status: args.status ?? 'updated', created: false,
      })
      return { ok: true, table: 'experiments', id, status: args.status ?? 'updated' }
    }
    case 'list': {
      const table = args.table
      if (table === undefined) {
        const counts = Object.fromEntries(TABLES.map(name => [name, domain.table(name).size]))
        return { ok: true, counts: counts as unknown as JsonValue }
      }
      const entries = Object.fromEntries(tableOf(domain, table).entries())
      return { ok: true, table, records: entries as unknown as JsonValue }
    }
    case 'get': {
      const table = requireField(args.table, 'table', args.action) as TableName
      if (!TABLES.includes(table)) {
        throw new Error(`wiki_note action 'get' requires table to be one of ${TABLES.join('|')}, got '${table}'`)
      }
      const id = requireField(args.id, 'id', args.action)
      const record = tableOf(domain, table).get(id)
      if (record === undefined) throw new Error(`wiki_note: no record '${id}' in table '${table}'`)
      return { ok: true, table, id, record: record as unknown as JsonValue }
    }
  }
}

/** Render one action outcome as model-facing text. */
function renderOutcome(value: Record<string, JsonValue | undefined>): string {
  const ok = value['ok'] === true
  if (!ok) return JSON.stringify(value)
  const table = typeof value['table'] === 'string' ? value['table'] : ''
  const id = typeof value['id'] === 'string' ? value['id'] : ''
  if (value['counts'] !== undefined) {
    return `Wiki tables: ${Object.entries(value['counts'] as Record<string, number>).map(([name, size]) => `${name}=${size}`).join(', ')}`
  }
  if (value['records'] !== undefined) {
    const records = value['records'] as Record<string, JsonValue>
    return `${records.length === 0 ? 'No records' : `${Object.keys(records).length} record(s)`} in '${table}'.\n${JSON.stringify(records, null, 2)}`
  }
  if (value['record'] !== undefined) {
    return `${table} '${id}' written.\n${JSON.stringify(value['record'], null, 2)}`
  }
  return `Wiki updated: ${table} '${id}'${typeof value['status'] === 'string' ? ` → ${value['status']}` : ''}.`
}

/**
 * Build the `wiki_note` tool over one opened research-wiki domain.
 * @param domain - The plugin-owned open domain handle.
 * @returns the registry-ready tool definition.
 */
export function createWikiNoteTool(domain: ResearchWikiDomain): ToolDefinition {
  return defineTool({
    name: 'wiki_note',
    description: 'Read and write the persistent research wiki: remembered papers (add_paper; set_paper updates notes/tags/project links and records a 0-10 relevance score against a project), ideas including never-deleted failed ones (add_idea, fail_idea), tracked claims (add_claim, set_claim), project records (set_project points a project at its paper directory), and experiment runs (add_experiment, set_experiment); list and get read any table. Always check the ideas table before proposing work, to avoid re-proving failed directions. Save useful papers you find with add_paper, record every experiment run with add_experiment/set_experiment, and call figure_save right after generating a paper-worthy image — the workbench only shows what the wiki remembers.',
    parameters: {
      action: { type: 'string', enum: ACTIONS, required: true, description: 'The wiki operation to perform.' },
      table: { type: 'string', enum: TABLES, description: 'Table for list/get (papers|ideas|claims|projects|experiments).' },
      id: { type: 'string', description: 'Record id for fail_idea/set_claim/set_project/set_experiment/get.' },
      arxiv_id: { type: 'string', description: 'arXiv id for add_paper.' },
      title: { type: 'string', description: 'Title for add_paper/add_idea.' },
      authors: { type: 'array', items: { type: 'string' }, description: 'Author names for add_paper.' },
      summary: { type: 'string', description: 'Abstract for add_paper.' },
      url: { type: 'string', description: 'URL for add_paper; defaults to the arXiv abstract page.' },
      notes: { type: 'string', description: 'Working notes for add_paper/set_paper.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tag list for set_paper.' },
      project_ids: { type: 'array', items: { type: 'string' }, description: 'Replacement project-link list for set_paper.' },
      relevance_score: { type: 'number', description: '0-10 relevance score for set_paper (requires project_id and relevance_reason); also links the paper to that project.' },
      relevance_reason: { type: 'string', description: 'One-paragraph justification of relevance_score for set_paper.' },
      hypothesis: { type: 'string', description: 'Hypothesis for add_idea.' },
      reason: { type: 'string', description: 'Why the idea failed, for fail_idea.' },
      text: { type: 'string', description: 'Claim text for add_claim.' },
      status: { type: 'string', description: 'New status for set_claim (supported|invalidated|pending) or add_experiment/set_experiment (running|success|failed).' },
      evidence: { type: 'string', description: 'Evidence pointer for add_claim/set_claim.' },
      paper_dir: { type: 'string', description: "Paper directory for set_project, relative to the research workspace (default 'paper')." },
      project_id: { type: 'string', description: 'Owning project id for add_experiment; for add_idea it registers the idea into that project and auto-adopts it into the worktree (omit it to keep the idea standalone and active).' },
      name: { type: 'string', description: 'Experiment name for add_experiment/set_experiment.' },
      metrics: { type: 'object', additionalProperties: true, description: 'Scalar metrics for add_experiment/set_experiment (string/number values).' },
      log_path: { type: 'string', description: 'Log path relative to the workspace for add_experiment/set_experiment.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value as Record<string, JsonValue | undefined>) }],
    },
    execute: (args, _exec) => runAction(domain, args),
  })
}
