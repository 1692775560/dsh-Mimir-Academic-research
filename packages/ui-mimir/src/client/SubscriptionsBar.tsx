/**
 * The papers view's arXiv subscription bar: an add form (a keyword query the
 * host re-checks for new papers), the subscription list as removable pills
 * with each one's unimported-new badge, a manual check button, and the
 * inline new-paper section — every surfaced entry (title / authors / date)
 * with its own import button plus one import-all. Pure presentational: all
 * verbs arrive as props.
 * @module dsh-client-ui-mimir/client/SubscriptionsBar
 */

import { useEffect, useState } from 'react'
import type { ArxivEntry, ArxivSubscriptionView } from 'dsh-mimir/types'
import type { ResearchFailureView, ResearchSubscriptionsView } from './controller.ts'
import { subscriptionNewCount, totalNewSubscriptionCount, unimportedNewEntries } from './subscriptions.ts'
import { readStorageFlag, storageFlagValue, writeStorageValue } from './storage.ts'
import { failureCopy, type ResearchT } from './view-common.ts'
import css from './ResearchPanel.module.css'

/** localStorage key the new-paper list fold persists under. */
const NEW_ENTRIES_COLLAPSED_STORAGE_KEY = 'mimir.subscriptions.newCollapsed'

/** 10×10 disclosure chevron, rotated while collapsed. */
const CHEVRON_ICON = (
  <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 3.5 5 6l2.5-2.5" />
  </svg>
)

/** One new entry's row: linked title, authors and date, and its import button. */
function NewEntryRow({ entry, imported, importing, onImport, t }: {
  readonly entry: ArxivEntry
  readonly imported: boolean
  readonly importing: boolean
  readonly onImport: (entry: ArxivEntry) => void
  readonly t: ResearchT
}) {
  return (
    <article className={css.subscriptionEntry}>
      <div className={css.subscriptionEntryHead}>
        <h4 className={css.paperCardTitle}>
          <a href={entry.url} target="_blank" rel="noreferrer">{entry.title}</a>
        </h4>
        {imported ? (
          <button type="button" className={css.btn} disabled>
            {t('papers.imported')}
          </button>
        ) : (
          <button
            type="button"
            className={css.btnPrimary}
            disabled={importing}
            onClick={() => { onImport(entry) }}
          >
            {importing ? t('papers.importing') : t('subscriptions.import')}
          </button>
        )}
      </div>
      <p className={css.paperCardMeta}>
        {entry.authors.length > 0 && `${entry.authors.join('，')} · `}
        {entry.published.slice(0, 10)}
      </p>
    </article>
  )
}

/**
 * @param props - the subscription slice, the library's imported ids (the
 * badge filters them out), the import/check/save/delete verbs, and copy.
 */
