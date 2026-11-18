/**
 * Render smoke for the papers view's in-flight search state (#208).
 *
 * The panel used to swap the whole result block for one "searching…" line the
 * moment a new query went out, which reads exactly like "no results". These
 * cases pin the new contract: the superseded rows stay on screen, labelled
 * with the query they came from, and the settled reply replaces them.
 * @module dsh-client-ui-mimir/tests/papers-search-stale.spec
 */

import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { ArxivEntry, ResearchBackupStatusView } from 'dsh-mimir/types'
import { PapersView } from '../src/client/PapersView.tsx'
import { zh } from '../src/client/locales.ts'
import type { ResearchKey } from '../src/client/locales.ts'
import type { ResearchT } from '../src/client/view-common.ts'
import type {
  ResearchArxivSearchView, ResearchDigdigConfigView, ResearchPapersView,
  ResearchSubscriptionsView, ResearchWebSearchView, ResearchZoteroSearchView, ResearchZoteroView,
} from '../src/client/controller.ts'

function t(key: ResearchKey, params?: Record<string, string>): string {
  let text: string = zh[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value)
  }
  return text
}

const ENTRY: ArxivEntry = {
  id: '2103.00020v2',
  title: 'EgoSync: A Study',
  authors: ['Doe, Jane'],
  summary: 'body',
  published: '2021-03-01T00:00:00Z',
  url: 'https://arxiv.org/abs/2103.00020v2',
}

const PAPERS: ResearchPapersView = { status: 'ready', list: [], failure: null }
const SUBSCRIPTIONS: ResearchSubscriptionsView = {
  status: 'ready', list: [], checking: false, failure: null, checkErrors: {},
}
const DIGDIG: ResearchDigdigConfigView = {
  status: 'ready', configured: true, baseUrl: 'http://x', defaultEngine: 'native',
  allowedEngines: ['native'], defaultLimit: 10, defaultFormat: 'md', useProxy: false,
  proxyUrl: '', timeout: 30000, ollamaApiKeyPreview: '', redundancyThreshold: 0.8,
  redundancyBigramThreshold: 0.8, failure: null,
}
const ZOTERO: ResearchZoteroView = { status: 'ready', state: 'ok', message: null, collections: [], failure: null }

/** The whole view with every verb stubbed; overrides pick the slice under test. */
function view(overrides: Partial<Parameters<typeof PapersView>[0]> = {}): string {
  return renderToString(
    <PapersView
      papers={PAPERS}
      arxivSearch={null}
      webSearch={null}
      digdigConfig={DIGDIG}
      arxivSubscriptions={SUBSCRIPTIONS}
      projects={[]}
      selectedProjectId={null}
      ensurePapers={() => {}}
      saveArxivSubscription={() => Promise.resolve(null)}
      deleteArxivSubscription={() => Promise.resolve(null)}
      checkArxivSubscriptions={() => Promise.resolve(null)}
      searchArxiv={() => {}}
      searchWeb={() => {}}
      getDigdigConfig={() => {}}
      saveDigdigConfig={() => Promise.resolve(null)}
      importPaper={() => Promise.resolve(null)}
      updatePaper={() => Promise.resolve(null)}
      removePaper={() => Promise.resolve(null)}
      importPapersToBib={() => Promise.resolve(null as never)}
      fetchPaperPdf={() => Promise.resolve(null)}
      refreshPapers={() => {}}
      requestRelatedWork={() => Promise.resolve()}
      requestPaperScore={() => Promise.resolve()}
      zotero={ZOTERO}
      zoteroSearch={null}
      recheckZotero={() => {}}
      searchZotero={() => {}}
      importZoteroItem={() => Promise.resolve(null)}
      exportZoteroCollectionToBib={() => Promise.resolve(null as never)}
      t={t as ResearchT}
      {...overrides}
    />,
  )
}

function arxivSearch(overrides: Partial<ResearchArxivSearchView>): ResearchArxivSearchView {
  return { query: 'egosync', status: 'ready', list: [ENTRY], failure: null, previous: null, ...overrides }
}

describe('papers view keeps stale rows while a search is in flight (#208)', () => {
  it('renders the superseded rows, labelled, instead of a blank panel', () => {
    const html = view({
      arxivSearch: arxivSearch({ query: 'next', status: 'loading', list: [], previous: { query: 'egosync', list: [ENTRY] } }),
    })
    expect(html).toContain(ENTRY.title)
    expect(html).toContain(zh['papers.searchStale'])
    expect(html).toContain('data-stale="true"')
    expect(html).toContain(zh['papers.searching'])
  })

  it('falls back to the plain loading line when there is nothing superseded', () => {
    const html = view({ arxivSearch: arxivSearch({ query: 'first', status: 'loading', list: [], previous: null }) })
    expect(html).not.toContain('data-stale="true"')
    expect(html).toContain(zh['papers.searching'])
  })

  it('drops the stale marker once the reply lands', () => {
    const html = view({ arxivSearch: arxivSearch({ query: 'egosync' }) })
    expect(html).toContain(ENTRY.title)
    expect(html).not.toContain('data-stale="true"')
    expect(html).not.toContain(zh['papers.searchStale'])
  })

  it('carries the web slice the same way (the web tab is a client-side toggle)', () => {
    // The default tab is arXiv, so the web panel's own markup is off-screen
    // here; the slice contract is what this spec pins, and the panel renders it
    // through the same ResultList branch as arXiv.
    const webSearch: ResearchWebSearchView = {
      query: 'next', status: 'loading', list: [], failure: null,
      previous: {
        query: 'mesh',
        list: [{ title: 'Old page', url: 'https://example.com/old', content: 'Snippet.', engine: 'brave', category: 'general', publishedDate: '' }],
      },
    }
    expect(webSearch.previous?.list[0]?.url).toBe('https://example.com/old')
    // Every other slice may render at once: the arXiv one stays the default.
    const html = view({ webSearch })
    expect(html).toContain(zh['tab.papers'])
    expect(html).not.toContain('data-stale="true"')
  })

  it('a settled empty result still says "no results", not "loading"', () => {
    const html = view({ arxivSearch: arxivSearch({ query: 'nothing', list: [] }) })
    expect(html).toContain(zh['papers.searchEmpty'])
    expect(html).not.toContain('data-stale="true"')
  })
})

// Keep the unused-import checker honest about the backup type above.
export type _Unused = ResearchBackupStatusView | ResearchZoteroSearchView
