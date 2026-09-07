/**
 * Server domain module: remembered compute servers CRUD, the two-stage
 * checkServer probe (TCP then best-effort ssh GPU readout), and the remote
 * job lifecycle (submitJob queues and drives a job over batch-mode ssh in
 * the background; the panel polls listJobs for the flips). The job counter
 * lives on an explicit `ServiceState`. Thin forwarding of the `server.*`
 * Remote namespace lives in `service.ts`.
 * @module dsh-mimir/src/services/server
 */

import { execFile } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { emitEvent, PANEL_ACTOR, SERVICE_ACTOR } from '../ledger.ts'
import type { ResearchWikiDomain } from '../store.ts'
import type {
  ExperimentJobOutcome,
  ExperimentStatus,
  JobRecord,
  ResearchCheckServerResult,
  ResearchDeleteJobResult,
  ResearchDeleteServerResult,
  ResearchListJobsResult,
  ResearchListServersResult,
  ResearchSaveServerResult,
  ResearchSubmitJobResult,
  ServerGpuView,
  ServerInput,
  ServerRecord,
  ServerStatusView,
} from '../types.ts'
import { rejected, success } from './common.ts'
import type { ServiceState } from './common.ts'

/** Everything the Server domain functions need from the service scope. */
export interface ServerDeps {
  /** Absolute research workspace root (for the settled-job experiment log append). */
  readonly workspaceDir: string
  readonly domain: ResearchWikiDomain
}

/** TCP reachability probe timeout; part of the checkServer probe contract. */
const TCP_PROBE_TIMEOUT_MS = 4000
/** Timeout of the best-effort ssh `nvidia-smi` readout. */
const GPU_PROBE_TIMEOUT_MS = 8000
/** Connect timeout handed to the ssh client itself. */
const GPU_PROBE_SSH_CONNECT_TIMEOUT_S = 5
/** The remote command whose CSV output feeds the GPU table. */
const NVIDIA_SMI_QUERY = 'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits'

/** Hard cap of one submitted command line (the durable record stores it verbatim). */
const JOB_COMMAND_MAX_CHARS = 4000
/** Kill timeout of one remote job's ssh session. */
const SSH_JOB_TIMEOUT_MS = 30 * 60_000
/** execFile buffer cap of one job's combined stdout/stderr. */
const SSH_JOB_MAX_BUFFER_BYTES = 4 * 1024 * 1024
/** Characters kept of one settled job's stdout/stderr tails. */
const JOB_OUTPUT_TAIL_CHARS = 8192

const execFileAsync = promisify(execFile)

/** Keep the trailing window of one job output stream. */
function tailOf(text: string): string {
  return text.length <= JOB_OUTPUT_TAIL_CHARS ? text : text.slice(text.length - JOB_OUTPUT_TAIL_CHARS)
}

/** Outcome of one TCP reachability probe. */
type TcpProbeOutcome =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly message: string }

/**
 * Connect to `host:port` once, measuring the handshake latency. The probe
 * never throws: every failure mode (refused, unreachable, timed out) settles
 * as the `ok: false` branch carrying the socket's own message.
 * @param host - server host name or address.
 * @param port - server TCP port.
 * @returns the connected latency, or the failure message.
 */
function probeTcp(host: string, port: number): Promise<TcpProbeOutcome> {
  return new Promise<TcpProbeOutcome>((settle) => {
    const startedAt = Date.now()
    let done = false
    const socket = connect({ host, port })
    const finish = (outcome: TcpProbeOutcome): void => {
      if (done) return
      done = true
      socket.destroy()
      settle(outcome)
    }
    socket.once('connect', () => { finish({ ok: true, latencyMs: Date.now() - startedAt }) })
    socket.once('error', (error) => { finish({ ok: false, message: error.message }) })
    socket.setTimeout(TCP_PROBE_TIMEOUT_MS, () => {
      finish({ ok: false, message: `tcp connect timed out after ${String(TCP_PROBE_TIMEOUT_MS)}ms` })
    })
  })
}

/** Outcome of the best-effort GPU readout over ssh. */
type GpuProbeOutcome =
  | { readonly ok: true; readonly gpus: readonly ServerGpuView[] }
  | { readonly ok: false; readonly stage: 'ssh' | 'gpu'; readonly message: string }