export function SubscriptionsBar({
  subscriptions, importedIds, importPaper, saveArxivSubscription,
  deleteArxivSubscription, checkArxivSubscriptions, t,
}: {
  readonly subscriptions: ResearchSubscriptionsView
  readonly importedIds: ReadonlySet<string>
  readonly importPaper: (entry: ArxivEntry) => Promise<ResearchFailureView | null>
  readonly saveArxivSubscription: (query: string) => Promise<ResearchFailureView | null>
  readonly deleteArxivSubscription: (id: string) => Promise<ResearchFailureView | null>
  readonly checkArxivSubscriptions: () => Promise<ResearchFailureView | null>
  readonly t: ResearchT
}) {
  const [query, setQuery] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)
  const [importingAll, setImportingAll] = useState(false)
  // The new-paper list defaults to folded (a long list floods the library
  // view); a successful manual check unfolds it once. The fold persists.
  const [newCollapsed, setNewCollapsed] = useState(
    () => readStorageFlag(NEW_ENTRIES_COLLAPSED_STORAGE_KEY, true),
  )
  useEffect(() => {
    writeStorageValue(NEW_ENTRIES_COLLAPSED_STORAGE_KEY, storageFlagValue(newCollapsed))
  }, [newCollapsed])
  const newTotal = totalNewSubscriptionCount(subscriptions.list, importedIds)

  const add = (): void => {
    const trimmed = query.trim()
    if (trimmed === '' || saving) return
    setSaving(true)
    setActionError(null)
    void saveArxivSubscription(trimmed)
      .then((failure) => {
        if (failure === null) {
          setQuery('')
        } else {
          setActionError(`${t('subscriptions.saveFailed')}：${failure.message}`)
        }
      })
      .finally(() => { setSaving(false) })
  }

  const remove = (subscription: ArxivSubscriptionView): void => {
    if (!window.confirm(t('subscriptions.confirmDelete'))) return
    setActionError(null)
    void deleteArxivSubscription(subscription.id).then((failure) => {
      setActionError(failure === null ? null : `${t('subscriptions.deleteFailed')}：${failure.message}`)
    })
  }

  const check = (): void => {
    if (subscriptions.checking) return
    setActionError(null)
    void checkArxivSubscriptions().then((failure) => {
      setActionError(failure === null ? null : `${t('subscriptions.checkFailed')}：${failure.message}`)
      // A successful manual check is the user's ask to SEE the arrivals.
      if (failure === null) setNewCollapsed(false)
    })
  }

  const importEntry = (entry: ArxivEntry): void => {
    if (importing !== null || importingAll) return
    setImporting(entry.id)
    setActionError(null)
    void importPaper(entry)
      .then((failure) => {
        setActionError(failure === null ? null : `${t('papers.importFailed')}：${failure.message}`)
      })
      .finally(() => { setImporting(null) })
  }

  const importAll = (): void => {
    if (importingAll || importing !== null) return
    const pending = subscriptions.list.flatMap(subscription => unimportedNewEntries(subscription, importedIds))
    if (pending.length === 0) return
    setImportingAll(true)
    setActionError(null)
    void (async (): Promise<void> => {
      for (const entry of pending) {
        const failure = await importPaper(entry)
        if (failure !== null) {
          setActionError(`${t('papers.importFailed')}：${failure.message}`)
          return
        }
      }
    })().finally(() => { setImportingAll(false) })
  }

  return (
    <section className={css.subscriptionsBar}>
      <div className={css.subscriptionsHead}>
        <h3 className={css.sectionTitle}>{t('subscriptions.title')}</h3>
        {newTotal > 0 && (
          <span className={css.subscriptionBadge} role="status">
            {t('subscriptions.newBadge', { count: newTotal })}
          </span>
        )}
      </div>
      <form
        className={css.subscriptionsForm}
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <input
          className={css.input}
          value={query}
          placeholder={t('subscriptions.addPlaceholder')}
          onChange={event => { setQuery(event.target.value) }}
        />
        <button
          type="submit"
          className={css.btn}
          disabled={query.trim() === '' || saving}
        >
          {t('subscriptions.add')}
        </button>
        <button
          type="button"
          className={css.btn}
          disabled={subscriptions.checking || subscriptions.list.length === 0}
          onClick={check}
        >
          {subscriptions.checking ? t('subscriptions.checking') : t('subscriptions.check')}
        </button>
      </form>
      {subscriptions.status === 'error' && (
        <p className={css.failure} role="alert">
          {t('error.subscriptions')}：{failureCopy(t, subscriptions.failure)}
        </p>
      )}
      {actionError !== null && (
        <p className={css.failure} role="alert">{actionError}</p>
      )}
      {subscriptions.list.length === 0 && subscriptions.status === 'ready' ? (
        <p className={css.hint}>{t('subscriptions.empty')}</p>
      ) : (
        <div className={css.subscriptionPills}>
          {subscriptions.list.map(subscription => (
            <span key={subscription.id} className={css.subscriptionPill}>
              {subscription.query}
              {subscriptionNewCount(subscription, importedIds) > 0 && (
                <span className={css.subscriptionPillCount}>
                  {subscriptionNewCount(subscription, importedIds)}
                </span>
              )}
              <button
                type="button"
                className={css.tagRemove}
                aria-label={`${t('subscriptions.delete')} ${subscription.query}`}
                onClick={() => { remove(subscription) }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {subscriptions.list.map((subscription) => {
        const checkError = subscriptions.checkErrors[subscription.id]
        return checkError === undefined ? null : (
          <p key={subscription.id} className={css.failure} role="alert">
            {subscription.query}：{t('subscriptions.checkFailed')}：{checkError}
          </p>
        )
      })}
      {newTotal > 0 && (
        <div className={css.subscriptionNew} data-collapsed={newCollapsed || undefined}>
          <div className={css.subscriptionNewHead}>
            <button
              type="button"
              className={css.subscriptionNewToggle}
              aria-expanded={!newCollapsed}
              aria-label={t(newCollapsed ? 'subscriptions.expandNew' : 'subscriptions.collapseNew')}
              onClick={() => { setNewCollapsed(prev => !prev) }}
            >
              <span className={css.collapseChevron} data-up={newCollapsed || undefined} aria-hidden>{CHEVRON_ICON}</span>
              <span className={css.sectionTitle}>
                {t('subscriptions.newBadge', { count: newTotal })}
              </span>
            </button>
            <button
              type="button"
              className={css.btnPrimary}
              disabled={importingAll || importing !== null}
              onClick={importAll}
            >
              {importingAll ? t('papers.importing') : t('subscriptions.importAll')}
            </button>
          </div>
          {!newCollapsed && subscriptions.list.map((subscription) => {
            const entries = unimportedNewEntries(subscription, importedIds)
            return entries.length === 0 ? null : (
              <div key={subscription.id} className={css.subscriptionNewGroup}>
                <p className={css.hint}>{subscription.query}</p>
                {entries.map(entry => (
                  <NewEntryRow
                    key={entry.id}
                    entry={entry}
                    imported={importedIds.has(entry.id)}
                    importing={importing === entry.id || importingAll}
                    onImport={importEntry}
                    t={t}
                  />
                ))}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
