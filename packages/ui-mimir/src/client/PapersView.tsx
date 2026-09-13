/**
 * The papers view: an arXiv search bar on top (results import into the wiki
 * with one click, auto-linked to the selected project), then the literature
 * library as a card grid — title (linked to the arXiv page), authors, added
 * date, the AI relevance chip of the selected project's verdict, a
 * three-line-clamped summary the reader can expand, tag pills and
 * linked-project badges, the agent's working notes, a PDF section (fetch the
 * arXiv PDF into the workspace, then read it inline or fullscreen on the
 * `/research/paper-pdf/<id>` route, with a reading-notes side panel appending
 * timestamped entries into the record's notes), and edit/delete actions. The
 * edit action opens an inline editor (tags, project links, notes); a filter
 * bar above the grid narrows the library by one tag and/or the currently
 * selected project (the project filter defaults ON while a project is
 * selected, so each project's literature view shows its own papers); each
 * card can be appended to the selected project's `references.bib` in one
 * click. Toolbar buttons hand the currently filtered selection to the current
 * session's agent: "draft the related work section" and "score relevance"
 * (the agent's `wiki_note set_paper` verdicts land in the cards' relevance
 * chips, picked up by a quiet poll while a scoring request is in flight).
 * @module dsh-client-ui-mimir/client/PapersView
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ArxivEntry, PaperRecord, ResearchProjectView, WebSearchEntry } from 'dsh-mimir/types'
import type {
  ResearchArxivSearchView, ResearchFailureView, ResearchImportCounts, ResearchPapersView, ResearchWebSearchView,
  ResearchSxngConfigView,  ResearchSubscriptionsView, ResearchZoteroSearchView, ResearchZoteroView,
} from './controller.ts'
import { arxivIdFromUrl, collectTags, failureCopy, filterPapers, paperPdfUrl, type ResearchT } from './view-common.ts'
import { appendReadingNote, parseReadingNotes } from './paper-notes.ts'
import { buildPaperScorePrompt } from './paper-score.ts'
import { buildRelatedWorkPrompt } from './related-work.ts'
import { EmptyState } from './EmptyState.tsx'
import { SubscriptionsBar } from './SubscriptionsBar.tsx'
import { ViewHead } from './ViewHead.tsx'
import { ZoteroSection } from './ZoteroSection.tsx'
import css from './ResearchPanel.module.css'

/** Fields the inline editor saves back through `updatePaper`. */
interface PaperPatch {
  readonly tags?: string[]
  readonly projectIds?: string[]
  readonly notes?: string
}

/** Settle feedback of one card's add-to-bibliography button. */
type AddToBibState = 'idle' | 'adding' | 'added' | 'exists'

/** How long the added/exists feedback shows before the button resets. */
const ADD_TO_BIB_RESET_MS = 2000

/**
 * One card's PDF section: a fetch button (downloads the arXiv PDF into the
 * workspace through `fetchPaperPdf`, labeled refetch once linked) and, once
 * the record carries a `pdfPath`, a read toggle opening the embedded iframe
 * reader on the `/research/paper-pdf/<id>` route next to the reading-notes
 * side panel, plus a fullscreen button lifting the same reader into a
 * viewport-sized overlay (Esc or the header button exits). A successful fetch
 * bumps the cache-bust version and opens the reader. The overlay is portaled
 * to `document.body`: rendered inside the card, the card's `backdrop-filter`
 * (and hover `transform`) would become its containing block and trap the
 * `position: fixed` overlay inside the card's box.
 */
