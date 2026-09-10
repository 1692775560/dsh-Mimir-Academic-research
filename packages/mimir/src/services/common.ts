/**
 * Shared helpers of the domain service modules under `./services`.
 * The only mutable instance state (compile status map, job counter, job
 * abort handles, long-task registry) is carried by an explicit
 * {@link ServiceState} object rather than module-level mutable variables,
 * so every `new ResearchService` gets its own copy (test isolation,
 * multi-instance correctness).
 * @module dsh-mimir/src/services/common
 */

import type {
  ResearchCompileStatusView,
  ResearchFailure,
  ResearchRejected,
  ResearchSuccess,
} from '../types.ts'

/** The only mutable instance state: compileStatus and the job counter. */
export interface ServiceState {
  /** Per-addressed-project compile status ('' key = the no-project slot); the Map identity is fixed, its contents mutate. */
  readonly compileStatus: Map<string, ResearchCompileStatusView>
  /** Monotonic suffix for jobs submitted within the same millisecond; only submitJob increments it. */
  jobSeq: number
  /** Abort handles for active SSH sessions owned by this service instance. */
  readonly jobAborts: Map<string, AbortController>
  /** Intended terminal status for an aborted active job: `cancelled` (user/delete) or `interrupted` (host dispose). Absent → cancelled. */
  readonly jobStopStatus: Map<string, 'cancelled' | 'interrupted'>
  /** Abort handles of in-flight long tasks (compiles, deck generations) owned by this instance; aborted on dispose (#247). */
  readonly longTasks: Set<AbortController>
}

/** Handle of one registered long task: the linked signal and its release. */
export interface LongTaskLink {
  /** Aborts when the caller's signal aborts OR the service disposes (#247). */
  readonly signal: AbortSignal
  /** Unregister the task (idempotent); call once the task settles. */
  readonly done: () => void
}

/**
 * Register one long-running task (a LaTeX compile, a meeting-deck
 * generation) so the service's dispose path can abort it, and link the
 * caller's cancellation into the same signal (#247). Panel cancel, host
 * dispose, and RPC timeout now travel ONE termination path instead of each
 * task growing its own. The returned signal must be released with `done()`
 * once the task settles (a `finally` on the task's promise).
 */
export function linkLongTask(state: ServiceState, callerSignal?: AbortSignal): LongTaskLink {
  const controller = new AbortController()
  const onCallerAbort = (): void => { controller.abort(callerSignal?.reason) }
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason)
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  }
  state.longTasks.add(controller)
  let released = false
  const done = (): void => {
    if (released) return
    released = true
    callerSignal?.removeEventListener('abort', onCallerAbort)
    state.longTasks.delete(controller)
  }
  return { signal: controller.signal, done }
}

/**
 * Abort every in-flight long task of the service (the dispose path, #247).
 * Aborted tasks settle through their own handlers; their `done()` releases
 * find an empty set, which is harmless.
 */
export function abortLongTasks(state: ServiceState): void {
  for (const controller of [...state.longTasks]) controller.abort()
  state.longTasks.clear()
}

/** Build a frozen success branch. */
export function success<T>(value: T): ResearchSuccess<T> {
  return Object.freeze({ ok: true, value })
}

/** Build a frozen business-failure branch. */
export function rejected<E extends ResearchFailure>(error: E): ResearchRejected<E> {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}