/**
 * Read one server's GPU table over a batch-mode ssh call. Best-effort: an ssh
 * or `nvidia-smi` failure is the `ok: false` branch, never a rejection, so the
 * caller can still report the server itself as reachable.
 * @param record - the server to probe (host, port, and login user).
 * @returns the parsed GPU rows, or the failure stage (`ssh` session vs `gpu`
 * readout) plus the failure message.
 */
async function probeGpus(record: ServerRecord): Promise<GpuProbeOutcome> {
  try {
    const { stdout } = await execFileAsync('ssh', [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${String(GPU_PROBE_SSH_CONNECT_TIMEOUT_S)}`,
      '-p', String(record.port),
      // `--` ends option parsing: a stored record predating input validation
      // can never turn the login target into an ssh flag.
      '--',
      `${record.username}@${record.host}`,
      NVIDIA_SMI_QUERY,
    ], { timeout: GPU_PROBE_TIMEOUT_MS })
    const gpus: ServerGpuView[] = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const [name, utilizationPct, memoryUsedMb, memoryTotalMb] = trimmed.split(',').map(field => field.trim())
      gpus.push({
        name: name ?? '',
        utilizationPct: Number(utilizationPct),
        memoryUsedMb: Number(memoryUsedMb),
        memoryTotalMb: Number(memoryTotalMb),
      })
    }
    return { ok: true, gpus: Object.freeze(gpus) }
  } catch (error) {
    // execFile failures carry the child's stderr; prefer it over the generic
    // "Command failed" wrapper so the panel shows the ssh client's own words.
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error
      ? String((error as { stderr: unknown }).stderr).trim()
      : ''
    const message = stderr !== '' ? stderr : error instanceof Error ? error.message : 'ssh probe failed'
    // Stage classification: the ssh client exits 255 when the SESSION itself
    // failed (connect, auth, or the connect timeout); any other exit code is
    // the remote command's own status, and a timeout kill / spawn error only
    // surfaces after the 8s budget — past the 5s connect window — so both
    // land on the `gpu` stage.
    const code = (error as { code?: unknown }).code
    return { ok: false, stage: code === 255 ? 'ssh' : 'gpu', message }
  }
}

/**
 * Character whitelist for the ssh login user / host: anything else
 * (whitespace, shell punctuation) is rejected, and a leading dash would make
 * the `user@host` argument look like an ssh option even under execFile.
 */
const SSH_TOKEN_RE = /^[a-zA-Z0-9._:-]+$/
const SSH_USERNAME_RE = /^[a-zA-Z0-9._-]+$/

/** First invalid-input message for one server upsert payload, or null when valid. */
function validateServerInput(input: ServerInput): string | null {
  if (input.name.trim().length === 0) return 'name must be non-empty'
  if (input.host.trim().length === 0) return 'host must be non-empty'
  if (input.host.startsWith('-') || !SSH_TOKEN_RE.test(input.host)) {
    return 'host must be a plain hostname or IP (letters, digits, dots, dashes, colons)'
  }
  if (input.username !== undefined && input.username.trim() !== ''
    && (input.username.startsWith('-') || !SSH_USERNAME_RE.test(input.username))) {
    return 'username must be a plain ssh login user (letters, digits, dots, dashes, underscores)'
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return 'port must be an integer between 1 and 65535'
  }
  return null
}

/**
 * List every remembered compute server, most recently updated first.
 * @param deps - open wiki domain.
 * @returns the server cards for the panel's servers view.
 */
export function listServers(deps: ServerDeps): Promise<ResearchListServersResult> {
  const servers = [...deps.domain.table('servers').entries()]
    .map(([, record]) => record)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return Promise.resolve(success({ servers: Object.freeze(servers) }))
}

/**
 * Upsert one compute server. An `id` in the payload selects the update form
 * (the existing record's `createdAt` survives; `updatedAt` refreshes); its
 * absence creates a record with a generated id. Name and host must be
 * non-empty and the port a valid TCP port — violations are `invalid-input`,
 * an unknown update id is `server-not-found`. A present `tags` list is
 * trimmed, emptied out, and deduped before it replaces the record's tags;
 * an omitted list keeps them.
 * @param deps - open wiki domain.
 * @param request - the server fields, with `id` marking the update form.
 * @returns the stored record.
 */
export async function saveServer(
  deps: ServerDeps,
  request: { server: ServerInput },
): Promise<ResearchSaveServerResult> {
  const input = request.server
  const invalid = validateServerInput(input)
  if (invalid !== null) return rejected({ code: 'invalid-input', message: invalid })
  const table = deps.domain.table('servers')
  const now = new Date().toISOString()
  // Tags are trimmed, emptied out, and deduped (the updatePaper cleaning).
  const tags = input.tags === undefined
    ? undefined
    : [...new Set(input.tags.map(tag => tag.trim()).filter(tag => tag !== ''))]
  if (input.id !== undefined) {
    const existing = table.get(input.id)
    if (existing === undefined) return rejected({ code: 'server-not-found', id: input.id })
    const next: ServerRecord = {
      ...existing,
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      note: input.note,
      tags: tags ?? existing.tags,
      updatedAt: now,
    }
    await table.put(input.id, next)
    await emitEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: 'compute.server.saved',
      refs: { serverId: next.id },
      payload: { name: next.name, host: next.host, created: false },
    })
    return success({ server: next })
  }
  const created: ServerRecord = {
    id: `srv-${Date.now().toString(36)}`,
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    note: input.note,
    tags: tags ?? [],
    createdAt: now,
    updatedAt: now,
  }
  await table.put(created.id, created)
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'compute.server.saved',
    refs: { serverId: created.id },
    payload: { name: created.name, host: created.host, created: true },
  })
  return success({ server: created })
}

/**
 * Delete one remembered server; an unknown id is `server-not-found`.
 * @param deps - open wiki domain.
 * @param request - the record id.
 * @returns the deleted id.
 */
export async function deleteServer(
  deps: ServerDeps,
  request: { id: string },
): Promise<ResearchDeleteServerResult> {
  const table = deps.domain.table('servers')
  const removed = table.get(request.id)
  if (removed === undefined) {
    return rejected({ code: 'server-not-found', id: request.id })
  }
  await table.delete(request.id)
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'compute.server.deleted',
    refs: { serverId: removed.id },
    payload: { name: removed.name, destructive: true },
  })
  return success({ id: request.id })
}

/**
 * Probe one remembered server. The probe is two best-effort stages: a TCP
 * connect (failure settles the view `offline`), then — only when the TCP
 * probe connected and the record names a login user — a batch-mode ssh
 * `nvidia-smi` readout whose failure downgrades the GPU table to empty
 * without flipping the state. The settled view reports the stage where the
 * probe stopped (`stage`: the failed stage on failure, the deepest completed
 * stage on success) and the per-stage latencies (`tcpLatencyMs`,
 * `gpuLatencyMs`) so the panel can say which stage hung or failed.
 * @param deps - open wiki domain.
 * @param request - the record id; an unknown id is `server-not-found`.
 * @returns the settled probe view.
 */
export async function checkServer(
  deps: ServerDeps,
  request: { id: string },
): Promise<ResearchCheckServerResult> {
  const record = deps.domain.table('servers').get(request.id)
  if (record === undefined) {
    return rejected({ code: 'server-not-found', id: request.id })
  }
  const tcp = await probeTcp(record.host, record.port)
  if (!tcp.ok) {
    return success<ServerStatusView>({
      state: 'offline',
      latencyMs: null,
      gpus: Object.freeze([]),
      checkedAt: new Date().toISOString(),
      message: tcp.message,
      stage: 'tcp',
    })
  }
  if (record.username === '') {
    return success<ServerStatusView>({
      state: 'online',
      latencyMs: tcp.latencyMs,
      gpus: Object.freeze([]),
      checkedAt: new Date().toISOString(),
      message: null,
      stage: 'tcp',
      tcpLatencyMs: tcp.latencyMs,
    })
  }
  const gpuStartedAt = Date.now()
  const gpu = await probeGpus(record)
  return success<ServerStatusView>({
    state: 'online',
    latencyMs: tcp.latencyMs,
    gpus: gpu.ok ? gpu.gpus : Object.freeze([]),
    checkedAt: new Date().toISOString(),
    message: gpu.ok ? null : `gpu probe failed: ${gpu.message}`,
    stage: gpu.ok ? 'gpu' : gpu.stage,
    tcpLatencyMs: tcp.latencyMs,
    gpuLatencyMs: Date.now() - gpuStartedAt,
  })
}

/**
 * Settle every job left active by a host restart. The SSH child belongs to the
 * old process, so its remote outcome is unknowable and must never be guessed.
 * @param deps - open wiki domain plus workspace root.
 */
export async function recoverInterruptedJobs(deps: ServerDeps): Promise<void> {
  const jobs = deps.domain.table('jobs')
  const experiments = deps.domain.table('experiments')
  const now = new Date().toISOString()
  for (const [, job] of jobs.entries()) {
    if (job.status !== 'queued' && job.status !== 'running') continue
    const recovered: JobRecord = {
      ...job,
      status: 'interrupted',
      stderrTail: 'host restarted before the job outcome was known',
      finishedAt: now,
    }
    await jobs.put(job.id, recovered)
    if (job.experimentId === undefined || hasNewerLinkedJob(deps, job)) continue
    const experiment = experiments.get(job.experimentId)
    if (experiment?.status === 'running') {
      await experiments.put(experiment.id, { ...experiment, status: 'failed', updatedAt: now })
    }
  }
}

/**
 * Submit one remote command to a remembered server. The record lands
 * `queued` and the run starts in the background: this call returns once
 * the record is durable, and the panel polls `listJobs` for the status
 * flips (`running`, then `succeeded`/`failed`). The command must be
 * non-empty and at most {@link JOB_COMMAND_MAX_CHARS} characters
 * (`invalid-input`), and the server must name an ssh login user (a
 * TCP-only record cannot run jobs). A given `experimentId` must name an
 * experiment record (`experiment-not-found`): a linked experiment flips
 * to `running` with the server link on submit, then to
 * `success`/`failed` when the job settles — unless a newer job linked to
 * the same experiment supersedes the settle.
 * @param deps - open wiki domain.
 * @param state - the service's mutable job counter (incremented here).
 * @param request - the target server, the command line, and the optional
 * experiment link.
 * @returns the queued record.
 */
export async function submitJob(
  deps: ServerDeps,
  state: ServiceState,
  request: {
    serverId: string
    command: string
    experimentId?: string | undefined
  },
): Promise<ResearchSubmitJobResult> {
  const server = deps.domain.table('servers').get(request.serverId)
  if (server === undefined) {
    return rejected({ code: 'server-not-found', id: request.serverId })
  }
  const command = request.command.trim()
  if (command === '') return rejected({ code: 'invalid-input', message: 'command must be non-empty' })
  if (command.length > JOB_COMMAND_MAX_CHARS) {
    return rejected({ code: 'invalid-input', message: `command must be at most ${String(JOB_COMMAND_MAX_CHARS)} characters` })
  }
  if (server.username === '') {
    return rejected({ code: 'invalid-input', message: `server ${server.name} has no ssh login user` })
  }
  if (request.experimentId !== undefined
    && deps.domain.table('experiments').get(request.experimentId) === undefined) {
    return rejected({ code: 'experiment-not-found', id: request.experimentId })
  }
  state.jobSeq += 1
  const job: JobRecord = {
    id: `job-${Date.now().toString(36)}-${String(state.jobSeq)}`,
    serverId: server.id,
    command,
    status: 'queued',
    // Absent, never `undefined`: an explicit undefined key would pollute the
    // stored record and trip the gateway's JSON boundary validation.
    ...(request.experimentId === undefined ? {} : { experimentId: request.experimentId }),
    exitCode: null,
    stdoutTail: '',
    stderrTail: '',
    createdAt: new Date().toISOString(),
  }
  await deps.domain.table('jobs').put(job.id, job)
  if (request.experimentId !== undefined) {
    await markExperiment(deps, request.experimentId, 'running', server.id)
  }
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'compute.job.submitted',
    refs: {
      jobId: job.id,
      serverId: server.id,
      ...(request.experimentId === undefined ? {} : { experimentId: request.experimentId }),
    },
    payload: { command: command.slice(0, 200) },
  })
  // Register ownership before yielding so deletion can cancel the queued race.
  const abort = new AbortController()
  state.jobAborts.set(job.id, abort)
  void runJob(deps, state, job.id, abort.signal)
  return success({ job })
}

/**
 * List submitted remote jobs, most recently submitted first, optionally
 * filtered to one server (an unknown id is `server-not-found`). This is
 * the panel's polling read.
 * @param deps - open wiki domain.
 * @param request - the optional server filter.
 * @returns the job rows.
 */
export function listJobs(
  deps: ServerDeps,
  request: { serverId?: string },
): Promise<ResearchListJobsResult> {
  if (request.serverId !== undefined
    && deps.domain.table('servers').get(request.serverId) === undefined) {
    return Promise.resolve(rejected({ code: 'server-not-found', id: request.serverId }))
  }
  const jobs = [...deps.domain.table('jobs').entries()]
    .map(([, record]) => record)
    .filter(record => request.serverId === undefined || record.serverId === request.serverId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return Promise.resolve(success({ jobs: Object.freeze(jobs) }))
}

/**
 * Delete one terminal job record. Deleting an active job instead aborts the
 * locally-owned SSH client and retains a `cancelled` record because the remote
 * process outcome cannot be proven from a disconnected session.
 * @param deps - open wiki domain.
 * @param state - owning service state and SSH abort handles.
 * @param request - the record id.
 * @returns the affected id.
 */
export async function deleteJob(
  deps: ServerDeps,
  state: ServiceState,
  request: { id: string },
): Promise<ResearchDeleteJobResult> {
  const table = deps.domain.table('jobs')
  const existing = table.get(request.id)
  if (existing === undefined) {
    return rejected({ code: 'job-not-found', id: request.id })
  }
  const abort = state.jobAborts.get(request.id)
  if (abort !== undefined && (existing.status === 'queued' || existing.status === 'running')) {
    abort.abort()
    return success({ id: request.id })
  }
  await table.delete(request.id)
  return success({ id: request.id })
}

/**
 * Drive one queued job to its terminal state over a batch-mode ssh call:
 * flip the record `running`, wait on the remote command (killed after
 * {@link SSH_JOB_TIMEOUT_MS} or when the caller aborts), then settle
 * `succeeded` (exit 0), `failed` with the output tails, or `cancelled`
 * when the local session was aborted. Never rejects — the record is the
 * panel's only channel.
 * @param deps - open wiki domain.
 * @param state - owning service state and SSH abort handles.
 * @param id - the job record id.
 * @param signal - abort handle whose abort cancels the SSH child.
 */
async function runJob(
  deps: ServerDeps,
  state: ServiceState,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  const table = deps.domain.table('jobs')
  const queued = table.get(id)
  if (queued === undefined) {
    state.jobAborts.delete(id)
    return
  }
  if (signal.aborted) {
    await settleCancelledJob(deps, state, queued)
    return
  }
  const server = deps.domain.table('servers').get(queued.serverId)
  if (server === undefined) {
    await table.put(id, {
      ...queued,
      status: 'failed',
      stderrTail: 'server record deleted before the job started',
      finishedAt: new Date().toISOString(),
    })
    return
  }
  const running: JobRecord = { ...queued, status: 'running', startedAt: new Date().toISOString() }
  await table.put(id, running)
  if (signal.aborted) {
    await settleCancelledJob(deps, state, running)
    return
  }
  let settled: JobRecord
  try {
    const { stdout, stderr } = await execFileAsync('ssh', [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${String(GPU_PROBE_SSH_CONNECT_TIMEOUT_S)}`,
      '-p', String(server.port),
      '--',
      `${server.username}@${server.host}`,
      running.command,
    ], {
      timeout: SSH_JOB_TIMEOUT_MS,
      maxBuffer: SSH_JOB_MAX_BUFFER_BYTES,
      signal,
    })
    settled = {
      ...running, status: 'succeeded', exitCode: 0,
      stdoutTail: tailOf(stdout), stderrTail: tailOf(stderr),
      finishedAt: new Date().toISOString(),
    }
  } catch (error) {
    if (signal.aborted) {
      await settleCancelledJob(deps, state, running, error)
      return
    }
    // execFile failures carry the child's exit code and captured output;
    // the ssh client propagates the remote command's exit code as its
    // own, so a numeric code IS the remote exit code. A non-numeric code
    // means the session itself failed (connect refused, spawn error, or
    // the timeout kill) — then the message stands in for stderr.
    const carrier = error as { code?: unknown; stdout?: unknown; stderr?: unknown }
    const exitCode = typeof carrier.code === 'number' ? carrier.code : null
    const stdout = typeof carrier.stdout === 'string' ? carrier.stdout : ''
    const stderr = typeof carrier.stderr === 'string' && carrier.stderr.trim() !== ''
      ? carrier.stderr
      : error instanceof Error ? error.message : 'ssh job failed'
    settled = {
      ...running, status: 'failed', exitCode,
      stdoutTail: tailOf(stdout), stderrTail: tailOf(stderr),
      finishedAt: new Date().toISOString(),
    }
  }
  // A delete during the run already dropped the record: the remote
  // command still finished, but nothing is written back.
  if (table.get(id) === undefined) return
  await table.put(id, settled)
  state.jobAborts.delete(id)
  const startedMs = settled.startedAt === undefined ? null : Date.parse(settled.startedAt)
  const finishedMs = settled.finishedAt === undefined ? null : Date.parse(settled.finishedAt)
  await emitEvent(deps.domain, {
    actor: SERVICE_ACTOR,
    action: 'compute.job.settled',
    refs: {
      jobId: settled.id,
      serverId: settled.serverId,
      ...(settled.experimentId === undefined ? {} : { experimentId: settled.experimentId }),
    },
    payload: {
      status: settled.status,
      exitCode: settled.exitCode,
      durationMs: startedMs !== null && finishedMs !== null
        && Number.isFinite(startedMs) && Number.isFinite(finishedMs)
        ? Math.max(0, finishedMs - startedMs)
        : null,
      summary: jobSummaryOf(settled),
    },
  })
  await writeBackExperiment(deps, settled)
}