function PaperPdfSection({ paper, fetchPaperPdf, updatePaper, onError, t }: {
  readonly paper: PaperRecord
  readonly fetchPaperPdf: (arxivId: string) => Promise<ResearchFailureView | null>
  readonly updatePaper: (arxivId: string, patch: PaperPatch) => Promise<ResearchFailureView | null>
  readonly onError: (message: string) => void
  readonly t: ResearchT
}) {
  const [fetching, setFetching] = useState(false)
  const [readerOpen, setReaderOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [version, setVersion] = useState(() => Date.now())

  const fetchPdf = (): void => {
    if (fetching) return
    setFetching(true)
    void fetchPaperPdf(paper.arxivId)
      .then((failure) => {
        if (failure === null) {
          setVersion(Date.now())
          setReaderOpen(true)
        } else {
          onError(`${t('papers.fetchPdfFailed')}：${failure.message}`)
        }
      })
      .finally(() => { setFetching(false) })
  }

  return (
    <div className={css.paperPdf}>
      {paper.pdfPath !== undefined && readerOpen && (
        <div className={css.paperPdfReader}>
          <iframe
            className={css.paperPdfFrame}
            title={`${t('papers.readPdf')}：${paper.title}`}
            src={paperPdfUrl(paper.arxivId, version)}
          />
          <PaperNotesPanel paper={paper} updatePaper={updatePaper} onError={onError} t={t} />
        </div>
      )}
      <div className={css.paperPdfActions}>
        <button
          type="button"
          className={css.btn}
          disabled={fetching}
          onClick={fetchPdf}
        >
          {fetching
            ? t('papers.fetchingPdf')
            : paper.pdfPath === undefined ? t('papers.fetchPdf') : t('papers.refetchPdf')}
        </button>
        {paper.pdfPath !== undefined && (
          <button
            type="button"
            className={css.btn}
            data-active={readerOpen || undefined}
            aria-expanded={readerOpen}
            onClick={() => { setReaderOpen(prev => !prev) }}
          >
            {readerOpen ? t('papers.closePdf') : t('papers.readPdf')}
          </button>
        )}
        {paper.pdfPath !== undefined && (
          <button
            type="button"
            className={css.btn}
            onClick={() => { setFullscreen(true) }}
          >
            {t('papers.fullscreenPdf')}
          </button>
        )}
      </div>
      {paper.pdfPath !== undefined && fullscreen && createPortal(
        <div
          className={css.paperPdfOverlay}
          role="dialog"
          aria-label={`${t('papers.readPdf')}：${paper.title}`}
          tabIndex={-1}
          // Focus the overlay on open so Esc reaches it; Esc closes only the
          // overlay (stopPropagation keeps the panel's Esc-to-close).
          ref={(element) => { element?.focus() }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            event.preventDefault()
            setFullscreen(false)
          }}
        >
          <div className={css.paperPdfOverlayHead}>
            <span className={css.paperPdfOverlayTitle} title={paper.title}>{paper.title}</span>
            <button
              type="button"
              className={css.btn}
              onClick={() => { setFullscreen(false) }}
            >
              {t('papers.exitFullscreen')}
            </button>
          </div>
          <div className={css.paperPdfOverlayBody}>
            <iframe
              className={css.paperPdfOverlayFrame}
              title={`${t('papers.readPdf')}：${paper.title}`}
              src={paperPdfUrl(paper.arxivId, version)}
            />
            <PaperNotesPanel paper={paper} updatePaper={updatePaper} onError={onError} t={t} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

/**
 * The reading-notes side panel next to the open PDF reader: the record's
 * entries (parsed out of `notes`, legacy/agent-written blocks included) as
 * a list, then a quick-add box appending a new `[YYYY-MM-DD HH:mm]` entry
 * through the existing `updatePaper` verb. The entry list re-derives from
 * the refreshed record after every save.
 */
function PaperNotesPanel({ paper, updatePaper, onError, t }: {
  readonly paper: PaperRecord
  readonly updatePaper: (arxivId: string, patch: PaperPatch) => Promise<ResearchFailureView | null>
  readonly onError: (message: string) => void
  readonly t: ResearchT
}) {
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const entries = parseReadingNotes(paper.notes)

  const addNote = (): void => {
    if (saving || draft.trim() === '') return
    setSaving(true)
    void updatePaper(paper.arxivId, { notes: appendReadingNote(paper.notes, draft, new Date()) })
      .then((failure) => {
        if (failure === null) {
          setDraft('')
        } else {
          onError(`${t('papers.addNoteFailed')}：${failure.message}`)
        }
      })
      .finally(() => { setSaving(false) })
  }

  return (
    <aside className={css.paperNotesPanel}>
      <h4 className={css.paperNotesTitle}>{t('papers.readingNotes')}</h4>
      {entries.length === 0 ? (
        <p className={css.hint}>{t('papers.readingNotesEmpty')}</p>
      ) : (
        <div className={css.paperNoteList}>
          {entries.map((entry, index) => (
            <div key={`${entry.at}-${index}`} className={css.paperNoteItem}>
              {entry.at !== '' && <span className={css.paperNoteAt}>{entry.at}</span>}
              <p className={css.paperNoteText}>{entry.text}</p>
            </div>
          ))}
        </div>
      )}
      <textarea
        className={css.input}
        rows={3}
        value={draft}
        placeholder={t('papers.noteInputPlaceholder')}
        onChange={event => { setDraft(event.target.value) }}
      />
      <button
        type="button"
        className={css.btnPrimary}
        disabled={saving || draft.trim() === ''}
        onClick={addNote}
      >
        {saving ? t('papers.addingNote') : t('papers.addNote')}
      </button>
    </aside>
  )
}

/**
 * One card's "add to bibliography" button: appends the paper to the selected
 * project's `references.bib` and shows the settled outcome briefly. Disabled
 * until a project is selected.
 */
function AddToBibButton({ paper, projectId, importPapersToBib, onError, t }: {
  readonly paper: PaperRecord
  readonly projectId: string | null
  readonly importPapersToBib: (
    projectId: string,
    arxivIds: string[],
  ) => Promise<ResearchFailureView | ResearchImportCounts>
  readonly onError: (message: string) => void
  readonly t: ResearchT
}) {
  const [state, setState] = useState<AddToBibState>('idle')
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cancel a pending feedback reset on unmount.
  useEffect(() => () => {
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
  }, [])

  const add = (): void => {
    if (projectId === null || state === 'adding') return
    setState('adding')
    void importPapersToBib(projectId, [paper.arxivId]).then((outcome) => {
      if ('code' in outcome) {
        setState('idle')
        onError(`${t('papers.addToBibFailed')}：${outcome.message}`)
        return
      }
      setState(outcome.added.length > 0 ? 'added' : 'exists')
      resetTimerRef.current = setTimeout(() => { setState('idle') }, ADD_TO_BIB_RESET_MS)
    })
  }

  const copy = state === 'adding'
    ? t('papers.addingToBib')
    : state === 'added'
      ? t('papers.addedToBib')
      : state === 'exists'
        ? t('papers.alreadyInBib')
        : t('papers.addToBib')
  return (
    <button
      type="button"
      className={css.btn}
      disabled={projectId === null || state === 'adding'}
      title={projectId === null ? t('bib.noProject') : undefined}
      onClick={add}
    >
      {copy}
    </button>
  )
}

/** How long an AI-scoring poll runs before its pending marker gives up. */
const SCORE_TIMEOUT_MS = 120_000
/** Poll interval while an AI scoring request is in flight. */
const SCORE_POLL_MS = 5000

/**
 * One card's relevance chip: the AI verdict recorded for the selected
 * project (or, with no selection, the most recent verdict across projects).
 * Colored by score band; the reason rides the tooltip.
 */
function RelevanceChip({ paper, projectId, projects, t }: {
  readonly paper: PaperRecord
  readonly projectId: string | null
  readonly projects: readonly ResearchProjectView[]
  readonly t: ResearchT
}) {
  const verdicts = paper.relevance ?? {}
  const shown = projectId !== null
    ? verdicts[projectId]
    : Object.values(verdicts).sort((left, right) => right.at.localeCompare(left.at))[0]
  if (shown === undefined) return null
  const band = shown.score >= 7 ? 'high' : shown.score >= 4 ? 'mid' : 'low'
  const projectTitle = projects.find(project => verdicts[project.id] === shown)?.title
  const detail = projectId === null && projectTitle !== undefined
    ? `${projectTitle} · ${shown.reason}`
    : shown.reason
  return (
    <span className={css.relevanceChip} data-band={band} title={detail}>
      {t('papers.relevance')} {shown.score.toFixed(shown.score % 1 === 0 ? 0 : 1)}/10
    </span>
  )
}

/**
 * The web search panel (SearXNG results through the sxng CLI): one card per
 * result with the title link, engine/category/date meta, and the snippet.
 * A result whose URL points at an arXiv abstract or PDF gains an import
 * button — the bridge from a generic web hit into the wiki library.
 * @param props - the web search slice, the imported-id set, the in-flight
 * import id, the import verb, the retry verb, and copy.
 */
/** Collapsible editor for sxng-cli's global configuration. */
function SxngConfigPanel({ config, getConfig, saveConfig, t }: {
  readonly config: ResearchSxngConfigView
  readonly getConfig: () => void
  readonly saveConfig: (input: {
    baseUrl?: string; defaultEngine?: string; allowedEngines?: readonly string[]; defaultLimit?: number
    defaultFormat?: 'md' | 'json'; useProxy?: boolean; proxyUrl?: string; timeout?: number
    ollamaApiKey?: string; redundancyThreshold?: number; redundancyBigramThreshold?: number
  }) => Promise<ResearchFailureView | null>
  readonly t: ResearchT
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Partial<{
    baseUrl: string; defaultEngine: string; allowedEngines: string; defaultLimit: string; defaultFormat: 'md' | 'json'
    useProxy: boolean; proxyUrl: string; timeout: string; ollamaApiKey: string; redundancyThreshold: string; redundancyBigramThreshold: string
  }>>({})
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<ResearchFailureView | null>(null)
  useEffect(() => { getConfig() }, [getConfig])
  const toggle = (): void => {
    if (!open) setDraft({ baseUrl: config.baseUrl, defaultEngine: config.defaultEngine, allowedEngines: config.allowedEngines.join(', '), defaultLimit: String(config.defaultLimit), defaultFormat: config.defaultFormat, useProxy: config.useProxy, proxyUrl: config.proxyUrl, timeout: String(config.timeout), ollamaApiKey: '', redundancyThreshold: String(config.redundancyThreshold), redundancyBigramThreshold: String(config.redundancyBigramThreshold) })
    setFailure(null); setOpen(value => !value)
  }
  const save = (): void => {
    if (saving) return
    setSaving(true); setFailure(null)
    void saveConfig({
      ...(draft.baseUrl?.trim() === '' || draft.baseUrl === undefined ? {} : { baseUrl: draft.baseUrl.trim() }),
      ...(draft.defaultEngine === undefined ? {} : { defaultEngine: draft.defaultEngine }),
      ...(draft.allowedEngines === undefined ? {} : { allowedEngines: draft.allowedEngines.split(',').map(value => value.trim()).filter(Boolean) }),
      ...(draft.defaultLimit === undefined ? {} : { defaultLimit: Number(draft.defaultLimit) }),
      ...(draft.defaultFormat === undefined ? {} : { defaultFormat: draft.defaultFormat }),
      ...(draft.useProxy === undefined ? {} : { useProxy: draft.useProxy }),
      ...(draft.proxyUrl === undefined ? {} : { proxyUrl: draft.proxyUrl }),
      ...(draft.timeout === undefined ? {} : { timeout: Number(draft.timeout) }),
      ...(draft.ollamaApiKey === undefined || draft.ollamaApiKey === '' ? {} : { ollamaApiKey: draft.ollamaApiKey }),
      ...(draft.redundancyThreshold === undefined ? {} : { redundancyThreshold: Number(draft.redundancyThreshold) }),
      ...(draft.redundancyBigramThreshold === undefined ? {} : { redundancyBigramThreshold: Number(draft.redundancyBigramThreshold) }),
    }).then(result => { if (result !== null) setFailure(result); else setOpen(false) }).finally(() => { setSaving(false) })
  }
  return <section className={css.imageGenPanel}>
    <button type="button" className={css.imageGenToggle} aria-expanded={open} onClick={toggle}><span aria-hidden>{open ? '▾' : '▸'}</span>{t('papers.sxngConfig')}{config.configured && <span className={css.imageGenBadge}>{t('papers.sxngConfigured')}</span>}</button>
    {open && <div className={css.meetingFormRow}>
      <input className={css.input} value={draft.baseUrl ?? ''} placeholder="baseUrl" aria-label="baseUrl" onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} />
      <input className={css.input} value={draft.defaultEngine ?? ''} placeholder="defaultEngine" aria-label="defaultEngine" onChange={e => setDraft({ ...draft, defaultEngine: e.target.value })} />
      <input className={css.input} value={draft.allowedEngines ?? ''} placeholder="allowedEngines (comma separated)" aria-label="allowedEngines" onChange={e => setDraft({ ...draft, allowedEngines: e.target.value })} />
      <input className={css.input} type="number" value={draft.defaultLimit ?? ''} placeholder="defaultLimit" aria-label="defaultLimit" onChange={e => setDraft({ ...draft, defaultLimit: e.target.value })} />
      <select className={css.input} value={draft.defaultFormat ?? 'md'} aria-label="defaultFormat" onChange={e => setDraft({ ...draft, defaultFormat: e.target.value as 'md' | 'json' })}><option value="md">md</option><option value="json">json</option></select>
      <label><input type="checkbox" checked={draft.useProxy ?? false} onChange={e => setDraft({ ...draft, useProxy: e.target.checked })} /> useProxy</label>
      <input className={css.input} value={draft.proxyUrl ?? ''} placeholder="proxyUrl" aria-label="proxyUrl" onChange={e => setDraft({ ...draft, proxyUrl: e.target.value })} />
      <input className={css.input} type="number" value={draft.timeout ?? ''} placeholder="timeout (ms)" aria-label="timeout" onChange={e => setDraft({ ...draft, timeout: e.target.value })} />
      <input className={css.input} type="password" value={draft.ollamaApiKey ?? ''} placeholder={config.ollamaApiKeyPreview || 'ollamaApiKey'} aria-label="ollamaApiKey" onChange={e => setDraft({ ...draft, ollamaApiKey: e.target.value })} />
      <input className={css.input} type="number" step="0.01" value={draft.redundancyThreshold ?? ''} placeholder="redundancyThreshold" aria-label="redundancyThreshold" onChange={e => setDraft({ ...draft, redundancyThreshold: e.target.value })} />
      <input className={css.input} type="number" step="0.01" value={draft.redundancyBigramThreshold ?? ''} placeholder="redundancyBigramThreshold" aria-label="redundancyBigramThreshold" onChange={e => setDraft({ ...draft, redundancyBigramThreshold: e.target.value })} />
      <button type="button" className={css.btnPrimary} disabled={saving} onClick={save}>{saving ? t('papers.sxngSaving') : t('papers.sxngSave')}</button>
      {failure !== null && <p className={css.failure} role="alert">{failure.message}</p>}
    </div>}
  </section>
}

function WebSearchPanel({
  webSearch, importedIds, importing, importEntry, searchWeb, t,
}: {
  readonly webSearch: ResearchWebSearchView | null
  readonly importedIds: ReadonlySet<string>
  readonly importing: string | null
  readonly importEntry: (entry: ArxivEntry) => void
  readonly searchWeb: (query: string) => void
  readonly t: ResearchT
}) {
  if (webSearch === null) return null
  return (
    <section className={css.papersSearchPanel}>
      <h3 className={css.sectionTitle}>
        {t('papers.webSearchResults')}：{webSearch.query}
      </h3>
      {webSearch.status === 'loading' ? (
        <p className={css.hint}>{t('papers.searching')}</p>
      ) : webSearch.status === 'error' ? (
        <p className={css.failure} role="alert">
          {t('error.webSearch')}：{failureCopy(t, webSearch.failure)}
          <button type="button" className={css.btn} onClick={() => { searchWeb(webSearch.query) }}>
            {t('error.retry')}
          </button>
        </p>
      ) : webSearch.list.length === 0 ? (
        <p className={css.hint}>{t('papers.webSearchEmpty')}</p>
      ) : (
        <div className={css.papersResults}>
          {webSearch.list.map(entry => (
            <WebResultCard
              key={entry.url}
              entry={entry}
              imported={importedIds.has(arxivIdFromUrl(entry.url) ?? '')}
              importing={importing === arxivIdFromUrl(entry.url)}
              importEntry={importEntry}
              t={t}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * One web result card. When the URL names an arXiv paper not yet in the
 * library, an import button builds an {@link ArxivEntry} from the row and
 * hands it to the shared import flow.
 */
function WebResultCard({ entry, imported, importing, importEntry, t }: {
  readonly entry: WebSearchEntry
  readonly imported: boolean
  readonly importing: boolean
  readonly importEntry: (entry: ArxivEntry) => void
  readonly t: ResearchT
}) {
  const arxivId = arxivIdFromUrl(entry.url)
  return (
    <article key={entry.url} className={css.paperResult}>
      <div className={css.paperResultHead}>
        <h3 className={css.paperCardTitle}>
          <a href={entry.url} target="_blank" rel="noreferrer">
            {entry.title === '' ? entry.url : entry.title}
          </a>
        </h3>
        {arxivId !== null && (
          imported ? (
            <button type="button" className={css.btn} disabled>{t('papers.imported')}</button>
          ) : (
            <button
              type="button"
              className={css.btnPrimary}
              disabled={importing}
              onClick={() => {
                importEntry({
                  id: arxivId,
                  title: entry.title,
                  authors: [],
                  summary: entry.content,
                  published: entry.publishedDate,
                  url: `https://arxiv.org/abs/${arxivId}`,
                })
              }}
            >
              {importing ? t('papers.importing') : t('papers.import')}
            </button>
          )
        )}
      </div>
      <p className={css.paperCardMeta}>
        {`${t('papers.engine')}：${entry.engine === '' ? '—' : entry.engine}`}
        {entry.category !== '' && ` · ${entry.category}`}
        {entry.publishedDate !== '' && ` · ${entry.publishedDate.slice(0, 10)}`}
      </p>
      {entry.content !== '' && <p className={css.paperSummary} data-static>{entry.content}</p>}
    </article>
  )
}

/**
 * @param props - the literature view, the arXiv search slice, the project
 * list (for link checkboxes and badges), the selected project (the
 * current-project filter), the load/search/import/update/remove verbs, and
 * copy.
 * @returns the search bar and results over the filterable library grid.
 */
export function PapersView({
  papers, arxivSearch, webSearch, sxngConfig, arxivSubscriptions, projects, selectedProjectId, ensurePapers, searchArxiv, searchWeb,
  getSxngConfig, saveSxngConfig,
  saveArxivSubscription, deleteArxivSubscription, checkArxivSubscriptions,
  importPaper, updatePaper, removePaper, importPapersToBib, fetchPaperPdf,
  zotero, zoteroSearch, recheckZotero, searchZotero, importZoteroItem, exportZoteroCollectionToBib,
  refreshPapers, requestRelatedWork, requestPaperScore, t,
}: {
  readonly papers: ResearchPapersView
  readonly arxivSearch: ResearchArxivSearchView | null
  readonly webSearch: ResearchWebSearchView | null
  readonly sxngConfig: ResearchSxngConfigView
  readonly arxivSubscriptions: ResearchSubscriptionsView
  readonly projects: readonly ResearchProjectView[]
  readonly selectedProjectId: string | null
  readonly ensurePapers: () => void
  readonly saveArxivSubscription: (query: string) => Promise<ResearchFailureView | null>
  readonly deleteArxivSubscription: (id: string) => Promise<ResearchFailureView | null>
  readonly checkArxivSubscriptions: () => Promise<ResearchFailureView | null>
  readonly searchArxiv: (query: string) => void
  readonly searchWeb: (query: string) => void
  readonly getSxngConfig: () => void
  readonly saveSxngConfig: (input: {
    baseUrl?: string; defaultEngine?: string; allowedEngines?: readonly string[]; defaultLimit?: number
    defaultFormat?: 'md' | 'json'; useProxy?: boolean; proxyUrl?: string; timeout?: number
    ollamaApiKey?: string; redundancyThreshold?: number; redundancyBigramThreshold?: number
  }) => Promise<ResearchFailureView | null>
  readonly importPaper: (entry: ArxivEntry, projectId?: string) => Promise<ResearchFailureView | null>
  readonly updatePaper: (arxivId: string, patch: PaperPatch) => Promise<ResearchFailureView | null>
  readonly removePaper: (arxivId: string) => Promise<ResearchFailureView | null>
  readonly importPapersToBib: (
    projectId: string,
    arxivIds: string[],
  ) => Promise<ResearchFailureView | ResearchImportCounts>
  readonly fetchPaperPdf: (arxivId: string) => Promise<ResearchFailureView | null>
  readonly zotero: ResearchZoteroView
  readonly zoteroSearch: ResearchZoteroSearchView | null
  readonly recheckZotero: () => void
  readonly searchZotero: (query: string) => void
  readonly importZoteroItem: (key: string, projectId?: string) => Promise<ResearchFailureView | null>
  readonly exportZoteroCollectionToBib: (
    projectId: string,
    collectionKey: string,
  ) => Promise<ResearchFailureView | ResearchImportCounts>
  readonly requestRelatedWork: (prompt: string) => Promise<void>
  /** Re-fetch the literature list without a loading flash (the scoring poll). */
  readonly refreshPapers: () => void
  /** Hand one assembled relevance-scoring prompt to the current session's agent. */
  readonly requestPaperScore: (prompt: string) => Promise<void>
  readonly t: ResearchT
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'arxiv' | 'web'>('arxiv')
  const [importing, setImporting] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  // Tri-state project filter: null follows the default (ON while a project is
  // selected, so each project sees its own literature); an explicit toggle
  // sticks until the selection changes.
  const [currentOnlyOverride, setCurrentOnlyOverride] = useState<boolean | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [draftProjectIds, setDraftProjectIds] = useState<string[]>([])
  const [draftNotes, setDraftNotes] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [saving, setSaving] = useState(false)
  // In-flight AI scoring requests, keyed by arXiv id; the value is the
  // request's start time for the timeout.
  const [scoring, setScoring] = useState<Readonly<Record<string, number>>>({})
  // The relevance timestamp each in-flight scoring started from; a newer one
  // means the agent's verdict landed.
  const scoringAnchor = useRef<Record<string, string | undefined>>({})
  const importedIds = new Set(papers.list.map(paper => paper.arxivId))
  const allTags = collectTags(papers.list)
  const currentOnly = currentOnlyOverride ?? selectedProjectId !== null
  const visible = filterPapers(papers.list, activeTag, currentOnly ? selectedProjectId : null)
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null

  // Switching projects reverts the filter to its default (on) and drops
  // scoring markers of the previous project.
  const previousProject = useRef<string | null>(selectedProjectId)
  useEffect(() => {
    if (previousProject.current === selectedProjectId) return
    previousProject.current = selectedProjectId
    setCurrentOnlyOverride(null)
    setScoring({})
  }, [selectedProjectId])

  // Poll the literature list while any scoring request is in flight.
  const scoringCount = Object.keys(scoring).length
  useEffect(() => {
    if (scoringCount === 0) return
    const timer = setInterval(() => { refreshPapers() }, SCORE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [scoringCount, refreshPapers])

  // Retire the ids whose verdict landed (a timestamp newer than the anchor)
  // or whose request timed out.
  useEffect(() => {
    setScoring((prev) => {
      const entries = Object.entries(prev).filter(([id, startedAt]) => {
        if (Date.now() - startedAt > SCORE_TIMEOUT_MS) return false
        if (selectedProjectId === null) return false
        const paper = papers.list.find(record => record.arxivId === id)
        const at = paper?.relevance?.[selectedProjectId]?.at
        return at === undefined || at === scoringAnchor.current[id]
      })
      return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries)
    })
  }, [papers.list, selectedProjectId])

  /**
   * Hand one paper (or the whole filtered selection) to the current session's
   * agent for relevance scoring; the agent's wiki_note writes land in the
   * poll's refreshes.
   */
  const scoreWithAi = (targets: readonly PaperRecord[]): void => {
    if (selectedProject === null || targets.length === 0) return
    setActionError(null)
    const now = Date.now()
    for (const paper of targets) {
      scoringAnchor.current[paper.arxivId] = paper.relevance?.[selectedProject.id]?.at
    }
    setScoring((prev) => {
      const next = { ...prev }
      for (const paper of targets) next[paper.arxivId] = now
      return next
    })
    void requestPaperScore(buildPaperScorePrompt({
      papers: targets,
      projectId: selectedProject.id,
      projectTitle: selectedProject.title,
    }))
  }

  // The related-work button covers exactly the papers on screen (the tag /
  // current-project filter IS the selection), and lands in toasts.
  const draftRelatedWork = (): void => {
    if (selectedProject === null || visible.length === 0) return
    setActionError(null)
    void requestRelatedWork(buildRelatedWorkPrompt({
      papers: visible,
      projectTitle: selectedProject.title,
      dir: selectedProject.paperDir,
    }))
  }

  const submitSearch = (): void => {
    if (query.trim() === '') return
    setActionError(null)
    if (source === 'web') searchWeb(query)
    else searchArxiv(query)
  }
  const importEntry = (entry: ArxivEntry): void => {
    if (importing !== null) return
    setImporting(entry.id)
    setActionError(null)
    void importPaper(entry, selectedProjectId ?? undefined)
      .then((failure) => {
        setActionError(failure === null ? null : `${t('papers.importFailed')}：${failure.message}`)
      })
      .finally(() => { setImporting(null) })
  }
  const removeEntry = (paper: PaperRecord): void => {
    if (!window.confirm(t('papers.confirmDelete'))) return
    setActionError(null)
    void removePaper(paper.arxivId).then((failure) => {
      setActionError(failure === null ? null : `${t('papers.deleteFailed')}：${failure.message}`)
    })
  }

  const openEdit = (paper: PaperRecord): void => {
    setEditing(paper.arxivId)
    setDraftTags([...paper.tags])
    setDraftProjectIds([...paper.projectIds])
    setDraftNotes(paper.notes)
    setTagInput('')
    setActionError(null)
  }
  const addTag = (): void => {
    const tag = tagInput.trim()
    if (tag === '') return
    setDraftTags(prev => (prev.includes(tag) ? prev : [...prev, tag]))
    setTagInput('')
  }
  const toggleProject = (projectId: string): void => {
    setDraftProjectIds(prev =>
      prev.includes(projectId) ? prev.filter(id => id !== projectId) : [...prev, projectId])
  }
  const saveEdit = (paper: PaperRecord): void => {
    if (saving) return
    // A tag typed but not yet committed with Enter rides along.
    const pending = tagInput.trim()
    const tags = pending === '' || draftTags.includes(pending) ? draftTags : [...draftTags, pending]
    setSaving(true)
    setActionError(null)
    void updatePaper(paper.arxivId, { tags, projectIds: draftProjectIds, notes: draftNotes })
      .then((failure) => {
        if (failure === null) {
          setEditing(null)
        } else {
          setActionError(`${t('papers.saveFailed')}：${failure.message}`)
        }
      })
      .finally(() => { setSaving(false) })
  }

  /** Project badges of one card: linked project titles, unknown ids shown raw. */
  const projectBadges = (paper: PaperRecord): Array<{ id: string; title: string }> =>
    paper.projectIds.map(id => ({ id, title: projects.find(project => project.id === id)?.title ?? id }))

  return (
    <div className={css.papers}>
      <ViewHead title={t('tab.papers')} subtitle={t('view.papers.subtitle')} />
      <SubscriptionsBar
        subscriptions={arxivSubscriptions}
        importedIds={importedIds}
        importPaper={importPaper}
        saveArxivSubscription={saveArxivSubscription}
        deleteArxivSubscription={deleteArxivSubscription}
        checkArxivSubscriptions={checkArxivSubscriptions}
        t={t}
      />
      <form
        className={css.papersSearchBar}
        onSubmit={(event) => {
          event.preventDefault()
          submitSearch()
        }}
      >
        <div className={css.papersSourceTabs} role="tablist" aria-label={t('papers.search')}>
          {(['arxiv', 'web'] as const).map(tab => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={source === tab}
              className={css.paperTab}
              data-active={source === tab || undefined}
              onClick={() => { setSource(tab) }}
            >
              {t(tab === 'arxiv' ? 'papers.sourceArxiv' : 'papers.sourceWeb')}
            </button>
          ))}
        </div>
        <input
          className={css.input}
          value={query}
          placeholder={t(source === 'web' ? 'papers.webSearchPlaceholder' : 'papers.searchPlaceholder')}
          onChange={event => { setQuery(event.target.value) }}
        />
        <button
          type="submit"
          className={css.btnPrimary}
          disabled={query.trim() === '' || arxivSearch?.status === 'loading' || webSearch?.status === 'loading'}
        >
          {(source === 'arxiv' ? arxivSearch?.status : webSearch?.status) === 'loading' ? t('papers.searching') : t('papers.search')}
        </button>
      </form>
      {source === 'web' && <SxngConfigPanel config={sxngConfig} getConfig={getSxngConfig} saveConfig={saveSxngConfig} t={t} />}
      {actionError !== null && (
        <p className={css.failure} role="alert">{actionError}</p>
      )}
      <ZoteroSection
        zotero={zotero}
        zoteroSearch={zoteroSearch}
        importedIds={importedIds}
        selectedProjectId={selectedProjectId}
        recheckZotero={recheckZotero}
        searchZotero={searchZotero}
        importZoteroItem={importZoteroItem}
        exportZoteroCollectionToBib={exportZoteroCollectionToBib}
        onError={setActionError}
        t={t}
      />
      {source === 'web' ? (
        <WebSearchPanel
          webSearch={webSearch}
          importedIds={importedIds}
          importing={importing}
          importEntry={importEntry}
          searchWeb={searchWeb}
          t={t}
        />
      ) : (
        arxivSearch !== null && (
        <section className={css.papersSearchPanel}>
          <h3 className={css.sectionTitle}>
            {t('papers.searchResults')}：{arxivSearch.query}
          </h3>
          {arxivSearch.status === 'loading' ? (
            <p className={css.hint}>{t('papers.searching')}</p>
          ) : arxivSearch.status === 'error' ? (
            <p className={css.failure} role="alert">
              {t('error.arxivSearch')}：{failureCopy(t, arxivSearch.failure)}
              <button type="button" className={css.btn} onClick={() => { searchArxiv(arxivSearch.query) }}>
                {t('error.retry')}
              </button>
            </p>
          ) : arxivSearch.list.length === 0 ? (
            <p className={css.hint}>{t('papers.searchEmpty')}</p>
          ) : (
            <div className={css.papersResults}>
              {arxivSearch.list.map(entry => (
                <article key={entry.id} className={css.paperResult}>
                  <div className={css.paperResultHead}>
                    <h3 className={css.paperCardTitle}>
                      <a href={entry.url} target="_blank" rel="noreferrer">
                        {entry.title}
                      </a>
                    </h3>
                    {importedIds.has(entry.id) ? (
                      <button type="button" className={css.btn} disabled>
                        {t('papers.imported')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={css.btnPrimary}
                        disabled={importing !== null}
                        onClick={() => { importEntry(entry) }}
                      >
                        {importing === entry.id ? t('papers.importing') : t('papers.import')}
                      </button>
                    )}
                  </div>
                  <p className={css.paperCardMeta}>
                    {entry.authors.length > 0 && `${entry.authors.join('，')} · `}
                    {entry.published.slice(0, 4)}
                  </p>
                  <p className={css.paperSummary} data-static>{entry.summary}</p>
                </article>
              ))}
            </div>
          )}
        </section>
        )
      )}
      {papers.status === 'cold' || papers.status === 'loading' ? (
        <p className={css.hint}>{t('papers.loading')}</p>
      ) : papers.status === 'error' ? (
        <p className={css.failure} role="alert">
          {t('error.papers')}：{failureCopy(t, papers.failure)}
          <button type="button" className={css.btn} onClick={ensurePapers}>
            {t('error.retry')}
          </button>
        </p>
      ) : papers.list.length === 0 ? (
        <EmptyState glyph="📚">{t('papers.empty')}</EmptyState>
      ) : (
        <>
          <div className={css.papersFilters}>
            <button
              type="button"
              className={css.btnPrimary}
              disabled={selectedProject === null || visible.length === 0}
              title={selectedProject === null ? t('bib.noProject') : t('papers.relworkScope')}
              onClick={draftRelatedWork}
            >
              {t('papers.relwork')} × {visible.length}
            </button>
            <button
              type="button"
              className={css.btn}
              disabled={selectedProject === null || visible.length === 0 || scoringCount > 0}
              title={selectedProject === null ? t('papers.scoreNeedProject') : t('papers.scoreWithAiScope')}
              onClick={() => { scoreWithAi(visible) }}
            >
              {t('papers.scoreWithAi')} × {visible.length}
            </button>
          </div>
          {(allTags.length > 0 || selectedProjectId !== null) && (
            <div className={css.papersFilters}>
              {allTags.map(tag => (
                <button
                  key={tag}
                  type="button"
                  className={css.tagPill}
                  data-active={activeTag === tag || undefined}
                  aria-pressed={activeTag === tag}
                  onClick={() => { setActiveTag(prev => (prev === tag ? null : tag)) }}
                >
                  {tag}
                </button>
              ))}
              {selectedProjectId !== null && (
                <button
                  type="button"
                  className={css.tagPill}
                  data-kind="project"
                  data-active={currentOnly || undefined}
                  aria-pressed={currentOnly}
                  onClick={() => { setCurrentOnlyOverride(!currentOnly) }}
                >
                  {t('papers.currentProjectOnly')}
                </button>
              )}
            </div>
          )}
          {visible.length === 0 ? (
            <p className={css.hint}>{t('papers.noMatch')}</p>
          ) : (
            <div className={css.papersGrid}>
              {visible.map((paper) => {
                const open = Boolean(expanded[paper.arxivId])
                const badges = projectBadges(paper)
                return (
                  <article key={paper.arxivId} className={css.paperCard}>
                    <h3 className={css.paperCardTitle}>
                      {paper.url === ''
                        ? paper.title
                        : (
                          <a href={paper.url} target="_blank" rel="noreferrer">
                            {paper.title}
                          </a>
                        )}
                    </h3>
                    <p className={css.paperCardMeta}>
                      {paper.authors.length > 0 && `${paper.authors.join('，')} · `}
                      {t('papers.addedAt')}
                      {' '}
                      {paper.addedAt.slice(0, 10)}
                      {' '}
                      <RelevanceChip paper={paper} projectId={selectedProjectId} projects={projects} t={t} />
                    </p>
                    {(paper.tags.length > 0 || badges.length > 0) && (
                      <p className={css.paperTags}>
                        {paper.tags.map(tag => (
                          <button
                            key={tag}
                            type="button"
                            className={css.tagPill}
                            data-active={activeTag === tag || undefined}
                            aria-pressed={activeTag === tag}
                            onClick={() => { setActiveTag(prev => (prev === tag ? null : tag)) }}
                          >
                            {tag}
                          </button>
                        ))}
                        {badges.map(badge => (
                          <span key={badge.id} className={css.projectBadge} title={badge.title}>
                            {badge.title}
                          </span>
                        ))}
                      </p>
                    )}
                    <button
                      type="button"
                      className={css.paperSummary}
                      data-open={open || undefined}
                      aria-expanded={open}
                      onClick={() => {
                        setExpanded(prev => ({ ...prev, [paper.arxivId]: !prev[paper.arxivId] }))
                      }}
                    >
                      {paper.summary}
                    </button>
                    {paper.notes !== '' && editing !== paper.arxivId && (
                      <p className={css.paperNotes}>{t('papers.notes')}：{paper.notes}</p>
                    )}
                    {editing === paper.arxivId && (
                      <div className={css.paperEditor}>
                        <span className={css.paperEditorLabel}>{t('papers.tags')}</span>
                        <div className={css.tagEditor}>
                          {draftTags.map(tag => (
                            <span key={tag} className={css.tagPill} data-static>
                              {tag}
                              <button
                                type="button"
                                className={css.tagRemove}
                                aria-label={`${t('papers.removeTag')} ${tag}`}
                                onClick={() => { setDraftTags(prev => prev.filter(item => item !== tag)) }}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          <input
                            className={css.input}
                            value={tagInput}
                            placeholder={t('papers.tagInputPlaceholder')}
                            onChange={event => { setTagInput(event.target.value) }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ',') {
                                event.preventDefault()
                                addTag()
                              }
                            }}
                          />
                        </div>
                        <span className={css.paperEditorLabel}>{t('papers.projects')}</span>
                        <div className={css.projectChecks}>
                          {projects.map(project => (
                            <label key={project.id} className={css.projectCheck}>
                              <input
                                type="checkbox"
                                checked={draftProjectIds.includes(project.id)}
                                onChange={() => { toggleProject(project.id) }}
                              />
                              {project.title}
                            </label>
                          ))}
                        </div>
                        <span className={css.paperEditorLabel}>{t('papers.notes')}</span>
                        <textarea
                          className={css.input}
                          rows={3}
                          value={draftNotes}
                          onChange={event => { setDraftNotes(event.target.value) }}
                        />
                        <div className={css.paperEditorFoot}>
                          <button
                            type="button"
                            className={css.btnPrimary}
                            disabled={saving}
                            onClick={() => { saveEdit(paper) }}
                          >
                            {saving ? t('papers.saving') : t('papers.save')}
                          </button>
                          <button
                            type="button"
                            className={css.btn}
                            disabled={saving}
                            onClick={() => { setEditing(null) }}
                          >
                            {t('papers.cancel')}
                          </button>
                        </div>
                      </div>
                    )}
                    <PaperPdfSection
                      paper={paper}
                      fetchPaperPdf={fetchPaperPdf}
                      updatePaper={updatePaper}
                      onError={setActionError}
                      t={t}
                    />
                    <div className={css.paperCardFoot}>
                      {editing !== paper.arxivId && (
                        <button
                          type="button"
                          className={css.btn}
                          onClick={() => { openEdit(paper) }}
                        >
                          {t('papers.edit')}
                        </button>
                      )}
                      <button
                        type="button"
                        className={css.btn}
                        disabled={selectedProject === null || scoring[paper.arxivId] !== undefined}
                        title={selectedProject === null ? t('papers.scoreNeedProject') : t('papers.scoreWithAiScope')}
                        onClick={() => { scoreWithAi([paper]) }}
                      >
                        {scoring[paper.arxivId] === undefined ? t('papers.scoreWithAi') : t('papers.scoring')}
                      </button>
                      <AddToBibButton
                        paper={paper}
                        projectId={selectedProjectId}
                        importPapersToBib={importPapersToBib}
                        onError={setActionError}
                        t={t}
                      />
                      <button
                        type="button"
                        className={css.btn}
                        data-danger
                        onClick={() => { removeEntry(paper) }}
                      >
                        {t('papers.delete')}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
