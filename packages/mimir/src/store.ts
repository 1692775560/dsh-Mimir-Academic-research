/**
 * The research-wiki domain declaration: the zod schemas double as the durable
 * boundary validators, and `defineDomain` pins the domain identity. Consumers
 * open the spec through `ctx.storageDomain` (see `./index.ts`).
 * @module dsh-mimir/src/store
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { ClaimRecord, EventRecord, ExperimentRecord, FigureRecord, IdeaRecord, JobRecord, PaperRecord, ProjectRecord, ServerRecord } from './types.ts'

/** Durable shape of one remembered paper. */
export const paperRecord = z.object({
  arxivId: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  summary: z.string(),
  url: z.string(),
  notes: z.string(),
  // Added WITHOUT a version bump: `.default([])` fills both fields when a
  // stored record predates them, so existing v2 JSON stores keep loading.
  tags: z.array(z.string()).default([]),
  projectIds: z.array(z.string()).default([]),
  // Added WITHOUT a version bump: `.optional()` leaves the field absent on
  // records that predate it, so existing v2 JSON stores keep loading.
  pdfPath: z.string().optional(),
  // Added WITHOUT a version bump: `.optional()` leaves the field absent on
  // records that predate it, so existing v2 JSON stores keep loading.
  relevance: z.record(z.string(), z.object({
    score: z.number(),
    reason: z.string(),
    at: z.string(),
  })).optional(),
  addedAt: z.string(),
})

/** Durable shape of one idea, including the never-deleted failed ideas. */
export const ideaRecord = z.object({
  id: z.string(),
  title: z.string(),
  hypothesis: z.string(),
  status: z.enum(['active', 'failed', 'adopted']),
  failureReason: z.string().optional(),
  createdAt: z.string(),
})

/** Durable shape of one tracked claim. */
export const claimRecord = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(['supported', 'invalidated', 'pending']),
  evidence: z.string(),
})

/** Durable shape of one project pipeline record. */
export const projectRecord = z.object({
  id: z.string(),
  title: z.string(),
  stage: z.enum(['idea', 'plan', 'experiment', 'writing', 'done']),
  paperDir: z.string().optional(),
  // Added WITHOUT a version bump: `.optional()` leaves the field absent on
  // records that predate it, so existing v2 JSON stores keep loading.
  venue: z.object({
    /** Built-in registry id, or `custom` for an uploaded kit. */
    id: z.string(),
    name: z.string(),
    custom: z.boolean(),
    appliedAt: z.string(),
  }).optional(),
  artifacts: z.array(z.string()),
  reviewRounds: z.number().int().nonnegative(),
  updatedAt: z.string(),
})

/** Durable shape of one experiment run record. */
export const experimentRecord = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  status: z.enum(['running', 'success', 'failed']),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])),
  logPath: z.string().optional(),
  // Added WITHOUT a version bump: `.optional()` leaves the field absent on
  // records that predate it, so existing v2 JSON stores keep loading.
  serverId: z.string().optional(),
  // Added WITHOUT a version bump: `.optional()` leaves the field absent on
  // records that predate it, so existing v2 JSON stores keep loading.
  lastJob: z.object({
    jobId: z.string(),
    status: z.enum(['succeeded', 'failed']),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative().nullable(),
    finishedAt: z.string(),
    summary: z.string(),
  }).optional(),
  updatedAt: z.string(),
})

/** Durable shape of one remembered compute server. */
export const serverRecord = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  /** SSH login user; an empty string downgrades probes to TCP-only. */
  username: z.string(),
  note: z.string(),
  // Added WITHOUT a version bump: `.default([])` fills the field when a
  // stored record predates it, so existing v2 JSON stores keep loading.
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** Durable shape of one remote job submitted over ssh. */
export const jobRecord = z.object({
  id: z.string(),
  serverId: z.string(),
  command: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  experimentId: z.string().optional(),
  exitCode: z.number().int().nullable(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
})

/** Durable shape of one saved figure's metadata (the file itself stays on disk). */
export const figureRecord = z.object({
  /** Composite key: `<projectId>:<relPath>` — one metadata row per figure file. */
  id: z.string(),
  projectId: z.string(),
  /** Path relative to the project's paper directory (`figures/foo.png`). */
  relPath: z.string(),
  caption: z.string(),
  experimentId: z.string().optional(),
  /** Where the figure was copied from, when the save recorded it. */
  sourcePath: z.string().optional(),
  createdAt: z.string(),
})

/** Durable shape of one append-only ledger event (see `./ledger.ts`). */
export const eventRecord = z.object({
  id: z.string(),
  ts: z.string(),
  actor: z.object({
    kind: z.enum(['user', 'agent', 'subagent', 'module', 'system']),
    id: z.string(),
  }),
  action: z.string(),
  refs: z.object({
    projectId: z.string().optional(),
    experimentId: z.string().optional(),
    runId: z.string().optional(),
    serverId: z.string().optional(),
    jobId: z.string().optional(),
    artifactId: z.string().optional(),
    figureId: z.string().optional(),
    claimId: z.string().optional(),
    ideaId: z.string().optional(),
    paperId: z.string().optional(),
  }).default({}),
  // z.json() mirrors the `Record<string, JsonValue>` wire type: the event
  // crosses the Remote boundary via `listEvents`, where unconstrained
  // `unknown` is not representable, and the JSON check also hardens the
  // durable boundary.
  payload: z.record(z.string(), z.json()).default({}),
})

/**
 * The research wiki domain spec: nine tables, no global singleton. The spec
 * object is the single source of the domain's name, version, and schemas.
 * The `servers`, `jobs`, `figures`, and `events` tables were added WITHOUT a
 * version bump: the domain loader fills a table missing from a stored
 * snapshot with an empty map, so existing v2 JSON stores open with them
 * empty, while a bump would make the storage-json backend reject every
 * existing file (`version-mismatch`) with no migration path. `jobs` holds
 * runtime state rather than research data, so the wiki export/import
 * snapshot deliberately excludes it. `events` used to be excluded on the
 * same reasoning, but that is reversed as of snapshot v3: the ledger is the
 * CBE engine's single source of truth (every cognitive organ is a pure fold
 * over it and persists nothing), so a snapshot without it restores the
 * library and silently zeroes the researcher's whole cognitive layer.
 */
export const researchWikiDomainSpec = defineDomain({
  name: 'research_wiki',
  version: 2,
  tables: {
    papers: domainTable<string, PaperRecord>(paperRecord),
    ideas: domainTable<string, IdeaRecord>(ideaRecord),
    claims: domainTable<string, ClaimRecord>(claimRecord),
    projects: domainTable<string, ProjectRecord>(projectRecord),
    experiments: domainTable<string, ExperimentRecord>(experimentRecord),
    servers: domainTable<string, ServerRecord>(serverRecord),
    jobs: domainTable<string, JobRecord>(jobRecord),
    figures: domainTable<string, FigureRecord>(figureRecord),
    events: domainTable<string, EventRecord>(eventRecord),
  },
})

/** Opened research-wiki domain handle, typed by {@link researchWikiDomainSpec}. */
export type ResearchWikiDomain = Domain<typeof researchWikiDomainSpec>