async function settleCancelledJob(
  deps: ServerDeps,
  state: ServiceState,
  job: JobRecord,
  error?: unknown,
): Promise<void> {
  const table = deps.domain.table('jobs')
  if (table.get(job.id) === undefined) return
  const carrier = error as { stdout?: unknown; stderr?: unknown } | undefined
  const stdout = typeof carrier?.stdout === 'string' ? carrier.stdout : ''
  const stderr = typeof carrier?.stderr === 'string' && carrier.stderr.trim() !== ''
    ? `${carrier.stderr}\ncancelled locally; remote process outcome is unknown`
    : 'cancelled locally; remote process outcome is unknown'
  const settled: JobRecord = {
    ...job,
    status: 'cancelled',
    exitCode: null,
    stdoutTail: tailOf(stdout),
    stderrTail: tailOf(stderr),
    finishedAt: new Date().toISOString(),
  }
  await table.put(job.id, settled)
  state.jobAborts.delete(job.id)
  await writeBackExperiment(deps, settled)
}

/**
 * Write one settled job's outcome back to its linked experiment: flip the
 * lifecycle status (`succeeded` → `success`, otherwise `failed`), record
 * the outcome (exit code, wall-clock duration, finished timestamp,
 * trailing log excerpt) as the record's `lastJob`, and append one line to
 * the workspace's `EXPERIMENT_LOG.md`. An unlinked or deleted experiment
 * is skipped; the log append is best-effort and never fails the settle.
 *
 * Stale-settle guard: when a NEWER job is linked to the same experiment
 * (submitted after this one, in any status), that job owns the
 * experiment's state, so this late settle leaves the record untouched and
 * only lands in the log — otherwise an old job finishing last would flip
 * the status back over the newer job's write-back.
 * @param deps - open wiki domain plus workspace root.
 * @param job - the settled job record.
 */
