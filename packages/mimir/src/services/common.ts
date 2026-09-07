/**
 * Shared helpers of the domain service modules under `./services`.
 * The only mutable instance state (compile status map and job counter) is
 * carried by an explicit {@link ServiceState} object rather than module-level
 * mutable variables, so every `new ResearchService` gets its own copy (test
 * isolation, multi-instance correctness).
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
}

/** Build a frozen success branch. */
export function success<T>(value: T): ResearchSuccess<T> {
  return Object.freeze({ ok: true, value })
}

/** Build a frozen business-failure branch. */
export function rejected<E extends ResearchFailure>(error: E): ResearchRejected<E> {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}
