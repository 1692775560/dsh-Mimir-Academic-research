/**
 * Scheduled-task health and the shared timer loop (#223). Every periodic
 * background task of the plugin (wiki backup, arXiv subscription checks,
 * venue-deadline refresh) runs through {@link startScheduledLoop}, which
 * records last success / last failure / consecutive failures / an error
 * summary into a {@link TaskHealthRegistry}, backs off exponentially on
 * consecutive failures (bounded by {@link TASK_BACKOFF_MAX_FACTOR}), and
 * never lets a failing pass stop the loop or the plugin. The panel reads
 * the registry snapshot through the `getTaskHealth` Remote.
 * @module dsh-mimir/src/task-health
 */

import type { ResearchScheduledTaskView } from './types.ts'

/** Cap on the exponential backoff multiplier applied to a failing task. */
export const TASK_BACKOFF_MAX_FACTOR = 8

/** Longest error summary kept per task (the panel shows it verbatim). */
const ERROR_SUMMARY_MAX_LENGTH = 200

/** One task's mutable health record inside the registry. */
interface MutableTaskHealth {
  lastSuccessAt: string | null
  lastFailureAt: string | null
  consecutiveFailures: number
  lastError: string | null
}

/** Short human-readable summary of one thrown failure. */
function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= ERROR_SUMMARY_MAX_LENGTH ? message : `${message.slice(0, ERROR_SUMMARY_MAX_LENGTH)}…`
}

/**
 * Health book of the plugin's scheduled tasks. Mutable by design (the timer
 * loops write it on every pass); snapshots are frozen for the wire.
 */
export class TaskHealthRegistry {
  private readonly entries = new Map<string, MutableTaskHealth>()

  /** The record for one task, created on first sight. */
  private entry(name: string): MutableTaskHealth {
    let found = this.entries.get(name)
    if (found === undefined) {
      found = { lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0, lastError: null }
      this.entries.set(name, found)
    }
    return found
  }

  /** Mark one pass of `name` successful: clears the failure streak. */
  recordSuccess(name: string): void {
    const entry = this.entry(name)
    entry.lastSuccessAt = new Date().toISOString()
    entry.consecutiveFailures = 0
    entry.lastError = null
  }

  /** Mark one pass of `name` failed: extends the streak and keeps a summary. */
  recordFailure(name: string, error: unknown): void {
    const entry = this.entry(name)
    entry.lastFailureAt = new Date().toISOString()
    entry.consecutiveFailures += 1
    entry.lastError = errorSummary(error)
  }

  /**
   * Backoff multiplier for the next pass of `name`: 1 while healthy, then
   * doubling per consecutive failure, capped at {@link TASK_BACKOFF_MAX_FACTOR}.
   */
  backoffFactor(name: string): number {
    const failures = this.entries.get(name)?.consecutiveFailures ?? 0
    if (failures === 0) return 1
    return Math.min(2 ** failures, TASK_BACKOFF_MAX_FACTOR)
  }

  /** Frozen per-task views for the wire, in registration order. */
  snapshot(): readonly ResearchScheduledTaskView[] {
    return Object.freeze([...this.entries].map(([name, entry]) => Object.freeze({
      name,
      lastSuccessAt: entry.lastSuccessAt,
      lastFailureAt: entry.lastFailureAt,
      consecutiveFailures: entry.consecutiveFailures,
      lastError: entry.lastError,
    })))
  }
}

/** Wiring of one periodic background task. */
export interface ScheduledLoopOptions {
  /** Health-book key (also the panel-facing task name). */
  readonly name: string
  /** Shared health book every scheduled task of the plugin records into. */
  readonly health: TaskHealthRegistry
  /** Healthy cadence in milliseconds (>= 1). */
  readonly intervalMs: number
  /** Delay of the FIRST run; defaults to `intervalMs`. */
  readonly firstDelayMs?: number | undefined
  /** One pass; a rejection is a recorded failure, never a loop exit. */
  readonly run: () => Promise<unknown>
  /** Failure sink for logging; called after the failure is recorded. */
  readonly onError: (error: unknown) => void
}

/**
 * Start one self-rescheduling timer loop: first pass after `firstDelayMs`,
 * then `intervalMs` after each pass SETTLES (never overlapping an in-flight
 * pass), stretched by the task's backoff factor after consecutive failures.
 * The timer is unref'd so it never holds the process open, and no pass
 * outcome can stop the loop or the plugin.
 * @param options - see {@link ScheduledLoopOptions}.
 * @returns dispose: clears the pending timer (an in-flight pass finishes).
 */
export function startScheduledLoop(options: ScheduledLoopOptions): () => void {
  let stopped = false
  let inFlight = false
  let timer: NodeJS.Timeout | undefined
  const schedule = (delayMs: number): void => {
    if (stopped) return
    timer = setTimeout(tick, delayMs)
    timer.unref()
  }
  const tick = (): void => {
    if (stopped || inFlight) return
    inFlight = true
    options.run()
      .then(() => { options.health.recordSuccess(options.name) })
      .catch((error: unknown) => {
        options.health.recordFailure(options.name, error)
        options.onError(error)
      })
      .finally(() => {
        inFlight = false
        schedule(options.intervalMs * options.health.backoffFactor(options.name))
      })
  }
  schedule(options.firstDelayMs ?? options.intervalMs)
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}