async function writeBackExperiment(deps: ServerDeps, job: JobRecord): Promise<void> {
  if (job.experimentId === undefined) return
  const table = deps.domain.table('experiments')
  const existing = table.get(job.experimentId)
  if (existing === undefined) return
  const finishedAt = job.finishedAt ?? new Date().toISOString()
  const startedMs = job.startedAt !== undefined ? Date.parse(job.startedAt) : Number.NaN
  const finishedMs = Date.parse(finishedAt)
  const outcome: ExperimentJobOutcome = {
    jobId: job.id,
    status: job.status === 'succeeded' ? 'succeeded' : job.status === 'cancelled' ? 'cancelled' : 'failed',
    exitCode: job.exitCode,
    durationMs: Number.isFinite(startedMs) && Number.isFinite(finishedMs)
      ? Math.max(0, finishedMs - startedMs)
      : null,
    finishedAt,
    summary: jobSummaryOf(job),
  }
  if (hasNewerLinkedJob(deps, job)) {
    await appendExperimentLog(deps, existing.name, outcome).catch(() => {})
    return
  }
  await table.put(existing.id, {
    ...existing,
    status: outcome.status === 'succeeded' ? 'success' : 'failed',
    lastJob: outcome,
    updatedAt: new Date().toISOString(),
  })
  // Best-effort: a read-only workspace must not break the settle.
  await appendExperimentLog(deps, existing.name, outcome).catch(() => {})
}

