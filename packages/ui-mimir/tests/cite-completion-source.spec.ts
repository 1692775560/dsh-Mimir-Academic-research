/**
 * `\cite` candidates come from the project's own bibliography (#154).
 *
 * The pure table is covered in `latex-completion.spec.ts`; this is the other
 * half of the issue's Done-when — that the rows a writer sees after typing
 * `\cite{` are the entries `research/getBibliography` returned for *that*
 * project, not a global list and not a stale one from the previous project.
 */
import { describe, expect, it } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ResearchBibliographyResult, ResearchResult } from 'dsh-mimir/types'
import { ResearchController, type ResearchRemote } from '../src/client/controller.ts'
import { citationItemsOf, filterCompletion } from '../src/client/completion.ts'

function carried<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** The inner (business) envelope; distinct from the transport's `carried`. */
function businessOk<T>(value: T): ResearchResult<T> {
  return { ok: true, value }
}

/** A remote that answers `getBibliography` and rejects everything else. */
function stubRemote(overrides: Partial<ResearchRemote>): ResearchRemote {
  const target: Record<PropertyKey, unknown> = {}
  const stub = new Proxy(target, {
    get: (inner, property) => {
      if (property in inner) return inner[property]
      // Keep the stub non-thenable so it is never accidentally awaited.
      if (property === 'then') return undefined
      return () => Promise.reject(new Error(`unexpected ${String(property)} call`))
    },
  })
  return Object.assign(stub as unknown as ResearchRemote, overrides)
}

/**
 * The panel's Remote face carries two envelopes: the transport result wraps the
 * business result (`RemoteResult<ResearchResult<T>>`). Both are needed, or the
 * controller reports a transport failure instead of the entries.
 */
function bibliography(entries: readonly { key: string; title: string }[]): RemoteResult<ResearchBibliographyResult> {
  return carried<ResearchBibliographyResult>(businessOk({
    entries: entries.map(entry => ({ key: entry.key, type: 'misc' as const, fields: { title: entry.title } })),
    mtimeMs: 1,
  }))
}

/** Let the controller's promise chain settle. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('cite completion source (#154)', () => {
  it('offers the keys the project bibliography returned, with their titles', async () => {
    const seen: string[] = []
    const controller = new ResearchController(stubRemote({
      getBibliography: (request) => {
        seen.push(request.projectId)
        return Promise.resolve(bibliography([
          { key: 'vaswani2017attention', title: 'Attention Is All You Need' },
          { key: 'he2016deep', title: 'Deep Residual Learning' },
        ]))
      },
    }))
    controller.ensureBibliography('alpha')
    await settle()
    expect(seen).toEqual(['alpha'])
    const bib = controller.getSnapshot().bib
    expect(bib?.failure).toBeNull()
    expect(bib?.status).toBe('ready')
    // This is exactly the table `PaperView` hands to the popover.
    expect(citationItemsOf(bib?.entries ?? [])).toEqual([
      { value: 'vaswani2017attention', detail: 'Attention Is All You Need' },
      { value: 'he2016deep', detail: 'Deep Residual Learning' },
    ])
  })

  it('filters the project keys, not a global list', async () => {
    const controller = new ResearchController(stubRemote({
      getBibliography: () => Promise.resolve(bibliography([
        { key: 'vaswani2017attention', title: 'Attention Is All You Need' },
        { key: 'he2016deep', title: 'Deep Residual Learning' },
      ])),
    }))
    controller.ensureBibliography('alpha')
    await settle()
    const table = citationItemsOf(controller.getSnapshot().bib?.entries ?? [])
    expect(filterCompletion(table, 'he20').map(item => item.value)).toEqual(['he2016deep'])
    // A key from another project's .bib is not offered.
    expect(filterCompletion(table, 'kingma').map(item => item.value)).toEqual([])
  })

  it('swaps the table when the selected project changes', async () => {
    const controller = new ResearchController(stubRemote({
      getBibliography: (request) => Promise.resolve(request.projectId === 'alpha'
        ? bibliography([{ key: 'alpha2024', title: 'Alpha' }])
        : bibliography([{ key: 'beta2023', title: 'Beta' }])),
    }))
    controller.ensureBibliography('alpha')
    await settle()
    expect(citationItemsOf(controller.getSnapshot().bib?.entries ?? []).map(item => item.value))
      .toEqual(['alpha2024'])
    controller.ensureBibliography('beta')
    await settle()
    expect(citationItemsOf(controller.getSnapshot().bib?.entries ?? []).map(item => item.value))
      .toEqual(['beta2023'])
  })

  it('offers nothing while the bibliography is still loading', () => {
    const controller = new ResearchController(stubRemote({
      getBibliography: () => new Promise(() => {}),
    }))
    controller.ensureBibliography('alpha')
    expect(controller.getSnapshot().bib?.status).toBe('loading')
    // The popover must not fall back to the previous project's keys here.
    expect(citationItemsOf(controller.getSnapshot().bib?.entries ?? [])).toEqual([])
  })
})
