/**
 * arXiv-subscription domain module: the panel's subscription CRUD and the
 * new-paper check. The list persists as one JSON file under the workspace
 * root (see `../arxiv-subscriptions.ts`); nothing here touches the wiki
 * domain. Thin forwarding of the four `*ArxivSubscription*` Remote methods
 * lives in `service.ts`.
 * @module dsh-mimir/src/services/subscriptions
 */

import { randomUUID } from 'node:crypto'
import {
  ARXIV_SUBSCRIPTION_QUERY_MAX,
  loadArxivSubscriptions,
  runArxivSubscriptionCheck,
  saveArxivSubscriptions,
  withArxivSubscriptionsFileLock,
} from '../arxiv-subscriptions.ts'
import type {
  ArxivSubscriptionRecord,
  ArxivSubscriptionCheckOptions,
} from '../arxiv-subscriptions.ts'
import type {
  ArxivSubscriptionView,
  ResearchArxivSubscriptionsResult,
  ResearchCheckArxivSubscriptionsResult,
  ResearchDeleteArxivSubscriptionResult,
  ResearchSaveArxivSubscriptionResult,
} from '../types.ts'
import { rejected, success } from './common.ts'

/** Everything the arXiv-subscription domain functions need from the service scope. */
export interface SubscriptionDeps {
  readonly workspaceDir: string
}

/** The panel-facing view of one stored record (seenIds stay host-side bookkeeping). */
function toView(record: ArxivSubscriptionRecord): ArxivSubscriptionView {
  return {
    id: record.id,
    query: record.query,
    createdAt: record.createdAt,
    lastCheckedAt: record.lastCheckedAt,
    newEntries: Object.freeze([...record.newEntries]),
  }
}

/**
 * List every subscription, creation order, each with its cached new-entry
 * details (the panel derives the badge count by filtering out ids it has
 * already imported).
 * @param deps - workspace root.
 * @returns the subscription views.
 */
export async function listArxivSubscriptions(
  deps: SubscriptionDeps,
): Promise<ResearchArxivSubscriptionsResult> {
  const subscriptions = await loadArxivSubscriptions(deps.workspaceDir)
  return success({ subscriptions: Object.freeze(subscriptions.map(toView)) })
}

/**
 * Add one subscription. The query must be non-empty and at most
 * {@link ARXIV_SUBSCRIPTION_QUERY_MAX} characters; a duplicate (trimmed,
 * case-insensitive) is `invalid-input`. The new subscription starts unseen:
 * its first check seeds the baseline and surfaces nothing as new.
 * @param deps - workspace root.
 * @param request - the free-text query.
 * @returns the created subscription's view.
 */
export async function saveArxivSubscription(
  deps: SubscriptionDeps,
  request: { query: string },
): Promise<ResearchSaveArxivSubscriptionResult> {
  const query = request.query.trim()
  if (query === '') return rejected({ code: 'invalid-input', message: 'query must be non-empty' })
  if (query.length > ARXIV_SUBSCRIPTION_QUERY_MAX) {
    return rejected({ code: 'invalid-input', message: `query must be at most ${ARXIV_SUBSCRIPTION_QUERY_MAX} characters` })
  }
  // The same file lock the check's save path holds: a check settling between
  // our read and write would otherwise be overwritten whole. The duplicate
  // probe and the append both re-read inside the lock.
  return await withArxivSubscriptionsFileLock(deps.workspaceDir, async () => {
    const subscriptions = await loadArxivSubscriptions(deps.workspaceDir)
    if (subscriptions.some(record => record.query.toLowerCase() === query.toLowerCase())) {
      return rejected({ code: 'invalid-input', message: `already subscribed: ${query}` })
    }
    const record: ArxivSubscriptionRecord = {
      id: randomUUID(),
      query,
      createdAt: new Date().toISOString(),
      lastCheckedAt: null,
      seenIds: Object.freeze([]),
      newEntryIds: Object.freeze([]),
      newEntries: Object.freeze([]),
    }
    await saveArxivSubscriptions(deps.workspaceDir, [...subscriptions, record])
    return success({ subscription: toView(record) })
  })
}

/**
 * Delete one subscription; an unknown id is `subscription-not-found`.
 * @param deps - workspace root.
 * @param request - the subscription id.
 * @returns the removed id.
 */
export async function deleteArxivSubscription(
  deps: SubscriptionDeps,
  request: { id: string },
): Promise<ResearchDeleteArxivSubscriptionResult> {
  // Same lock as the check's save path: re-read inside, then filter, so a
  // concurrently settling check can neither resurrect the deleted record nor
  // be lost itself.
  return await withArxivSubscriptionsFileLock(deps.workspaceDir, async () => {
    const subscriptions = await loadArxivSubscriptions(deps.workspaceDir)
    if (!subscriptions.some(record => record.id === request.id)) {
      return rejected({ code: 'subscription-not-found', id: request.id })
    }
    await saveArxivSubscriptions(
      deps.workspaceDir,
      subscriptions.filter(record => record.id !== request.id),
    )
    return success({ id: request.id })
  })
}

/**
 * Check subscriptions for new papers: one subscription via `id` (an unknown
 * id is `subscription-not-found`), else all. Each checked record's
 * `lastCheckedAt` / `seenIds` / new-entry lists update; one subscription's
 * fetch failure never fails the run — its outcome carries the message and
 * its stored record stays untouched.
 * @param deps - workspace root.
 * @param request - the optional single-subscription selection.
 * @param options - test injection knobs (gap, timeout, fetch, clock).
 * @returns one outcome per checked subscription, entry details included.
 */
export async function checkArxivSubscriptions(
  deps: SubscriptionDeps,
  request: { id?: string },
  options: Omit<ArxivSubscriptionCheckOptions, 'id'> = {},
): Promise<ResearchCheckArxivSubscriptionsResult> {
  const outcomes = await runArxivSubscriptionCheck(deps.workspaceDir, {
    ...options,
    ...(request.id === undefined ? {} : { id: request.id }),
  })
  if (outcomes === undefined) {
    return rejected({ code: 'subscription-not-found', id: request.id ?? '' })
  }
  return success({
    checks: Object.freeze(outcomes.map(outcome => Object.freeze({
      subscription: toView(outcome.record),
      added: outcome.added,
      error: outcome.error === null
        ? null
        : outcome.error instanceof Error ? outcome.error.message : 'arXiv check failed',
    }))),
  })
}