/**
 * Whether another job linked to the same experiment was submitted after
 * `job` (compared on `createdAt`, then on the id's sequence suffix —
 * submits within the same millisecond share a `createdAt`). A deleted
 * newer record is invisible here; its documented contract is already
 * "the outcome is written nowhere".
 * @param deps - open wiki domain.
 * @param job - the settled job record.
 * @returns true when a newer linked job supersedes this settle.
 */
function hasNewerLinkedJob(deps: ServerDeps, job: JobRecord): boolean {
  for (const [, other] of deps.domain.table('jobs').entries()) {
    if (other.id === job.id || other.experimentId !== job.experimentId) continue
    if (other.createdAt !== job.createdAt) {
      if (other.createdAt > job.createdAt) return true
    } else if (jobSeqOf(other.id) > jobSeqOf(job.id)) {
      return true
    }
  }
  return false
}

/** Numeric sequence suffix of one job id (`job-<ms>-<seq>`); 0 when absent. */
function jobSeqOf(id: string): number {
  const match = /-(\d+)$/.exec(id)
  return match === null ? 0 : Number(match[1])
}

/** Non-empty lines kept of one settled job's log summary written back to the experiment. */
const JOB_SUMMARY_LINES = 5
/** Character cap of one settled job's log summary. */
const JOB_SUMMARY_MAX_CHARS = 400

