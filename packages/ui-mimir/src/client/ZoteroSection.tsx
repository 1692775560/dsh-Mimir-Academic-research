/**
 * The papers view's Zotero section: a connection-status line (unconfigured
 * guidance, a failed probe with retry, or the live collection picker), a
 * full-text search of the configured library with one-click import into the
 * wiki, and the "export collection to references.bib" action addressed to
 * the selected project. All data arrives through props; the component owns
 * only the picker/search local state.
 * @module dsh-client-ui-mimir/client/ZoteroSection
 */

import { useState } from 'react'
import type { ZoteroItemView } from 'dsh-mimir/types'
import type {
  ResearchFailureView, ResearchImportCounts, ResearchZoteroSearchView, ResearchZoteroView,
} from './controller.ts'
import { failureCopy, type ResearchT } from './view-common.ts'
import css from './ResearchPanel.module.css'

/** The papers-table id an item import lands under (mirrors the host's mapping). */
function paperIdOf(item: ZoteroItemView): string {
  return item.arxivId ?? `zotero-${item.key}`
}

/**
 * @param props - the Zotero slices, the library's imported ids (for the
 * per-row imported state), the selected project (the export target), the
 * verbs, and copy.
 * @returns the section; a bare loading line until the first probe settles.
 */
export function ZoteroSection({
  zotero, zoteroSearch, importedIds, selectedProjectId,
  recheckZotero, searchZotero, importZoteroItem, exportZoteroCollectionToBib, onError, t,
}: {
  readonly zotero: ResearchZoteroView
  readonly zoteroSearch: ResearchZoteroSearchView | null
  readonly importedIds: ReadonlySet<string>
  readonly selectedProjectId: string | null
  readonly recheckZotero: () => void
  readonly searchZotero: (query: string) => void
  readonly importZoteroItem: (key: string, projectId?: string) => Promise<ResearchFailureView | null>
  readonly exportZoteroCollectionToBib: (
    projectId: string,
    collectionKey: string,
  ) => Promise<ResearchFailureView | ResearchImportCounts>
  readonly onError: (message: string | null) => void
  readonly t: ResearchT
}) {
  const [query, setQuery] = useState('')
  const [collectionKey, setCollectionKey] = useState('')
  const [importing, setImporting] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<string | null>(null)

  const submitSearch = (): void => {
    if (query.trim() === '') return
    setExported(null)
    searchZotero(query)
  }
  const importItem = (item: ZoteroItemView): void => {
    if (importing !== null) return
    setImporting(item.key)
    onError(null)
    void importZoteroItem(item.key, selectedProjectId ?? undefined)
      .then((failure) => {
        if (failure !== null) onError(`${t('papers.importFailed')}：${failure.message}`)
      })
      .finally(() => { setImporting(null) })
  }
  const exportCollection = (): void => {
    if (exporting || selectedProjectId === null || collectionKey === '') return
    setExporting(true)
    setExported(null)
    onError(null)
    void exportZoteroCollectionToBib(selectedProjectId, collectionKey)
      .then((outcome) => {
        if ('code' in outcome) {
          onError(`${t('zotero.exportFailed')}：${outcome.message}`)
        } else {
          setExported(t('zotero.exported', { added: outcome.added.length, skipped: outcome.skipped.length }))
        }
      })
      .finally(() => { setExporting(false) })
  }

  if (zotero.status === 'cold' || zotero.status === 'loading') {
    return <p className={css.hint}>{t('zotero.checking')}</p>
  }
  if (zotero.status === 'error') {
    return (
      <p className={css.failure} role="alert">
        {t('zotero.failed')}：{failureCopy(t, zotero.failure)}
        <button type="button" className={css.btn} onClick={recheckZotero}>
          {t('projects.retry')}
        </button>
      </p>
    )
  }
  if (zotero.state === 'unconfigured') {
    return (
      <section className={css.zoteroSection}>
        <h3 className={css.sectionTitle}>{t('zotero.title')}</h3>
        <p className={css.hint}>{t('zotero.unconfigured')}</p>
      </section>
    )
  }
  if (zotero.state === 'failed') {
    return (
      <section className={css.zoteroSection}>
        <h3 className={css.sectionTitle}>{t('zotero.title')}</h3>
        <p className={css.failure} role="alert">
          {t('zotero.failed')}{zotero.message === null ? '' : `：${zotero.message}`}
          <button type="button" className={css.btn} onClick={recheckZotero}>
            {t('projects.retry')}
          </button>
        </p>
      </section>
    )
  }

  return (
    <section className={css.zoteroSection}>
      <h3 className={css.sectionTitle}>{t('zotero.title')}</h3>
      <div className={css.zoteroControls}>
        {zotero.collections.length === 0 ? (
          <span className={css.hint}>{t('zotero.noCollections')}</span>
        ) : (
          <>
            <select
              className={css.zoteroSelect}
              aria-label={t('zotero.collection')}
              value={collectionKey}
              onChange={(event) => { setCollectionKey(event.target.value) }}
            >
              <option value="">{t('zotero.collection')}</option>
              {zotero.collections.map(collection => (
                <option key={collection.key} value={collection.key}>
                  {collection.name}（{collection.itemCount}）
                </option>
              ))}
            </select>
            <button
              type="button"
              className={css.btn}
              disabled={exporting || selectedProjectId === null || collectionKey === ''}
              title={selectedProjectId === null ? t('bib.noProject') : undefined}
              onClick={exportCollection}
            >
              {exporting ? t('zotero.exporting') : t('zotero.export')}
            </button>
          </>
        )}
      </div>
      {exported !== null && <p className={css.hint}>{exported}</p>}
      <form
        className={css.papersSearchBar}
        onSubmit={(event) => {
          event.preventDefault()
          submitSearch()
        }}
      >
        <input
          className={css.input}
          value={query}
          placeholder={t('zotero.searchPlaceholder')}
          onChange={event => { setQuery(event.target.value) }}
        />
        <button
          type="submit"
          className={css.btnPrimary}
          disabled={query.trim() === '' || zoteroSearch?.status === 'loading'}
        >
          {zoteroSearch?.status === 'loading' ? t('papers.searching') : t('papers.search')}
        </button>
      </form>
      {zoteroSearch !== null && (
        <>
          {zoteroSearch.status === 'loading' && zoteroSearch.previous !== null ? (
            // #208: the superseded items stay on screen while the new query
            // is in flight — an empty panel reads as "no results".
            <>
              <p className={css.searchStaleNote} role="note">
                {t('papers.searchStale')}：{zoteroSearch.previous.query}
              </p>
              <div className={css.papersResults} data-stale="true">
                {zoteroSearch.previous.list.map(item => (
                  <article key={item.key} className={css.paperResult}>
                    <div className={css.paperResultHead}>
                      <h3 className={css.paperCardTitle}>
                        {item.url === ''
                          ? item.title
                          : (
                            <a href={item.url} target="_blank" rel="noreferrer">
                              {item.title}
                            </a>
                          )}
                      </h3>
                    </div>
                    <p className={css.paperCardMeta}>
                      {item.authors.length > 0 && `${item.authors.join('，')} · `}
                      {item.year}
                    </p>
                  </article>
                ))}
              </div>
            </>
          ) : zoteroSearch.status === 'loading' ? (
            <p className={css.hint}>{t('papers.searching')}</p>
          ) : zoteroSearch.status === 'error' ? (
            <p className={css.failure} role="alert">
              {failureCopy(t, zoteroSearch.failure)}
              <button type="button" className={css.btn} onClick={() => { searchZotero(zoteroSearch.query) }}>
                {t('error.retry')}
              </button>
            </p>
          ) : zoteroSearch.list.length === 0 ? (
            <p className={css.hint}>{t('zotero.searchEmpty')}</p>
          ) : (
            <div className={css.papersResults}>
              {zoteroSearch.list.map(item => (
                <article key={item.key} className={css.paperResult}>
                  <div className={css.paperResultHead}>
                    <h3 className={css.paperCardTitle}>
                      {item.url === ''
                        ? item.title
                        : (
                          <a href={item.url} target="_blank" rel="noreferrer">
                            {item.title}
                          </a>
                        )}
                    </h3>
                    {importedIds.has(paperIdOf(item)) ? (
                      <button type="button" className={css.btn} disabled>
                        {t('papers.imported')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={css.btnPrimary}
                        disabled={importing !== null}
                        onClick={() => { importItem(item) }}
                      >
                        {importing === item.key ? t('papers.importing') : t('papers.import')}
                      </button>
                    )}
                  </div>
                  <p className={css.paperCardMeta}>
                    {item.authors.length > 0 && `${item.authors.join('，')} · `}
                    {item.year}
                    {item.publicationTitle !== '' && ` · ${item.publicationTitle}`}
                    {item.doi !== '' && ` · DOI: ${item.doi}`}
                  </p>
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
