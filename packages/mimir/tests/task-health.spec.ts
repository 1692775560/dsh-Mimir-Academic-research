/**
 * Behavior tests for the scheduled-task health book and loop (#223): the
 * registry's success/failure recording and bounded exponential backoff, the
 * shared loop's settle-paced cadence with backoff under consecutive failures
 * (recovery resets it, dispose stops it, a failing pass never stops the
 * loop), and the `getTaskHealth` Remote surface. Real timers with short
 * delays; no mocks beyond the injected run function.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import {
  startScheduledLoop, TASK_BACKOFF_MAX_FACTOR, TaskHealthRegistry,
} from '../src/task-health.ts'

describe('TaskHealthRegistry', () => {
  it('records success and failure streaks with timestamps and summaries', () => {
    const registry = new TaskHealthRegistry()
    registry.recordSuccess('backup')
    registry.recordFailure('backup', new Error('disk full'))
    registry.recordFailure('backup', 'plain string')
    const [view] = registry.snapshot()
    expect(view?.name).toBe('backup')
    expect(view?.consecutiveFailures).toBe(2)
    expect(view?.lastError).toBe('plain string')
    expect(view?.lastSuccessAt).not.toBeNull()
    expect(view?.lastFailureAt).not.toBeNull()
    // A success clears the streak and the summary.
    registry.recordSuccess('backup')
    const [healthy] = registry.snapshot()
    expect(healthy?.consecutiveFailures).toBe(0)
    expect(healthy?.lastError).toBeNull()
  })

  it('bounds the backoff factor exponentially', () => {
    const registry = new TaskHealthRegistry()
    expect(registry.backoffFactor('loop')).toBe(1)
    registry.recordFailure('loop', new Error('x'))
    expect(registry.backoffFactor('loop')).toBe(2)
    registry.recordFailure('loop', new Error('x'))
    expect(registry.backoffFactor('loop')).toBe(4)
    registry.recordFailure('loop', new Error('x'))
    expect(registry.backoffFactor('loop')).toBe(8)
    registry.recordFailure('loop', new Error('x'))
    expect(registry.backoffFactor('loop')).toBe(TASK_BACKOFF_MAX_FACTOR)
  })

  it('truncates long error summaries', () => {
    const registry = new TaskHealthRegistry()
    registry.recordFailure('loop', new Error('x'.repeat(500)))
    const [view] = registry.snapshot()
    expect(view?.lastError).toHaveLength(201)
    expect(view?.lastError?.endsWith('…')).toBe(true)
  })
})

describe('startScheduledLoop', () => {
  it('records passes and backs off under consecutive failures without stopping', async () => {
    const health = new TaskHealthRegistry()
    const run = vi.fn(() => Promise.reject(new Error('boom')))
    const errors: unknown[] = []
    const stop = startScheduledLoop({
      name: 'task', health, intervalMs: 20, firstDelayMs: 1,
      run, onError: error => { errors.push(error) },
    })
    try {
      await vi.waitFor(() => { expect(run.mock.calls.length).toBeGreaterThanOrEqual(3) }, { timeout: 5000, interval: 10 })
      const [view] = health.snapshot()
      expect(view?.consecutiveFailures).toBeGreaterThanOrEqual(3)
      expect(view?.lastError).toBe('boom')
      expect(errors.length).toBe(run.mock.calls.length)
    } finally {
      stop()
    }
  })

  it('resets the backoff after a recovered pass', async () => {
    const health = new TaskHealthRegistry()
    let fail = true
    const run = vi.fn(() => fail ? Promise.reject(new Error('down')) : Promise.resolve('ok'))
    const stop = startScheduledLoop({
      name: 'task', health, intervalMs: 15, firstDelayMs: 1, run, onError: () => {},
    })
    try {
      await vi.waitFor(() => { expect(run.mock.calls.length).toBeGreaterThanOrEqual(2) }, { timeout: 5000, interval: 5 })
      expect(health.backoffFactor('task')).toBeGreaterThan(1)
      fail = false
      await vi.waitFor(() => {
        expect(health.snapshot()[0]?.consecutiveFailures).toBe(0)
      }, { timeout: 5000, interval: 5 })
      expect(health.backoffFactor('task')).toBe(1)
    } finally {
      stop()
    }
  })

  it('never overlaps an in-flight pass and stops on dispose', async () => {
    const health = new TaskHealthRegistry()
    const calls: Array<() => void> = []
    const run = vi.fn(() => new Promise<string>(resolve => { calls.push(() => resolve('done')) }))
    const stop = startScheduledLoop({
      name: 'task', health, intervalMs: 5, firstDelayMs: 1, run, onError: () => {},
    })
    await vi.waitFor(() => { expect(run).toHaveBeenCalledTimes(1) }, { timeout: 5000, interval: 5 })
    await new Promise(resolveTimer => setTimeout(resolveTimer, 30))
    expect(run).toHaveBeenCalledTimes(1)
    stop()
    calls[0]?.()
    await new Promise(resolveTimer => setTimeout(resolveTimer, 30))
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('getTaskHealth Remote', () => {
  /** Boot a service over a memory-backed domain, with or without the book. */
  async function harness(taskHealth?: TaskHealthRegistry): Promise<ResearchService> {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    ctx.storage.backend.register('memory', backend)
    ctx.provide(storageBackendServiceKey('memory'), backend)
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    const domain = await facility.open(researchWikiDomainSpec)
    return new ResearchService(ctx, {
      workspaceDir: '/tmp/mimir-task-health',
      domain,
      latex: { engine: 'auto', timeoutMs: 1000 },
      ...(taskHealth === undefined ? {} : { taskHealth }),
    })
  }

  it('reports the shared registry snapshot, empty when unwired', async () => {
    const taskHealth = new TaskHealthRegistry()
    taskHealth.recordFailure('wiki-backup', new Error('read-only fs'))
    const wired = await harness(taskHealth)
    const bare = await harness()

    const withLoops = await wired.getTaskHealth()
    expect(withLoops.ok).toBe(true)
    if (withLoops.ok) {
      expect(withLoops.value.tasks).toHaveLength(1)
      expect(withLoops.value.tasks[0]).toMatchObject({ name: 'wiki-backup', consecutiveFailures: 1, lastError: 'read-only fs' })
    }
    const without = await bare.getTaskHealth()
    expect(without.ok && without.value.tasks).toEqual([])
  })
})