/**
 * Trailing log excerpt of one settled job: the last non-empty lines of the
 * stream that explains the outcome (stderr on failure, stdout on success,
 * the other stream as the fallback), capped at {@link JOB_SUMMARY_LINES}
 * lines and {@link JOB_SUMMARY_MAX_CHARS} characters. Silent jobs yield an
 * empty summary.
 * @param job - the settled job record.
 * @returns the log excerpt.
 */
function jobSummaryOf(job: JobRecord): string {
  const primary = job.status === 'failed' ? job.stderrTail : job.stdoutTail
  const fallback = job.status === 'failed' ? job.stdoutTail : job.stderrTail
  const source = primary.trim() !== '' ? primary : fallback
  const lines = source.split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '')
  const summary = lines.slice(-JOB_SUMMARY_LINES).join('\n')
  return summary.length <= JOB_SUMMARY_MAX_CHARS ? summary : `…${summary.slice(summary.length - JOB_SUMMARY_MAX_CHARS)}`
}

/**
 * Append one settled-job line to the workspace's `EXPERIMENT_LOG.md`
 * (created on first write): timestamp, experiment name, job id and
 * outcome, exit code, wall-clock seconds, and the summary's first line
 * (truncated to 120 characters).
 * @param deps - open wiki domain plus workspace root.
 * @param experimentName - the linked experiment's display name.
 * @param outcome - the settled job's write-back outcome.
 */
