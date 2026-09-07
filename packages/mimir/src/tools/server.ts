/**
 * Model-callable tools that forward to the live `server.*` Remote namespace
 * (`ResearchService`): list remembered servers, probe one (TCP connect plus
 * best-effort ssh `nvidia-smi` GPU readout), submit a job over batch-mode
 * ssh, and list jobs. Thin forwarding only — the domain logic, its input
 * validation, and its job state stay in `services/server.ts`, so a
 * model-dispatched job shares the panel's `ServiceState` (the same job
 * counter and SSH abort handles).
 *
 * Submitting is non-blocking: `server_submit_job` returns once the queued
 * record is durable, and polling `server_list_jobs` for the status flips
 * (`queued` → `running` → `succeeded`/`failed`/`cancelled`) is the caller's
 * job — the same contract the Servers panel has. A rejected submit (unknown
 * server, empty/overlong command, TCP-only server, unknown experiment) is
 * returned as a business failure, not thrown, so the model can list servers
 * and retry.
 * @module dsh-mimir/src/tools/server
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResearchFailure, ServerRecord } from '../types.ts'
import type { ResearchService } from '../service.ts'

/**
 * Resolve the live service lazily so a tool works whether it is registered
 * before or after the plugin mounts `ResearchService` (execution always runs
 * after `apply()` settles). Injectable so tests forward a direct instance.
 */
export type ResearchServiceResolver = () => ResearchService | undefined

/** The mounted service, or a clear error when the plugin is not up. */
function requireService(getResearch: ResearchServiceResolver): ResearchService {
  const service = getResearch()
  if (service === undefined) {
    throw new Error('server_* tool: the mimir research service is not mounted')
  }
  return service
}

/**
 * Unwrap one Remote result into the tool's flat value shape, matching the
 * `figure_save` / `wiki_note` idiom: a success returns the payload directly
 * (`{ servers }`, `{ job }`, `{ jobs }`, the probe view), a rejection keeps
 * `{ ok: false, error }` so the model sees a business failure rather than a
 * thrown error and can list servers and retry.
 */
async function forward<T>(call: () => Promise<{ ok: true; value: T } | { ok: false; error: ResearchFailure }>): Promise<T | { ok: false; error: ResearchFailure }> {
  const result = await call()
  return result.ok ? result.value : { ok: false, error: result.error }
}

/** Render one tool value as model-facing text: pretty JSON (a failed shape stays a clear `failed:` line). */
function renderResult(value: JsonValue): string {
  if (typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false) {
    return `failed: ${JSON.stringify(value)}`
  }
  return JSON.stringify(value, null, 2)
}

const render = (_args: unknown, value: JsonValue): { type: 'text'; text: string }[] => [
  { type: 'text', text: renderResult(value) },
]

/** Cast a domain result (nested read-only records) to the tool's `JsonValue` canonical shape. */
function asJson<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}

/**
 * Build the `server_list` tool over one live research service.
 * @param getResearch - Lazy access to the mounted `ResearchService`.
 * @returns the registry-ready tool definition.
 */
export function createServerListTool(getResearch: ResearchServiceResolver): ToolDefinition {
  return defineTool({
    name: 'server_list',
    description: 'List every remembered compute server, most recently updated first. Each entry carries the server id (server_id), host, port, ssh login user (empty for a TCP-only record), tags, and note. Call this before promising or submitting a run so you address a real registered machine.',
    parameters: {
      detail: { type: 'boolean', description: 'Default true; false returns only server ids and names, which keeps the tool call cheap when you only need an id.' },
    },
    output: { schema: { type: 'json' }, render },
    async execute(args) {
      const result = await forward(() => requireService(getResearch).listServers())
      if (!('servers' in result)) return asJson(result)
      if (args.detail === false) {
        return asJson({
          servers: (result as { servers: readonly ServerRecord[] }).servers.map(server => ({ server_id: server.id, name: server.name })),
        })
      }
      return asJson(result)
    },
  })
}

/**
 * Build the `server_check` tool over one live research service.
 * @param getResearch - Lazy access to the mounted `ResearchService`.
 * @returns the registry-ready tool definition.
 */
export function createServerCheckTool(getResearch: ResearchServiceResolver): ToolDefinition {
  return defineTool({
    name: 'server_check',
    description: 'Probe one remembered server: a TCP connect (offline settles the view), then — when the record names an ssh login user — a best-effort ssh nvidia-smi GPU readout (its failure empties the GPU table without flipping the state). Returns the settled view: state, per-stage latencies, and the GPU table.',
    parameters: {
      server_id: { type: 'string', required: true, description: 'Id of a remembered server (see server_list).' },
    },
    output: { schema: { type: 'json' }, render },
    async execute(args) {
      return asJson(await forward(() => requireService(getResearch).checkServer({ id: args.server_id })))
    },
  })
}

/**
 * Build the `server_submit_job` tool over one live research service.
 * @param getResearch - Lazy access to the mounted `ResearchService`.
 * @returns the registry-ready tool definition.
 */
export function createServerSubmitJobTool(getResearch: ResearchServiceResolver): ToolDefinition {
  return defineTool({
    name: 'server_submit_job',
    description: 'Queue one batch-mode ssh command on a remembered server (its login shell runs the command). Non-blocking: returns the queued job record (id, server_id, command, status "queued") once durable; poll server_list_jobs for the flips to running, then succeeded/failed. A non-empty command up to 4000 characters is required; the server must name an ssh login user; an optional experiment_id links the run and flips that experiment record to running on submit, then to success/failed when the job settles. Rejections (server-not-found, invalid-input, experiment-not-found) return as a failure, not an error.',
    parameters: {
      server_id: { type: 'string', required: true, description: 'Id of a remembered ssh-capable server (see server_list).' },
      command: { type: 'string', required: true, description: 'The remote command line, executed by the server\'s login shell; at most 4000 characters.' },
      experiment_id: { type: 'string', description: 'Optional wiki experiment record to link and write the settle outcome back to.' },
    },
    output: { schema: { type: 'json' }, render },
    async execute(args) {
      return asJson(await forward(() => requireService(getResearch).submitJob({
        serverId: args.server_id,
        command: args.command,
        ...(args.experiment_id === undefined ? {} : { experimentId: args.experiment_id }),
      })))
    },
  })
}

/**
 * Build the `server_list_jobs` tool over one live research service.
 * @param getResearch - Lazy access to the mounted `ResearchService`.
 * @returns the registry-ready tool definition.
 */
export function createServerListJobsTool(getResearch: ResearchServiceResolver): ToolDefinition {
  return defineTool({
    name: 'server_list_jobs',
    description: 'List submitted remote jobs, most recently submitted first, each with its status (queued/running/succeeded/failed/cancelled/interrupted), output tails, and exit code once settled. Optionally filter to one server by server_id. Poll this after server_submit_job to learn when a run settles and whether it succeeded.',
    parameters: {
      server_id: { type: 'string', description: 'Only list jobs submitted to this server (see server_list).' },
    },
    output: { schema: { type: 'json' }, render },
    async execute(args) {
      return asJson(await forward(() => requireService(getResearch).listJobs({
        ...(args.server_id === undefined ? {} : { serverId: args.server_id }),
      })))
    },
  })
}
