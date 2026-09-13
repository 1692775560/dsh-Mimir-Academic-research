/**
 * THE remote-job lifecycle contract (#225) — the single authoritative
 * definition every producer (server.ts settles, restart recovery) and
 * consumer (the panel, the experiment write-back, the ledger) shares.
 *
 * States:
 * - `queued`     — the record is durable; the local driver has not started.
 * - `running`    — the local ssh session driving the remote command is up.
 * - `succeeded`  — a remote exit 0 was OBSERVED.
 * - `failed`     — an observed, explained failure: a remote non-zero exit, a
 *                  session that failed before the command ran (connect/auth),
 *                  or the output capture limit (`SSH_JOB_MAX_BUFFER_BYTES`
 *                  in server.ts) being exceeded — the session is killed and
 *                  the record says so; nothing is silently truncated.
 * - `cancelled`  — the USER deliberately aborted the local session (deleting
 *                  an active job). The remote outcome is unknowable once the
 *                  session drops; the record says so instead of guessing.
 * - `interrupted`— the HOST went away (dispose/restart) while the job was
 *                  active; ownership died with the process. Restart recovery
 *                  settles leftovers here.
 * - `unknown`    — observation was lost WITHOUT user intent and without host
 *                  teardown: the session exceeded its documented duration cap
 *                  and was dropped. The remote process may still be running;
 *                  the record never claims an outcome.
 *
 * Transitions: `queued → running → succeeded|failed`; from either active
 * state, `cancelled` (user), `interrupted` (host), or `unknown` (timeout).
 * No terminal state ever flips again.
 *
 * The linked experiment's lifecycle is coarser (`running` → `success` /
 * `failed`): only an observed `succeeded` lands as `success`; everything
 * else — including `cancelled`/`interrupted`/`unknown` — lands as `failed`,
 * because the experiment's run did not produce a usable result.
 * @module dsh-mimir/src/job-lifecycle
 */

import type { JobStatus } from './types.ts'

/** Every job status, in lifecycle order (terminal states last). */
export const JOB_STATUSES: readonly JobStatus[] = Object.freeze([
  'queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'unknown',
])

/** The two states in which the local driver still owns a live session. */
export const JOB_ACTIVE_STATUSES: readonly JobStatus[] = Object.freeze(['queued', 'running'])

/** Whether the job still owns a live local session (queued or running). */
export function isActiveJobStatus(status: JobStatus): boolean {
  return status === 'queued' || status === 'running'
}

/** Whether the job settled and will never flip again. */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return !isActiveJobStatus(status)
}