async function appendExperimentLog(deps: ServerDeps, experimentName: string, outcome: ExperimentJobOutcome): Promise<void> {
  const seconds = outcome.durationMs === null ? null : (outcome.durationMs / 1000).toFixed(1)
  const firstLine = outcome.summary.split('\n')[0] ?? ''
  const detail = firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine
  const line = `- ${outcome.finishedAt} \`${experimentName}\` job ${outcome.jobId} ${outcome.status}`
    + ` (exit ${outcome.exitCode === null ? 'n/a' : String(outcome.exitCode)}`
    + `${seconds === null ? '' : `, ${seconds}s`})`
    + `${detail === '' ? '' : `: ${detail}`}`
  await appendFile(join(deps.workspaceDir, 'EXPERIMENT_LOG.md'), `${line}\n`, 'utf8')
}

/**
 * Flip one linked experiment's status, linking the server on submit; a
 * deleted experiment is skipped.
 * @param deps - open wiki domain.
 * @param experimentId - the experiment record id.
 * @param status - the next lifecycle status.
 * @param serverId - the executing server, set on the submit flip only.
 */
async function markExperiment(
  deps: ServerDeps,
  experimentId: string,
  status: ExperimentStatus,
  serverId?: string,
): Promise<void> {
  const table = deps.domain.table('experiments')
  const existing = table.get(experimentId)
  if (existing === undefined) return
  await table.put(experimentId, {
    ...existing,
    status,
    serverId: serverId ?? existing.serverId,
    updatedAt: new Date().toISOString(),
  })
}
