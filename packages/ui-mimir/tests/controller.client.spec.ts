/**
 * Behavior tests for the research panel controller: list loading and retry,
 * per-project outline loads with supersede semantics, the compile state
 * machine (running collapse, business failure, carrier failure), and the
 * source editor's autosave/auto-compile/conflict orchestration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSAVE_DEBOUNCE_MS, COMPILE_DEBOUNCE_MS, ResearchController } from '../src/client/controller.ts'
import type { ResearchRemote } from '../src/client/controller.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ResearchArtifactResult,
  ResearchBibliographyResult,
  ResearchCheckServerResult,
  ResearchCompileResult,
  ResearchCompileStatusResult,
  ResearchConvertFigureResult,
  ResearchDeleteExperimentResult,
  ResearchDeleteFigureResult,
  ResearchDeleteJobResult,
  ResearchDeleteServerResult,
  ResearchExperimentsResult,
  ResearchFetchPaperPdfResult,
  ResearchFiguresResult,
  ResearchGenerateBriefResult,
  ResearchAddJournalEntryResult,
  ResearchCloseIdeaResult,
  ResearchAdoptIdeaResult,
  ResearchGetWorktreeResult,
  ResearchSetIdeaParentResult,
  ResearchSetMainlineResult,
  ResearchWorktreeView,
  ResearchForagingView,
  ResearchGetForagingResult,
  ResearchImportBibResult,
  ResearchImportPaperResult,
  ResearchListEventsResult,
  ResearchListJobsResult,
  ResearchListProjectsResult,
  ResearchListServersResult,
  ResearchOutlineResult,
  ResearchPaperSourceResult,
  ResearchPapersResult,
  ResearchProgressReportResult,
  ResearchRemovePaperResult,
  ResearchSaveBibliographyResult,
  ResearchSaveExperimentResult,
  ResearchSaveFigureResult,
  ResearchSavePaperSourceResult,
  ResearchSaveServerResult,
  ResearchSearchArxivResult,
  ResearchSearchWebResult,
  ResearchSubmitJobResult,
  ResearchUpdateExperimentResult,
  ResearchUpdatePaperResult,
} from 'dsh-mimir/types'

/** Wrap one business result in the carrier's success branch. */
function carried<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

/** One deferred promise for driving in-flight Remote calls. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const PROJECTS: ResearchListProjectsResult = {
  ok: true,
  value: {
    projects: [
      { id: 'p1', title: 'Paper One', stage: 'writing', reviewRounds: 2, updatedAt: '2026-08-01T00:00:00Z', artifacts: [] },
    ],
  },
}

/** Build a remote stub; unspecified calls reject, which no test path reaches. */
function stubRemote(overrides: Partial<ResearchRemote>): ResearchRemote {
  const missing = (name: string) => () => Promise.reject(new Error(`unexpected ${name} call`))
  return {
    listProjects: missing('listProjects'),
    getPaperOutline: missing('getPaperOutline'),
    compile: missing('compile'),
    getCompileStatus: missing('getCompileStatus'),
    getPaperSource: missing('getPaperSource'),
    savePaperSource: missing('savePaperSource'),
    listPapers: missing('listPapers'),
    searchArxiv: missing('searchArxiv'),
    searchWeb: missing('searchWeb'),
    importPaper: missing('importPaper'),
    removePaper: missing('removePaper'),
    updatePaper: missing('updatePaper'),
    fetchPaperPdf: missing('fetchPaperPdf'),
    listExperiments: missing('listExperiments'),
    deleteExperiment: missing('deleteExperiment'),
    readArtifact: missing('readArtifact'),
    listFigures: missing('listFigures'),
    deleteFigure: missing('deleteFigure'),
    convertFigure: missing('convertFigure'),
    saveFigure: missing('saveFigure'),
    listServers: missing('listServers'),
    saveServer: missing('saveServer'),
    deleteServer: missing('deleteServer'),
    checkServer: missing('checkServer'),
    submitJob: missing('submitJob'),
    listJobs: missing('listJobs'),
    deleteJob: missing('deleteJob'),
    getBibliography: missing('getBibliography'),
    saveBibliography: missing('saveBibliography'),
    importPapersToBib: missing('importPapersToBib'),
    reorderPaperSections: missing('reorderPaperSections'),
    reorderPaperSubsections: missing('reorderPaperSubsections'),
    listPaperSnapshots: missing('listPaperSnapshots'),
    getPaperSnapshot: missing('getPaperSnapshot'),
    revertPaperSnapshot: missing('revertPaperSnapshot'),
    updateExperiment: missing('updateExperiment'),
    saveExperiment: missing('saveExperiment'),
    listBackups: missing('listBackups'),
    listEvents: missing('listEvents'),
    generateProgressReport: missing('generateProgressReport'),
    generateBrief: missing('generateBrief'),
    addJournalEntry: missing('addJournalEntry'),
    getWorktree: missing('getWorktree'),
    getForaging: missing('getForaging'),
    getMomentIndex: missing('getMomentIndex'),
    getEurekaView: missing('getEurekaView'),
    setMainline: missing('setMainline'),
    setIdeaParent: missing('setIdeaParent'),
    adoptIdea: missing('adoptIdea'),
    closeIdea: missing('closeIdea'),
    getImageGenConfig: missing('getImageGenConfig'),
    setImageGenConfig: missing('setImageGenConfig'),
    ...overrides,
  }
}

const IDLE: ResearchCompileStatusResult = {
  ok: true,
  value: { state: 'idle', issues: [], engine: null, pdfUpdatedAt: null },
}

/** Two-entry bibliography fixture for the bib panel tests. */
const BIB: ResearchBibliographyResult = {
  ok: true,
  value: {
    entries: [
      { key: 'alpha2024', type: 'misc', fields: { title: 'Alpha' } },
      { key: 'beta2023', type: 'article', fields: { title: 'Beta', author: 'Bob' } },
    ],
    mtimeMs: 1000,
  },
}

describe('ResearchController', () => {
  it('starts cold and loads the project list on ensure', async () => {
    const controller = new ResearchController(stubRemote({
      listProjects: () => Promise.resolve(carried(PROJECTS)),
    }))
    expect(controller.getSnapshot().projectsStatus).toBe('cold')
    controller.ensure()
    expect(controller.getSnapshot().projectsStatus).toBe('loading')
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().projectsStatus).toBe('ready')
    expect(controller.getSnapshot().projects.map(p => p.id)).toEqual(['p1'])
  })

  it('keeps a failed list load retryable', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      listProjects: () => {
        calls += 1
        return calls === 1
          ? Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'host down', details: {} } })
          : Promise.resolve(carried(PROJECTS))
      },
    }))
    controller.ensure()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().projectsStatus).toBe('error')
    expect(controller.getSnapshot().projectsFailure?.code).toBe('unavailable')
    controller.ensure()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().projectsStatus).toBe('ready')
  })

  it('loads the selected project outline and its last compile status', async () => {
    const controller = new ResearchController(stubRemote({
      getPaperOutline: ({ projectId }) => Promise.resolve(carried<ResearchOutlineResult>({
        ok: true,
        value: { projectId, nodes: [{ level: 1, title: 'Intro', line: 3, children: [] }] },
      })),
      getCompileStatus: () => Promise.resolve(carried(IDLE)),
    }))
    controller.select('p1')
    expect(controller.getSnapshot().outline?.status).toBe('loading')
    await Promise.resolve()
    await Promise.resolve()
    const view = controller.getSnapshot()
    expect(view.outline?.status).toBe('ready')
    expect(view.outline?.nodes[0]?.title).toBe('Intro')
    expect(view.compile).toMatchObject({ projectId: 'p1', state: 'idle' })
  })

  it('maps a missing paper to the paper-not-found outline failure', async () => {
    const controller = new ResearchController(stubRemote({
      getPaperOutline: () => Promise.resolve(carried<ResearchOutlineResult>({
        ok: false,
        error: { code: 'paper-not-found' },
      })),
      getCompileStatus: () => Promise.resolve(carried(IDLE)),
    }))
    controller.select('p1')
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().outline).toMatchObject({
      status: 'error',
      failure: { code: 'paper-not-found' },
    })
  })

  it('discards a superseded outline reply', async () => {
    const slow = deferred<RemoteResult<ResearchOutlineResult>>()
    const controller = new ResearchController(stubRemote({
      getPaperOutline: ({ projectId }) => projectId === 'p1'
        ? slow.promise
        : Promise.resolve(carried<ResearchOutlineResult>({ ok: true, value: { projectId, nodes: [] } })),
      getCompileStatus: () => Promise.resolve(carried(IDLE)),
    }))
    controller.select('p1')
    controller.select('p2')
    slow.resolve(carried({ ok: true, value: { projectId: 'p1', nodes: [{ level: 1, title: 'Stale', line: 1, children: [] }] } }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().outline?.projectId).toBe('p2')
  })

  it('runs a compile to its settled ok state with the pdf timestamp', async () => {
    const controller = new ResearchController(stubRemote({
      compile: () => Promise.resolve(carried<ResearchCompileResult>({
        ok: true,
        value: { state: 'ok', issues: [], engine: null, pdfUpdatedAt: 1724000000000 },
      })),
    }))
    const done = controller.compile('p1')
    expect(controller.getSnapshot().compile.state).toBe('running')
    await done
    expect(controller.getSnapshot().compile).toMatchObject({
      projectId: 'p1',
      state: 'ok',
      pdfUpdatedAt: 1724000000000,
    })
  })

  it('queues a second compile while one is running', async () => {
    const run = deferred<RemoteResult<ResearchCompileResult>>()
    let calls = 0
    const controller = new ResearchController(stubRemote({
      compile: () => { calls += 1; return run.promise },
    }))
    const first = controller.compile('p1')
    await controller.compile('p1')
    expect(calls).toBe(1)
    run.resolve(carried({ ok: true, value: { state: 'ok', issues: [], engine: null, pdfUpdatedAt: 1 } }))
    await first
    await Promise.resolve()
    await Promise.resolve()
    // The queued request fires as soon as the in-flight run settles.
    expect(calls).toBe(2)
    expect(controller.getSnapshot().compile.state).toBe('ok')
  })

  it('surfaces a missing engine as an error state with the host message', async () => {
    const controller = new ResearchController(stubRemote({
      compile: () => Promise.resolve(carried<ResearchCompileResult>({
        ok: false,
        error: { code: 'operation-failed', message: "LaTeX engine 'latexmk' was not found on PATH" },
      })),
    }))
    await controller.compile('p1')
    const view = controller.getSnapshot().compile
    expect(view.state).toBe('error')
    expect(view.issues[0]?.message).toContain('latexmk')
  })
})

describe('ResearchController source editing', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** A settled source-read reply. */
  const sourceOk = (content: string, mtimeMs: number): ResearchPaperSourceResult => ({
    ok: true,
    value: { content, mtimeMs },
  })

  /** Stubs for the reads every select() fires, so a test only wires what it asserts. */
  const selectReads = {
    getPaperOutline: ({ projectId }: { projectId: string }) => Promise.resolve(
      carried<ResearchOutlineResult>({ ok: true, value: { projectId, nodes: [] } }),
    ),
    getCompileStatus: () => Promise.resolve(carried(IDLE)),
  }

  it('loads the paper source for the selected project', async () => {
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk('\\documentclass{article}', 1000))),
    }))
    controller.select('p1')
    expect(controller.getSnapshot().source?.status).toBe('loading')
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.getSnapshot().source).toMatchObject({
      projectId: 'p1',
      status: 'ready',
      content: '\\documentclass{article}',
      mtimeMs: 1000,
      saveState: 'clean',
    })
  })

  it('autosaves after the debounce, updates the mtime, and schedules the compile', async () => {
    const saved: Array<{ projectId: string; content: string; baseMtimeMs: number }> = []
    let compiles = 0
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk('v1', 1000))),
      savePaperSource: (request) => {
        saved.push(request)
        return Promise.resolve(carried<ResearchSavePaperSourceResult>({ ok: true, value: { mtimeMs: 2000 } }))
      },
      compile: () => {
        compiles += 1
        return Promise.resolve(carried<ResearchCompileResult>({
          ok: true, value: { state: 'ok', issues: [], engine: null, pdfUpdatedAt: 5 },
        }))
      },
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    controller.edit('v1 edited')
    expect(controller.getSnapshot().source?.saveState).toBe('dirty')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1)
    expect(saved).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(saved).toEqual([{ projectId: 'p1', content: 'v1 edited', baseMtimeMs: 1000 }])
    expect(controller.getSnapshot().source).toMatchObject({ saveState: 'saved', mtimeMs: 2000 })
    expect(compiles).toBe(0)
    await vi.advanceTimersByTimeAsync(COMPILE_DEBOUNCE_MS)
    expect(compiles).toBe(1)
    expect(controller.getSnapshot().compile.state).toBe('ok')
  })

  it('keeps the draft on conflict, ignores edits, and reloads the agent version', async () => {
    let reads = 0
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => {
        reads += 1
        return Promise.resolve(carried(sourceOk(reads === 1 ? 'mine' : 'agent v2', reads * 1000)))
      },
      savePaperSource: () => Promise.resolve(carried<ResearchSavePaperSourceResult>({
        ok: false,
        error: { code: 'conflict', currentMtimeMs: 2000 },
      })),
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    controller.edit('my draft')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS)
    expect(controller.getSnapshot().source).toMatchObject({ saveState: 'conflict', content: 'my draft' })
    // A conflicted draft is frozen until the reload resolves it.
    controller.edit('ignored')
    expect(controller.getSnapshot().source?.content).toBe('my draft')
    controller.reloadSource()
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.getSnapshot().source).toMatchObject({
      status: 'ready', content: 'agent v2', mtimeMs: 2000, saveState: 'clean',
    })
  })

  it('forwards the selected project paperDir to every paper call', async () => {
    const seen: unknown[] = []
    const controller = new ResearchController(stubRemote({
      listProjects: () => Promise.resolve(carried<ResearchListProjectsResult>({
        ok: true,
        value: {
          projects: [{
            id: 'p1', title: 'Paper One', stage: 'writing',
            paperDir: 'ego-wholebody-paper', reviewRounds: 0, updatedAt: '2026-08-01T00:00:00Z', artifacts: [],
          }],
        },
      })),
      getPaperOutline: (request) => {
        seen.push(['outline', request])
        return Promise.resolve(carried<ResearchOutlineResult>({
          ok: true, value: { projectId: request.projectId, nodes: [] },
        }))
      },
      getCompileStatus: () => Promise.resolve(carried(IDLE)),
      getPaperSource: (request) => {
        seen.push(['source', request])
        return Promise.resolve(carried(sourceOk('v1', 1000)))
      },
      savePaperSource: (request) => {
        seen.push(['save', request])
        return Promise.resolve(carried<ResearchSavePaperSourceResult>({ ok: true, value: { mtimeMs: 2000 } }))
      },
      compile: (request) => {
        seen.push(['compile', request])
        return Promise.resolve(carried<ResearchCompileResult>({
          ok: true, value: { state: 'ok', issues: [], engine: null, pdfUpdatedAt: 3 },
        }))
      },
    }))
    controller.ensure()
    await vi.advanceTimersByTimeAsync(0)
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    controller.edit('v2')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + COMPILE_DEBOUNCE_MS)
    expect(seen).toEqual([
      ['outline', { projectId: 'p1', dir: 'ego-wholebody-paper' }],
      ['source', { projectId: 'p1', dir: 'ego-wholebody-paper' }],
      ['save', { projectId: 'p1', content: 'v2', baseMtimeMs: 1000, dir: 'ego-wholebody-paper' }],
      ['compile', { projectId: 'p1', dir: 'ego-wholebody-paper' }],
    ])
  })

  it('queues the autosave compile behind an in-flight compile', async () => {
    const run = deferred<RemoteResult<ResearchCompileResult>>()
    let compiles = 0
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk('v1', 1000))),
      savePaperSource: request => Promise.resolve(carried<ResearchSavePaperSourceResult>({
        ok: true, value: { mtimeMs: request.baseMtimeMs + 1 },
      })),
      compile: () => { compiles += 1; return run.promise },
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    const first = controller.compile('p1')
    controller.edit('v2')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + COMPILE_DEBOUNCE_MS)
    // The save landed but its compile queued behind the in-flight run.
    expect(compiles).toBe(1)
    run.resolve(carried({ ok: true, value: { state: 'ok', issues: [], engine: null, pdfUpdatedAt: 9 } }))
    await first
    await vi.advanceTimersByTimeAsync(0)
    expect(compiles).toBe(2)
    expect(controller.getSnapshot().compile.state).toBe('ok')
  })
})

describe('ResearchController workbench views', () => {
  /** Settle all queued microtasks of the void-fired loads. */
  const settle = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  it('loads the literature list once on ensurePapers', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      listPapers: () => {
        calls += 1
        return Promise.resolve(carried<ResearchPapersResult>({
          ok: true,
          value: {
            papers: [{
              arxivId: '2103.00020v2', title: 'A Paper', authors: ['Ann'],
              summary: 'S', url: 'https://arxiv.org/abs/2103.00020', notes: '',
              addedAt: '2026-08-01T00:00:00Z',
            }],
          },
        }))
      },
    }))
    expect(controller.getSnapshot().papers.status).toBe('cold')
    controller.ensurePapers()
    expect(controller.getSnapshot().papers.status).toBe('loading')
    await settle()
    expect(controller.getSnapshot().papers).toMatchObject({ status: 'ready' })
    expect(controller.getSnapshot().papers.list[0]?.arxivId).toBe('2103.00020v2')
    // A second call is a no-op on the ready view.
    controller.ensurePapers()
    expect(calls).toBe(1)
  })

  it('loads the selected project experiments through select', async () => {
    const controller = new ResearchController(stubRemote({
      getPaperOutline: ({ projectId }) => Promise.resolve(carried<ResearchOutlineResult>({
        ok: true, value: { projectId, nodes: [] },
      })),
      getCompileStatus: () => Promise.resolve(carried(IDLE)),
      getPaperSource: () => Promise.resolve(carried({ ok: true, value: { content: '', mtimeMs: 1 } })),
      listExperiments: () => Promise.resolve(carried<ResearchExperimentsResult>({
        ok: true,
        value: {
          experiments: [{
            id: 'e1', projectId: 'p1', name: 'baseline', status: 'success',
            metrics: { acc: 0.9 }, updatedAt: '2026-08-02T00:00:00Z',
          }],
        },
      })),
    }))
    controller.select('p1')
    await settle()
    expect(controller.getSnapshot().experiments).toMatchObject({
      projectId: 'p1', status: 'ready',
    })
    expect(controller.getSnapshot().experiments?.list[0]?.name).toBe('baseline')
  })

  it('deleteExperiment drops the row locally and surfaces a business failure', async () => {
    const experiments = [
      { id: 'e1', projectId: 'p1', name: 'baseline', status: 'success' as const,
        metrics: { acc: 0.9 }, updatedAt: '2026-08-02T00:00:00Z' },
      { id: 'e2', projectId: 'p1', name: 'full', status: 'running' as const,
        metrics: { acc: 0.93 }, updatedAt: '2026-08-03T00:00:00Z' },
    ]
    const controller = new ResearchController(stubRemote({
      getPaperOutline: ({ projectId }) => Promise.resolve(carried<ResearchOutlineResult>({
        ok: true, value: { projectId, nodes: [] },
      })),
      getCompileStatus: () => Promise.resolve(carried(IDLE)),
      getPaperSource: () => Promise.resolve(carried({ ok: true, value: { content: '', mtimeMs: 1 } })),
      listExperiments: () => Promise.resolve(carried<ResearchExperimentsResult>({
        ok: true, value: { experiments },
      })),
      deleteExperiment: ({ id }) => Promise.resolve(carried<ResearchDeleteExperimentResult>(
        id === 'e1'
          ? { ok: true, value: { id } }
          : { ok: false, error: { code: 'experiment-not-found', id } },
      )),
    }))
    controller.select('p1')
    await settle()
    expect(controller.getSnapshot().experiments?.list).toHaveLength(2)
    const failure = await controller.deleteExperiment('nope')
    expect(failure).toMatchObject({ code: 'experiment-not-found' })
    expect(controller.getSnapshot().experiments?.list).toHaveLength(2)
    const ok = await controller.deleteExperiment('e1')
    expect(ok).toBeNull()
    expect(controller.getSnapshot().experiments?.list.map(record => record.id)).toEqual(['e2'])
  })

  it('updateExperiment patches the linked row locally and surfaces failures', async () => {
    const experiments = [
      { id: 'e1', projectId: 'p1', name: 'baseline', status: 'success' as const,
        metrics: { acc: 0.9 }, updatedAt: '2026-08-02T00:00:00Z' },
      { id: 'e2', projectId: 'p1', name: 'full', status: 'running' as const,
        metrics: { acc: 0.93 }, updatedAt: '2026-08-03T00:00:00Z' },
    ]
    const controller = new ResearchController(stubRemote({
      getPaperOutline: ({ projectId }) => Promise.resolve(carried<ResearchOutlineResult>({
        ok: true, value: { projectId, nodes: [] },
      })),
      getCompileStatus: () => Promise.resolve(carried(IDLE)),
      getPaperSource: () => Promise.resolve(carried({ ok: true, value: { content: '', mtimeMs: 1 } })),
      listExperiments: () => Promise.resolve(carried<ResearchExperimentsResult>({
        ok: true, value: { experiments },
      })),
      updateExperiment: ({ id, serverId }) => Promise.resolve(carried<ResearchUpdateExperimentResult>(
        id === 'e1' && serverId !== 'srv-missing'
          ? {
            ok: true,
            value: {
              experiment: serverId === null
                ? experiments[0]!
                : { ...experiments[0]!, serverId },
            },
          }
          : { ok: false, error: { code: 'invalid-input', message: `unknown server: ${serverId}` } },
      )),
    }))
    controller.select('p1')
    await settle()
    const failure = await controller.updateExperiment('e1', 'srv-missing')
    expect(failure).toMatchObject({ code: 'invalid-input' })
    expect(controller.getSnapshot().experiments?.list[0]?.serverId).toBeUndefined()
    const ok = await controller.updateExperiment('e1', 'srv-1')
    expect(ok).toBeNull()
    expect(controller.getSnapshot().experiments?.list[0]?.serverId).toBe('srv-1')
    expect(controller.getSnapshot().experiments?.list[1]?.serverId).toBeUndefined()
    await controller.updateExperiment('e1', null)
    expect(controller.getSnapshot().experiments?.list[0]?.serverId).toBeUndefined()
  })

  it('saveExperiment appends a created row, patches an edited one, and surfaces failures', async () => {
    const experiments = [
      { id: 'e1', projectId: 'p1', name: 'baseline', status: 'success' as const,
        metrics: { acc: 0.9 }, updatedAt: '2026-08-02T00:00:00Z' },
    ]
    const controller = new ResearchController(stubRemote({
      getPaperOutline: ({ projectId }) => Promise.resolve(carried<ResearchOutlineResult>({
        ok: true, value: { projectId, nodes: [] },
      })),
      getCompileStatus: () => Promise.resolve(carried(IDLE)),
      getPaperSource: () => Promise.resolve(carried({ ok: true, value: { content: '', mtimeMs: 1 } })),
      listExperiments: () => Promise.resolve(carried<ResearchExperimentsResult>({
        ok: true, value: { experiments },
      })),
      saveExperiment: ({ experiment }) => Promise.resolve(carried<ResearchSaveExperimentResult>(
        experiment.name.trim().length === 0
          ? { ok: false, error: { code: 'invalid-input', message: 'name must be non-empty' } }
          : {
            ok: true,
            value: {
              experiment: {
                id: experiment.id ?? 'e2',
                projectId: experiment.projectId,
                name: experiment.name,
                status: experiment.status,
                metrics: experiment.metrics,
                updatedAt: '2026-08-04T00:00:00Z',
              },
            },
          },
      )),
    }))
    controller.select('p1')
    await settle()
    expect(controller.getSnapshot().experiments?.list).toHaveLength(1)
    const failure = await controller.saveExperiment({ projectId: 'p1', name: '  ', status: 'running', metrics: {} })
    expect(failure).toMatchObject({ code: 'invalid-input' })
    expect(controller.getSnapshot().experiments?.list).toHaveLength(1)
    const created = await controller.saveExperiment({ projectId: 'p1', name: 'full', status: 'running', metrics: { acc: 0.93 } })
    expect(created).toBeNull()
    expect(controller.getSnapshot().experiments?.list.map(record => record.id)).toEqual(['e1', 'e2'])
    expect(controller.getSnapshot().toasts.at(-1)).toMatchObject({ kind: 'success', copy: 'toast.experimentSaved' })
    const edited = await controller.saveExperiment({ id: 'e1', projectId: 'p1', name: 'baseline-v2', status: 'failed', metrics: {} })
    expect(edited).toBeNull()
    expect(controller.getSnapshot().experiments?.list).toHaveLength(2)
    expect(controller.getSnapshot().experiments?.list[0]?.name).toBe('baseline-v2')
  })

  it('skips a refetch of a ready artifact and keeps the not-found failure', async () => {
    let calls = 0
    let missing = false
    const controller = new ResearchController(stubRemote({
      readArtifact: () => {
        calls += 1
        return missing
          ? Promise.resolve(carried<ResearchArtifactResult>({
            ok: false, error: { code: 'artifact-not-found', name: 'EXPERIMENT_LOG.md' },
          }))
          : Promise.resolve(carried<ResearchArtifactResult>({
            ok: true, value: { name: 'EXPERIMENT_LOG.md', content: '# Log', mtimeMs: 7 },
          }))
      },
    }))
    controller.loadArtifact('p1', 'EXPERIMENT_LOG.md')
    await settle()
    expect(controller.getSnapshot().artifact).toMatchObject({ status: 'ready', content: '# Log' })
    // Ready same project+name: no new request without force.
    controller.loadArtifact('p1', 'EXPERIMENT_LOG.md')
    expect(calls).toBe(1)
    // A missing artifact surfaces as the dedicated business failure.
    missing = true
    controller.loadArtifact('p1', 'EXPERIMENT_LOG.md', true)
    await settle()
    expect(controller.getSnapshot().artifact).toMatchObject({
      status: 'error', failure: { code: 'artifact-not-found' },
    })
    expect(calls).toBe(2)
  })

  it('skips a fresh figures view and rescans on force', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      listFigures: () => {
        calls += 1
        return Promise.resolve(carried<ResearchFiguresResult>({
          ok: true,
          value: {
            figures: [{ name: 'f1.png', relPath: 'f1.png', sizeBytes: 100, mtimeMs: 1 }],
          },
        }))
      },
    }))
    controller.loadFigures('p1')
    await settle()
    expect(controller.getSnapshot().figures).toMatchObject({ projectId: 'p1', status: 'ready' })
    expect(controller.getSnapshot().figures?.list).toHaveLength(1)
    controller.loadFigures('p1')
    expect(calls).toBe(1)
    controller.loadFigures('p1', true)
    await settle()
    expect(calls).toBe(2)
  })
})

describe('ResearchController servers and figure deletion', () => {
  /** Settle all queued microtasks of the void-fired loads. */
  const settle = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  const SERVER = {
    id: 'srv-1', name: 'gpu01', host: '10.0.0.8', port: 22,
    username: 'ops', note: '', tags: [], createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
  }

  it('loads the server list once on ensureServers', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      listServers: () => {
        calls += 1
        return Promise.resolve(carried<ResearchListServersResult>({ ok: true, value: { servers: [SERVER] } }))
      },
    }))
    expect(controller.getSnapshot().servers.status).toBe('cold')
    controller.ensureServers()
    expect(controller.getSnapshot().servers.status).toBe('loading')
    await settle()
    expect(controller.getSnapshot().servers).toMatchObject({ status: 'ready' })
    expect(controller.getSnapshot().servers.list[0]?.name).toBe('gpu01')
    controller.ensureServers()
    expect(calls).toBe(1)
  })

  it('refreshes the list after a save and returns the business failure on invalid input', async () => {
    let lists = 0
    const controller = new ResearchController(stubRemote({
      saveServer: ({ server }) => Promise.resolve(carried<ResearchSaveServerResult>(
        server.name === ''
          ? { ok: false, error: { code: 'invalid-input', message: 'name must be non-empty' } }
          : { ok: true, value: { server: { ...SERVER, name: server.name } } },
      )),
      listServers: () => {
        lists += 1
        return Promise.resolve(carried<ResearchListServersResult>({ ok: true, value: { servers: [SERVER] } }))
      },
    }))
    const failure = await controller.saveServer({ ...SERVER, id: undefined, name: '' })
    expect(failure).toMatchObject({ code: 'invalid-input' })
    expect(lists).toBe(0)
    const ok = await controller.saveServer({ ...SERVER, id: undefined })
    expect(ok).toBeNull()
    expect(lists).toBe(1)
    expect(controller.getSnapshot().servers.status).toBe('ready')
  })

  it('publishes checking then the settled probe view, and deleteServer drops the slot', async () => {
    const probe = deferred<RemoteResult<ResearchCheckServerResult>>()
    const controller = new ResearchController(stubRemote({
      listServers: () => Promise.resolve(carried<ResearchListServersResult>({ ok: true, value: { servers: [SERVER] } })),
      checkServer: () => probe.promise,
      deleteServer: () => Promise.resolve(carried<ResearchDeleteServerResult>({ ok: true, value: { id: SERVER.id } })),
    }))
    const checking = controller.checkServer(SERVER.id)
    expect(controller.getSnapshot().serverChecks[SERVER.id]).toBe('checking')
    probe.resolve(carried<ResearchCheckServerResult>({
      ok: true,
      value: {
        state: 'offline', latencyMs: null, gpus: [],
        checkedAt: '2026-08-02T00:00:00Z', message: 'connect ECONNREFUSED',
      },
    }))
    await checking
    expect(controller.getSnapshot().serverChecks[SERVER.id]).toMatchObject({ state: 'offline' })
    const failure = await controller.deleteServer(SERVER.id)
    expect(failure).toBeNull()
    expect(controller.getSnapshot().serverChecks[SERVER.id]).toBeUndefined()
  })

  it('resiliently folds a carrier failure into an offline probe view', async () => {
    const controller = new ResearchController(stubRemote({
      checkServer: () => Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'host down', details: {} } }),
    }))
    await controller.checkServer(SERVER.id)
    expect(controller.getSnapshot().serverChecks[SERVER.id]).toMatchObject({
      state: 'offline', message: 'host down',
    })
  })

  it('deleteFigure forwards the paperDir and forces a rescan', async () => {
    const seen: unknown[] = []
    const controller = new ResearchController(stubRemote({
      listProjects: () => Promise.resolve(carried(PROJECTS)),
      deleteFigure: (request) => {
        seen.push(request)
        return Promise.resolve(carried<ResearchDeleteFigureResult>({ ok: true, value: { relPath: request.relPath } }))
      },
      listFigures: () => Promise.resolve(carried<ResearchFiguresResult>({ ok: true, value: { figures: [] } })),
    }))
    controller.ensure()
    await settle()
    const failure = await controller.deleteFigure('p1', 'figures/f1.png')
    expect(failure).toBeNull()
    expect(seen).toEqual([{ projectId: 'p1', relPath: 'figures/f1.png', dir: undefined }])
    await settle()
    expect(controller.getSnapshot().figures).toMatchObject({ projectId: 'p1', status: 'ready' })
  })
})

describe('ResearchController remote jobs', () => {
  /** Settle all queued microtasks of the void-fired loads. */
  const settle = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  const JOB_RUNNING = {
    id: 'job-1', serverId: 'srv-1', command: 'python train.py', status: 'running' as const,
    experimentId: 'exp-1', exitCode: null, stdoutTail: '', stderrTail: '',
    createdAt: '2026-08-02T00:00:00Z', startedAt: '2026-08-02T00:00:01.000Z',
  }

  it('loads the job list once on ensureJobs, and submitJob refreshes it with a toast', async () => {
    let lists = 0
    const controller = new ResearchController(stubRemote({
      listJobs: () => {
        lists += 1
        return Promise.resolve(carried<ResearchListJobsResult>({ ok: true, value: { jobs: [JOB_RUNNING] } }))
      },
      submitJob: () => Promise.resolve(carried<ResearchSubmitJobResult>({
        ok: true, value: { job: { ...JOB_RUNNING, status: 'queued' } },
      })),
    }))
    expect(controller.getSnapshot().jobs.status).toBe('cold')
    controller.ensureJobs()
    expect(controller.getSnapshot().jobs.status).toBe('loading')
    await settle()
    expect(controller.getSnapshot().jobs).toMatchObject({ status: 'ready' })
    expect(controller.getSnapshot().jobs.list[0]?.id).toBe('job-1')
    controller.ensureJobs()
    expect(lists).toBe(1)
    const failure = await controller.submitJob('srv-1', 'python train.py', 'exp-1')
    expect(failure).toBeNull()
    await settle()
    expect(lists).toBe(2)
    expect(controller.getSnapshot().toasts.at(-1)).toMatchObject({ kind: 'success', copy: 'toast.jobSubmitted' })
  })

  it('submitJob surfaces the business failure without refreshing the list', async () => {
    let lists = 0
    const controller = new ResearchController(stubRemote({
      listJobs: () => {
        lists += 1
        return Promise.resolve(carried<ResearchListJobsResult>({ ok: true, value: { jobs: [] } }))
      },
      submitJob: () => Promise.resolve(carried<ResearchSubmitJobResult>({
        ok: false, error: { code: 'invalid-input', message: 'command must be non-empty' },
      })),
    }))
    const failure = await controller.submitJob('srv-1', '   ')
    expect(failure).toMatchObject({ code: 'invalid-input' })
    expect(lists).toBe(0)
  })

  it('toasts the terminal flips observed between two polls', async () => {
    let round = 0
    const controller = new ResearchController(stubRemote({
      listJobs: () => {
        round += 1
        const jobs = round === 1
          ? [JOB_RUNNING]
          : [{ ...JOB_RUNNING, status: 'failed' as const, exitCode: 3, finishedAt: '2026-08-02T00:01:00.000Z' }]
        return Promise.resolve(carried<ResearchListJobsResult>({ ok: true, value: { jobs } }))
      },
    }))
    controller.ensureJobs()
    await settle()
    expect(controller.getSnapshot().toasts).toHaveLength(0)
    controller.refreshJobs()
    await settle()
    expect(controller.getSnapshot().jobs.list[0]?.status).toBe('failed')
    expect(controller.getSnapshot().toasts.at(-1)).toMatchObject({
      kind: 'error', copy: 'toast.jobFailed', detail: 'python train.py',
    })
  })

  it('refreshes the loaded experiments slice when a linked job settles', async () => {
    let round = 0
    let experimentLoads = 0
    const controller = new ResearchController(stubRemote({
      getPaperOutline: ({ projectId }) => Promise.resolve(carried<ResearchOutlineResult>({
        ok: true, value: { projectId, nodes: [] },
      })),
      getCompileStatus: () => Promise.resolve(carried(IDLE)),
      getPaperSource: () => Promise.resolve(carried({ ok: true, value: { content: '', mtimeMs: 1 } })),
      listExperiments: () => {
        experimentLoads += 1
        return Promise.resolve(carried<ResearchExperimentsResult>({ ok: true, value: { experiments: [] } }))
      },
      listJobs: () => {
        round += 1
        const jobs = round === 1
          ? [JOB_RUNNING]
          : [{ ...JOB_RUNNING, status: 'succeeded' as const, exitCode: 0, finishedAt: '2026-08-02T00:01:00.000Z' }]
        return Promise.resolve(carried<ResearchListJobsResult>({ ok: true, value: { jobs } }))
      },
    }))
    controller.select('p1')
    controller.ensureJobs()
    await settle()
    expect(experimentLoads).toBe(1)
    controller.refreshJobs()
    await settle()
    expect(controller.getSnapshot().jobs.list[0]?.status).toBe('succeeded')
    // The settle wrote back to the linked experiment: the slice reloads once.
    expect(experimentLoads).toBe(2)
  })

  it('leaves the experiments slice alone when an UNLINKED job settles', async () => {
    let round = 0
    let experimentLoads = 0
    const controller = new ResearchController(stubRemote({
      getPaperOutline: ({ projectId }) => Promise.resolve(carried<ResearchOutlineResult>({
        ok: true, value: { projectId, nodes: [] },
      })),
      getCompileStatus: () => Promise.resolve(carried(IDLE)),
      getPaperSource: () => Promise.resolve(carried({ ok: true, value: { content: '', mtimeMs: 1 } })),
      listExperiments: () => {
        experimentLoads += 1
        return Promise.resolve(carried<ResearchExperimentsResult>({ ok: true, value: { experiments: [] } }))
      },
      listJobs: () => {
        round += 1
        const unlinked = { ...JOB_RUNNING, experimentId: undefined }
        const jobs = round === 1
          ? [unlinked]
          : [{ ...unlinked, status: 'succeeded' as const, exitCode: 0, finishedAt: '2026-08-02T00:01:00.000Z' }]
        return Promise.resolve(carried<ResearchListJobsResult>({ ok: true, value: { jobs } }))
      },
    }))
    controller.select('p1')
    controller.ensureJobs()
    await settle()
    controller.refreshJobs()
    await settle()
    expect(controller.getSnapshot().jobs.list[0]?.status).toBe('succeeded')
    expect(experimentLoads).toBe(1)
  })

  it('deleteJob drops the row and reports the business failure on an unknown id', async () => {
    const controller = new ResearchController(stubRemote({
      listJobs: () => Promise.resolve(carried<ResearchListJobsResult>({ ok: true, value: { jobs: [JOB_RUNNING] } })),
      deleteJob: ({ id }) => Promise.resolve(carried<ResearchDeleteJobResult>(
        id === 'job-1'
          ? { ok: true, value: { id } }
          : { ok: false, error: { code: 'job-not-found', id } },
      )),
    }))
    controller.ensureJobs()
    await settle()
    expect(controller.getSnapshot().jobs.list).toHaveLength(1)
    const missing = await controller.deleteJob('job-missing')
    expect(missing).toMatchObject({ code: 'job-not-found' })
    expect(controller.getSnapshot().jobs.list).toHaveLength(1)
    const failure = await controller.deleteJob('job-1')
    expect(failure).toBeNull()
    expect(controller.getSnapshot().jobs.list).toHaveLength(0)
  })
})

describe('ResearchController arXiv search and paper import', () => {
  /** Settle all queued microtasks of the void-fired loads. */
  const settle = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  const ENTRY = {
    id: '2103.00020v2',
    title: 'EgoSync & Friends: A Study',
    authors: ['Doe, Jane'],
    summary: 'body',
    published: '2021-03-01T00:00:00Z',
    url: 'https://arxiv.org/abs/2103.00020v2',
  }
  const PAPER = {
    arxivId: ENTRY.id, title: ENTRY.title, authors: ENTRY.authors,
    summary: ENTRY.summary, url: ENTRY.url, notes: '', tags: [] as string[], projectIds: [] as string[],
    addedAt: '2026-08-01T00:00:00Z',
  }

  it('publishes loading then the ready search outcome; an empty query never leaves the client', async () => {
    const seen: string[] = []
    const controller = new ResearchController(stubRemote({
      searchArxiv: ({ query }) => {
        seen.push(query)
        return Promise.resolve(carried<ResearchSearchArxivResult>({ ok: true, value: { results: [ENTRY] } }))
      },
    }))
    expect(controller.getSnapshot().arxivSearch).toBeNull()
    controller.searchArxiv('   ')
    expect(seen).toEqual([])
    controller.searchArxiv(' egocentric ')
    expect(controller.getSnapshot().arxivSearch).toMatchObject({ query: 'egocentric', status: 'loading' })
    await settle()
    expect(controller.getSnapshot().arxivSearch).toMatchObject({ query: 'egocentric', status: 'ready' })
    expect(controller.getSnapshot().arxivSearch?.list[0]?.id).toBe(ENTRY.id)
    expect(seen).toEqual(['egocentric'])
  })

  it('discards a superseded search and folds failures into the error slice', async () => {
    const slow = deferred<RemoteResult<ResearchSearchArxivResult>>()
    const controller = new ResearchController(stubRemote({
      searchArxiv: ({ query }) => query === 'slow'
        ? slow.promise
        : Promise.resolve(carried<ResearchSearchArxivResult>({
            ok: false, error: { code: 'operation-failed', message: 'HTTP 500' },
          })),
    }))
    controller.searchArxiv('slow')
    controller.searchArxiv('fast')
    await settle()
    expect(controller.getSnapshot().arxivSearch).toMatchObject({ query: 'fast', status: 'error' })
    expect(controller.getSnapshot().arxivSearch?.failure).toMatchObject({ code: 'operation-failed', message: 'HTTP 500' })
    // The superseded slow reply never overwrites the newer outcome.
    slow.resolve(carried<ResearchSearchArxivResult>({ ok: true, value: { results: [ENTRY] } }))
    await settle()
    expect(controller.getSnapshot().arxivSearch).toMatchObject({ query: 'fast', status: 'error' })
  })

  it('publishes the web search outcome; an empty query never leaves the client', async () => {
    const seen: string[] = []
    const controller = new ResearchController(stubRemote({
      searchWeb: ({ query }) => {
        seen.push(query)
        return Promise.resolve(carried<ResearchSearchWebResult>({
          ok: true,
          value: { results: [{ title: 'A page', url: 'https://example.com/', content: 'Snippet.', engine: 'brave', category: 'general', publishedDate: '' }] },
        }))
      },
    }))
    expect(controller.getSnapshot().webSearch).toBeNull()
    controller.searchWeb('  ')
    expect(seen).toEqual([])
    controller.searchWeb(' mesh ')
    expect(controller.getSnapshot().webSearch).toMatchObject({ query: 'mesh', status: 'loading' })
    await settle()
    expect(controller.getSnapshot().webSearch).toMatchObject({ query: 'mesh', status: 'ready' })
    expect(controller.getSnapshot().webSearch?.list[0]?.engine).toBe('brave')
  })

  it('folds web search business failures into the error slice and supersedes in-flight ones', async () => {
    const slow = deferred<RemoteResult<ResearchSearchWebResult>>()
    const controller = new ResearchController(stubRemote({
      searchWeb: ({ query }) => query === 'slow'
        ? slow.promise
        : Promise.resolve(carried<ResearchSearchWebResult>({
            ok: false, error: { code: 'operation-failed', message: 'not configured' },
          })),
    }))
    controller.searchWeb('slow')
    controller.searchWeb('fast')
    await settle()
    expect(controller.getSnapshot().webSearch).toMatchObject({ query: 'fast', status: 'error' })
    slow.resolve(carried<ResearchSearchWebResult>({ ok: true, value: { results: [] } }))
    await settle()
    expect(controller.getSnapshot().webSearch).toMatchObject({ query: 'fast', status: 'error' })
  })

  it('refreshes the literature list after a successful import and returns failures otherwise', async () => {
    let lists = 0
    const controller = new ResearchController(stubRemote({
      importPaper: ({ entry }) => Promise.resolve(carried<ResearchImportPaperResult>(
        entry.id === 'bad'
          ? { ok: false, error: { code: 'invalid-input', message: 'entry id and title must be non-empty' } }
          : { ok: true, value: { imported: true } },
      )),
      listPapers: () => {
        lists += 1
        return Promise.resolve(carried<ResearchPapersResult>({ ok: true, value: { papers: [PAPER] } }))
      },
    }))
    const failure = await controller.importPaper({ ...ENTRY, id: 'bad' })
    expect(failure).toMatchObject({ code: 'invalid-input' })
    expect(lists).toBe(0)
    const ok = await controller.importPaper(ENTRY)
    expect(ok).toBeNull()
    expect(lists).toBe(1)
    expect(controller.getSnapshot().papers).toMatchObject({ status: 'ready' })
    expect(controller.getSnapshot().papers.list[0]?.arxivId).toBe(ENTRY.id)
  })

  it('removePaper returns the business failure and refreshes the list on success', async () => {
    let lists = 0
    const controller = new ResearchController(stubRemote({
      removePaper: ({ arxivId }) => Promise.resolve(carried<ResearchRemovePaperResult>(
        arxivId === ENTRY.id
          ? { ok: true, value: { arxivId } }
          : { ok: false, error: { code: 'paper-not-found' } },
      )),
      listPapers: () => {
        lists += 1
        return Promise.resolve(carried<ResearchPapersResult>({ ok: true, value: { papers: [] } }))
      },
    }))
    const missing = await controller.removePaper('nope')
    expect(missing).toMatchObject({ code: 'paper-not-found' })
    expect(lists).toBe(0)
    const ok = await controller.removePaper(ENTRY.id)
    expect(ok).toBeNull()
    expect(lists).toBe(1)
  })

  it('updatePaper forwards the patch and refreshes the list only on success', async () => {
    let lists = 0
    let seen: { arxivId: string; tags?: string[]; projectIds?: string[]; notes?: string } | null = null
    const controller = new ResearchController(stubRemote({
      updatePaper: (request) => {
        seen = request
        return Promise.resolve(carried<ResearchUpdatePaperResult>(
          request.arxivId === ENTRY.id
            ? { ok: true, value: { paper: { ...PAPER, tags: request.tags ?? [] } } }
            : { ok: false, error: { code: 'paper-not-found' } },
        ))
      },
      listPapers: () => {
        lists += 1
        return Promise.resolve(carried<ResearchPapersResult>({ ok: true, value: { papers: [PAPER] } }))
      },
    }))
    const missing = await controller.updatePaper('nope', { tags: ['x'] })
    expect(missing).toMatchObject({ code: 'paper-not-found' })
    expect(lists).toBe(0)
    const ok = await controller.updatePaper(ENTRY.id, { tags: ['baseline'], projectIds: ['p1'] })
    expect(ok).toBeNull()
    expect(seen).toMatchObject({ arxivId: ENTRY.id, tags: ['baseline'], projectIds: ['p1'] })
    expect(lists).toBe(1)
    expect(controller.getSnapshot().papers).toMatchObject({ status: 'ready' })
  })

  it('fetchPaperPdf refreshes the list and toasts on success, surfaces failures', async () => {
    let lists = 0
    let seen: string | null = null
    const controller = new ResearchController(stubRemote({
      fetchPaperPdf: (request) => {
        seen = request.arxivId
        return Promise.resolve(carried<ResearchFetchPaperPdfResult>(
          request.arxivId === PAPER.arxivId
            ? { ok: true, value: { paper: { ...PAPER, pdfPath: 'papers/2103.00020v2.pdf' } } }
            : { ok: false, error: { code: 'paper-not-found' } },
        ))
      },
      listPapers: () => {
        lists += 1
        return Promise.resolve(carried<ResearchPapersResult>({ ok: true, value: { papers: [PAPER] } }))
      },
    }))
    const missing = await controller.fetchPaperPdf('nope')
    expect(missing).toMatchObject({ code: 'paper-not-found' })
    expect(lists).toBe(0)
    const ok = await controller.fetchPaperPdf(PAPER.arxivId)
    expect(ok).toBeNull()
    expect(seen).toBe(PAPER.arxivId)
    expect(lists).toBe(1)
    expect(controller.getSnapshot().toasts.at(-1)?.copy).toBe('toast.pdfFetched')
  })

  it('ensureBibliography loads the entries once and keeps a ready view', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      getBibliography: () => {
        calls += 1
        return Promise.resolve(carried(BIB))
      },
    }))
    expect(controller.getSnapshot().bib).toBeNull()
    controller.ensureBibliography('p1')
    expect(controller.getSnapshot().bib?.status).toBe('loading')
    await Promise.resolve()
    await Promise.resolve()
    const bib = controller.getSnapshot().bib
    expect(bib?.status).toBe('ready')
    expect(bib?.entries.map(entry => entry.key)).toEqual(['alpha2024', 'beta2023'])
    expect(bib?.mtimeMs).toBe(1000)
    controller.ensureBibliography('p1')
    expect(calls).toBe(1)
    controller.ensureBibliography('p2')
    expect(calls).toBe(2)
    expect(controller.getSnapshot().bib?.projectId).toBe('p2')
  })

  it('deleteBibEntry commits the entries minus the key under the current mtime', async () => {
    const saves: Array<{ entries: Array<{ key: string }>; baseMtimeMs: number | null }> = []
    const controller = new ResearchController(stubRemote({
      getBibliography: () => Promise.resolve(carried(BIB)),
      saveBibliography: (request) => {
        saves.push(request)
        return Promise.resolve(carried<ResearchSaveBibliographyResult>({ ok: true, value: { mtimeMs: 2000 } }))
      },
    }))
    controller.ensureBibliography('p1')
    await Promise.resolve()
    await Promise.resolve()
    const failure = await controller.deleteBibEntry('alpha2024')
    expect(failure).toBeNull()
    expect(saves[0]?.baseMtimeMs).toBe(1000)
    expect(saves[0]?.entries.map(entry => entry.key)).toEqual(['beta2023'])
    const bib = controller.getSnapshot().bib
    expect(bib?.entries.map(entry => entry.key)).toEqual(['beta2023'])
    expect(bib?.mtimeMs).toBe(2000)
    expect(bib?.saveState).toBe('saved')
  })

  it('deleteBibEntry freezes the panel on a conflict until reloaded', async () => {
    let reads = 0
    const controller = new ResearchController(stubRemote({
      getBibliography: () => {
        reads += 1
        return Promise.resolve(carried(BIB))
      },
      saveBibliography: () => Promise.resolve(carried<ResearchSaveBibliographyResult>({
        ok: false,
        error: { code: 'conflict', currentMtimeMs: 3000 },
      })),
    }))
    controller.ensureBibliography('p1')
    await Promise.resolve()
    await Promise.resolve()
    const failure = await controller.deleteBibEntry('alpha2024')
    expect(failure?.code).toBe('conflict')
    expect(controller.getSnapshot().bib?.saveState).toBe('conflict')
    controller.reloadBibliography()
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toBe(2)
    expect(controller.getSnapshot().bib?.saveState).toBe('clean')
  })

  it('updateBibEntry commits the edited entry in place under the current mtime', async () => {
    const saves: Array<{ entries: Array<{ key: string }>; baseMtimeMs: number | null }> = []
    const controller = new ResearchController(stubRemote({
      getBibliography: () => Promise.resolve(carried(BIB)),
      saveBibliography: (request) => {
        saves.push(request)
        return Promise.resolve(carried<ResearchSaveBibliographyResult>({ ok: true, value: { mtimeMs: 2000 } }))
      },
    }))
    controller.ensureBibliography('p1')
    await Promise.resolve()
    await Promise.resolve()
    const edited = { key: 'alpha2025', type: 'article', fields: { title: 'Alpha 2', year: '2025' } }
    const failure = await controller.updateBibEntry('alpha2024', edited)
    expect(failure).toBeNull()
    expect(saves[0]?.baseMtimeMs).toBe(1000)
    expect(saves[0]?.entries.map(entry => entry.key)).toEqual(['alpha2025', 'beta2023'])
    const bib = controller.getSnapshot().bib
    expect(bib?.entries[0]).toEqual(edited)
    expect(bib?.mtimeMs).toBe(2000)
    expect(bib?.saveState).toBe('saved')
  })

  it('updateBibEntry rejects a rename colliding with another entry without saving', async () => {
    let saves = 0
    const controller = new ResearchController(stubRemote({
      getBibliography: () => Promise.resolve(carried(BIB)),
      saveBibliography: () => {
        saves += 1
        return Promise.resolve(carried<ResearchSaveBibliographyResult>({ ok: true, value: { mtimeMs: 2000 } }))
      },
    }))
    controller.ensureBibliography('p1')
    await Promise.resolve()
    await Promise.resolve()
    const failure = await controller.updateBibEntry('alpha2024', { key: 'beta2023', type: 'misc', fields: {} })
    expect(failure?.code).toBe('invalid-input')
    expect(saves).toBe(0)
    expect(controller.getSnapshot().bib?.entries.map(entry => entry.key)).toEqual(['alpha2024', 'beta2023'])
  })

  it('updateBibEntry rejects an empty key or an unknown original key without saving', async () => {
    let saves = 0
    const controller = new ResearchController(stubRemote({
      getBibliography: () => Promise.resolve(carried(BIB)),
      saveBibliography: () => {
        saves += 1
        return Promise.resolve(carried<ResearchSaveBibliographyResult>({ ok: true, value: { mtimeMs: 2000 } }))
      },
    }))
    controller.ensureBibliography('p1')
    await Promise.resolve()
    await Promise.resolve()
    const emptyKey = await controller.updateBibEntry('alpha2024', { key: '', type: 'misc', fields: {} })
    expect(emptyKey?.code).toBe('invalid-input')
    const unknown = await controller.updateBibEntry('gamma2019', { key: 'gamma2019', type: 'misc', fields: {} })
    expect(unknown?.code).toBe('invalid-input')
    expect(saves).toBe(0)
  })

  it('updateBibEntry refuses while no bibliography is loaded', async () => {
    const controller = new ResearchController(stubRemote({}))
    const failure = await controller.updateBibEntry('alpha2024', { key: 'alpha2024', type: 'misc', fields: {} })
    expect(failure?.code).toBe('bib-not-ready')
  })

  it('importPapersToBib returns the counts and repaints the open panel', async () => {
    let reads = 0
    const seen: string[][] = []
    const controller = new ResearchController(stubRemote({
      getBibliography: () => {
        reads += 1
        return Promise.resolve(carried(BIB))
      },
      importPapersToBib: (request) => {
        seen.push(request.arxivIds)
        return Promise.resolve(carried<ResearchImportBibResult>({
          ok: true,
          value: { added: ['gamma2025'], skipped: ['alpha2024'] },
        }))
      },
    }))
    controller.ensureBibliography('p1')
    await Promise.resolve()
    await Promise.resolve()
    const outcome = await controller.importPapersToBib('p1', ['2103.00020v2', '2103.00021v1'])
    expect(seen).toEqual([['2103.00020v2', '2103.00021v1']])
    expect('added' in outcome && outcome.added).toEqual(['gamma2025'])
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toBe(2)
    const bib = controller.getSnapshot().bib
    expect(bib?.status).toBe('ready')
    expect(bib?.lastImport).toEqual({ added: ['gamma2025'], skipped: ['alpha2024'] })
  })

  it('importPapersToBib surfaces a business failure without touching the bib view', async () => {
    const controller = new ResearchController(stubRemote({
      getBibliography: () => Promise.resolve(carried(BIB)),
      importPapersToBib: () => Promise.resolve(carried<ResearchImportBibResult>({
        ok: false,
        error: { code: 'paper-not-found' },
      })),
    }))
    controller.ensureBibliography('p1')
    await Promise.resolve()
    await Promise.resolve()
    const outcome = await controller.importPapersToBib('p1', ['nope'])
    expect('code' in outcome && outcome.code).toBe('paper-not-found')
    expect(controller.getSnapshot().bib?.lastImport).toBeNull()
  })

  it('reorderPaperSections re-reads the outline and the source on success', async () => {
    let outlineReads = 0
    let sourceReads = 0
    const seen: { moves: unknown; baseOutline: unknown }[] = []
    const controller = new ResearchController(stubRemote({
      getPaperOutline: () => {
        outlineReads += 1
        return Promise.resolve(carried<ResearchOutlineResult>({
          ok: true,
          value: { nodes: [{ title: 'Intro', line: 5, level: 1, children: [] }] },
        }))
      },
      getPaperSource: () => {
        sourceReads += 1
        return Promise.resolve(carried<ResearchPaperSourceResult>({ ok: true, value: { content: 'v1', mtimeMs: 1000 } }))
      },
      reorderPaperSections: (request) => {
        seen.push({ moves: request.moves, baseOutline: request.baseOutline })
        return Promise.resolve(carried<ResearchSavePaperSourceResult>({ ok: true, value: { mtimeMs: 2000 } }))
      },
    }))
    controller.select('p1')
    await Promise.resolve()
    await Promise.resolve()
    expect(outlineReads).toBe(1)
    expect(sourceReads).toBe(1)
    const failure = await controller.reorderPaperSections(
      'p1', [{ title: 'Intro', targetIndex: 1 }], ['Intro', 'Method'],
    )
    expect(failure).toBeNull()
    expect(seen).toEqual([{ moves: [{ title: 'Intro', targetIndex: 1 }], baseOutline: ['Intro', 'Method'] }])
    await Promise.resolve()
    await Promise.resolve()
    expect(outlineReads).toBe(2)
    expect(sourceReads).toBe(2)
  })

  it('reorderPaperSections surfaces a conflict and still refreshes both views', async () => {
    let outlineReads = 0
    let sourceReads = 0
    const controller = new ResearchController(stubRemote({
      getPaperOutline: () => {
        outlineReads += 1
        return Promise.resolve(carried<ResearchOutlineResult>({ ok: true, value: { nodes: [] } }))
      },
      getPaperSource: () => {
        sourceReads += 1
        return Promise.resolve(carried<ResearchPaperSourceResult>({ ok: true, value: { content: 'v1', mtimeMs: 1000 } }))
      },
      reorderPaperSections: () => Promise.resolve(carried<ResearchSavePaperSourceResult>({
        ok: false,
        error: { code: 'conflict', currentMtimeMs: 3000 },
      })),
    }))
    controller.select('p1')
    await Promise.resolve()
    await Promise.resolve()
    const failure = await controller.reorderPaperSections('p1', [{ title: 'Intro', targetIndex: 1 }], ['Intro'])
    expect(failure?.code).toBe('conflict')
    await Promise.resolve()
    await Promise.resolve()
    expect(outlineReads).toBe(2)
    expect(sourceReads).toBe(2)
  })

  it('reorderPaperSubsections forwards the nested baseOutline and refreshes on success', async () => {
    let outlineReads = 0
    let sourceReads = 0
    const seen: { moves: unknown; baseOutline: unknown }[] = []
    const controller = new ResearchController(stubRemote({
      getPaperOutline: () => {
        outlineReads += 1
        return Promise.resolve(carried<ResearchOutlineResult>({ ok: true, value: { nodes: [] } }))
      },
      getPaperSource: () => {
        sourceReads += 1
        return Promise.resolve(carried<ResearchPaperSourceResult>({ ok: true, value: { content: 'v1', mtimeMs: 1000 } }))
      },
      reorderPaperSubsections: (request) => {
        seen.push({ moves: request.moves, baseOutline: request.baseOutline })
        return Promise.resolve(carried<ResearchSavePaperSourceResult>({ ok: true, value: { mtimeMs: 2000 } }))
      },
    }))
    controller.select('p1')
    await Promise.resolve()
    await Promise.resolve()
    const move = { sectionTitle: 'Method', title: 'Arch', targetSectionTitle: 'Intro', targetIndex: 0 }
    const base = [
      { title: 'Intro', subsections: ['Setup'] },
      { title: 'Method', subsections: ['Arch', 'Training'] },
    ]
    const failure = await controller.reorderPaperSubsections('p1', [move], base)
    expect(failure).toBeNull()
    expect(seen).toEqual([{ moves: [move], baseOutline: base }])
    await Promise.resolve()
    await Promise.resolve()
    expect(outlineReads).toBe(2)
    expect(sourceReads).toBe(2)
  })
})

describe('ResearchController figure insert', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** A settled source-read reply. */
  const sourceOk = (content: string, mtimeMs: number): ResearchPaperSourceResult => ({
    ok: true,
    value: { content, mtimeMs },
  })

  /** Stubs for the reads every select() fires, so a test only wires what it asserts. */
  const selectReads = {
    getPaperOutline: ({ projectId }: { projectId: string }) => Promise.resolve(
      carried<ResearchOutlineResult>({ ok: true, value: { projectId, nodes: [] } }),
    ),
    getCompileStatus: () => Promise.resolve(carried(IDLE)),
  }

  const TEX = '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\ntext\n\\end{document}\n'
  const FIGURE = {
    name: 'accuracy.png', relPath: 'figures/accuracy.png',
    sizeBytes: 100, mtimeMs: 1, caption: 'Accuracy over epochs',
  }

  it('inserts the block before \\end{document}, toasts, and publishes the jump ticket', async () => {
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk(TEX, 1000))),
      savePaperSource: () => Promise.resolve(carried<ResearchSavePaperSourceResult>({ ok: true, value: { mtimeMs: 2000 } })),
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    const line = await controller.insertFigureIntoPaper('p1', FIGURE)
    expect(line).toBe(6)
    const view = controller.getSnapshot()
    expect(view.source?.saveState).toBe('dirty')
    expect(view.source?.content).toContain('\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{figures/accuracy.png}\n  \\caption{Accuracy over epochs}\n  \\label{fig:accuracy}\n\\end{figure}\n\n\\end{document}')
    expect(view.paperJump).toMatchObject({ projectId: 'p1', line: 6 })
    expect(view.toasts.at(-1)).toMatchObject({ kind: 'success', copy: 'toast.figureInserted', detail: 'accuracy.png' })
    // The jump ticket is consumed by the paper view, not stacked.
    controller.consumePaperJump()
    expect(controller.getSnapshot().paperJump).toBeNull()
    // The inserted draft autosaves through the normal debounce path.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS)
    expect(controller.getSnapshot().source?.saveState).toBe('saved')
  })

  it('loads the source on demand when no draft is ready yet', async () => {
    let reads = 0
    const controller = new ResearchController(stubRemote({
      getPaperSource: () => {
        reads += 1
        return Promise.resolve(carried(sourceOk(TEX, 1000)))
      },
      savePaperSource: () => Promise.resolve(carried<ResearchSavePaperSourceResult>({ ok: true, value: { mtimeMs: 2000 } })),
    }))
    expect(controller.getSnapshot().source).toBeNull()
    const line = await controller.insertFigureIntoPaper('p1', FIGURE)
    expect(reads).toBe(1)
    expect(line).toBe(6)
    expect(controller.getSnapshot().source).toMatchObject({ projectId: 'p1', status: 'ready', saveState: 'dirty' })
  })

  it('never inserts twice: an existing reference becomes the jump target with an info toast', async () => {
    const withFigure = TEX.replace('text', '\\begin{figure}[t]\n  \\includegraphics{figures/accuracy.png}\n\\end{figure}')
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk(withFigure, 1000))),
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    const line = await controller.insertFigureIntoPaper('p1', FIGURE)
    expect(line).toBe(5)
    const view = controller.getSnapshot()
    expect(view.source?.content).toBe(withFigure)
    expect(view.source?.saveState).toBe('clean')
    expect(view.paperJump).toMatchObject({ projectId: 'p1', line: 5 })
    expect(view.toasts.at(-1)).toMatchObject({ kind: 'info', copy: 'toast.figureAlreadyInserted' })
  })

  it('converts an SVG figure on the host and inserts the block referencing the product', async () => {
    let convertCalls = 0
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk(TEX, 1000))),
      savePaperSource: () => Promise.resolve(carried<ResearchSavePaperSourceResult>({ ok: true, value: { mtimeMs: 2000 } })),
      convertFigure: (request) => {
        convertCalls += 1
        expect(request).toMatchObject({ projectId: 'p1', relPath: 'figures/plot.svg' })
        return Promise.resolve(carried<ResearchConvertFigureResult>({
          ok: true, value: { relPath: 'figures/plot.pdf', converter: 'rsvg-convert' },
        }))
      },
      // The conversion rescans the figures view so the new product card shows.
      listFigures: () => Promise.resolve(carried<ResearchFiguresResult>({ ok: true, value: { figures: [] } })),
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    const line = await controller.insertFigureIntoPaper('p1', { ...FIGURE, name: 'plot.svg', relPath: 'figures/plot.svg' })
    expect(line).toBe(6)
    expect(convertCalls).toBe(1)
    const view = controller.getSnapshot()
    expect(view.source?.content).toContain('\\includegraphics[width=\\linewidth]{figures/plot.pdf}')
    expect(view.source?.content).toContain('\\label{fig:plot}')
    expect(view.paperJump).toMatchObject({ projectId: 'p1', line: 6 })
    expect(view.toasts.at(-1)).toMatchObject({ kind: 'success', copy: 'toast.figureConvertedSvg', detail: 'plot.svg → plot.pdf' })
  })

  it('treats an already-referenced converted product as inserted, never converting again', async () => {
    let convertCalls = 0
    const withProduct = TEX.replace('text', '\\begin{figure}[t]\n  \\includegraphics{figures/plot.pdf}\n\\end{figure}')
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk(withProduct, 1000))),
      convertFigure: () => {
        convertCalls += 1
        return Promise.reject(new Error('should not be called'))
      },
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    const line = await controller.insertFigureIntoPaper('p1', { ...FIGURE, name: 'plot.svg', relPath: 'figures/plot.svg' })
    expect(line).toBe(5)
    expect(convertCalls).toBe(0)
    const view = controller.getSnapshot()
    expect(view.source?.content).toBe(withProduct)
    expect(view.toasts.at(-1)).toMatchObject({ kind: 'info', copy: 'toast.figureAlreadyInserted', detail: 'plot.svg' })
  })

  it('toasts the reason and inserts nothing when the SVG conversion fails', async () => {
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk(TEX, 1000))),
      convertFigure: () => Promise.resolve(carried<ResearchConvertFigureResult>({
        ok: false, error: { code: 'operation-failed', message: 'No SVG converter found on this machine (looked for rsvg-convert, inkscape, magick).' },
      })),
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    const line = await controller.insertFigureIntoPaper('p1', { ...FIGURE, name: 'plot.svg', relPath: 'figures/plot.svg' })
    expect(line).toBeNull()
    const view = controller.getSnapshot()
    expect(view.source?.content).toBe(TEX)
    expect(view.toasts.at(-1)).toMatchObject({
      kind: 'error',
      copy: 'toast.figureSvgConvertFailed',
      detail: 'No SVG converter found on this machine (looked for rsvg-convert, inkscape, magick).',
    })
  })

  it('toasts the transport failure when the SVG conversion call itself fails', async () => {
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk(TEX, 1000))),
      convertFigure: () => Promise.reject(new Error('socket closed')),
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    const line = await controller.insertFigureIntoPaper('p1', { ...FIGURE, name: 'plot.svg', relPath: 'figures/plot.svg' })
    expect(line).toBeNull()
    expect(controller.getSnapshot().toasts.at(-1)).toMatchObject({
      kind: 'error', copy: 'toast.figureSvgConvertFailed', detail: 'socket closed',
    })
  })

  it('toasts the failure when the paper source cannot be loaded', async () => {
    const controller = new ResearchController(stubRemote({
      getPaperSource: () => Promise.resolve(carried<ResearchPaperSourceResult>({
        ok: false, error: { code: 'paper-not-found' },
      })),
    }))
    const line = await controller.insertFigureIntoPaper('p1', FIGURE)
    expect(line).toBeNull()
    expect(controller.getSnapshot().source).toMatchObject({ status: 'error', failure: { code: 'paper-not-found' } })
    expect(controller.getSnapshot().toasts.at(-1)).toMatchObject({ kind: 'error', copy: 'toast.figureInsertFailed' })
  })

  it('refuses to touch a conflicted draft', async () => {
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk(TEX, 1000))),
      savePaperSource: () => Promise.resolve(carried<ResearchSavePaperSourceResult>({
        ok: false, error: { code: 'conflict', currentMtimeMs: 2000 },
      })),
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    controller.edit('my draft')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS)
    expect(controller.getSnapshot().source?.saveState).toBe('conflict')
    const line = await controller.insertFigureIntoPaper('p1', FIGURE)
    expect(line).toBeNull()
    expect(controller.getSnapshot().source?.content).toBe('my draft')
    expect(controller.getSnapshot().toasts.at(-1)).toMatchObject({ kind: 'error', copy: 'toast.figureInsertConflict' })
  })

  describe('generateMetricFigure (the experiments chart button)', () => {
  const ROWS = [
    { id: 'e1', name: 'baseline', status: 'success' as const, value: 92.4 },
    { id: 'e2', name: 'full model', status: 'success' as const, value: 88.1 },
  ]

  it('saves the rendered SVG through the host, then inserts the converted product', async () => {
    let savedRequest: unknown = null
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk(TEX, 1000))),
      savePaperSource: () => Promise.resolve(carried<ResearchSavePaperSourceResult>({ ok: true, value: { mtimeMs: 2000 } })),
      saveFigure: (request) => {
        savedRequest = request
        return Promise.resolve(carried<ResearchSaveFigureResult>({
          ok: true, value: {
            relPath: 'figures/metric-mpjpe.svg',
            caption: 'Comparison of mpjpe across experiments: baseline (92.4), full model (88.1).',
            converted: { relPath: 'figures/metric-mpjpe.pdf', converter: 'rsvg-convert' },
          },
        }))
      },
      // The insert path re-asks for the conversion; the host reuses the fresh product.
      convertFigure: () => Promise.resolve(carried<ResearchConvertFigureResult>({
        ok: true, value: { relPath: 'figures/metric-mpjpe.pdf', converter: 'cached' },
      })),
      listFigures: () => Promise.resolve(carried<ResearchFiguresResult>({ ok: true, value: { figures: [] } })),
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    const line = await controller.generateMetricFigure('p1', 'mpjpe', ROWS)
    expect(line).toBe(6)
    expect(savedRequest).toMatchObject({ projectId: 'p1', name: 'metric-mpjpe.svg' })
    const request = savedRequest as { content: string; caption: string }
    expect(request.content).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(request.content).toContain('>baseline</text>')
    expect(request.caption).toContain('Comparison of mpjpe')
    const view = controller.getSnapshot()
    expect(view.source?.content).toContain('\\includegraphics[width=\\linewidth]{figures/metric-mpjpe.pdf}')
    expect(view.source?.content).toContain('\\caption{Comparison of mpjpe across experiments: baseline (92.4), full model (88.1).}')
    expect(view.source?.content).toContain('\\label{fig:metric-mpjpe}')
    expect(view.paperJump).toMatchObject({ projectId: 'p1', line: 6 })
    expect(view.toasts.at(-1)).toMatchObject({ kind: 'success', copy: 'toast.figureConvertedSvg' })
  })

  it('toasts the reason and inserts nothing when the save is rejected', async () => {
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk(TEX, 1000))),
      saveFigure: () => Promise.resolve(carried<ResearchSaveFigureResult>({
        ok: false, error: { code: 'invalid-name', name: 'metric-mpjpe.svg' },
      })),
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    const line = await controller.generateMetricFigure('p1', 'mpjpe', ROWS)
    expect(line).toBeNull()
    expect(controller.getSnapshot().source?.content).toBe(TEX)
    expect(controller.getSnapshot().toasts.at(-1)).toMatchObject({ kind: 'error', copy: 'toast.metricFigureFailed' })
  })

  it('toasts the transport failure when the save call itself fails', async () => {
    const controller = new ResearchController(stubRemote({
      ...selectReads,
      getPaperSource: () => Promise.resolve(carried(sourceOk(TEX, 1000))),
      saveFigure: () => Promise.reject(new Error('socket closed')),
    }))
    controller.select('p1')
    await vi.advanceTimersByTimeAsync(0)
    const line = await controller.generateMetricFigure('p1', 'mpjpe', ROWS)
    expect(line).toBeNull()
    expect(controller.getSnapshot().toasts.at(-1)).toMatchObject({
      kind: 'error', copy: 'toast.metricFigureFailed', detail: 'socket closed',
    })
  })

  it('does nothing for an empty row list', async () => {
    const controller = new ResearchController(stubRemote({}))
    const line = await controller.generateMetricFigure('p1', 'mpjpe', [])
    expect(line).toBeNull()
    expect(controller.getSnapshot().toasts).toEqual([])
  })
})
})

describe('ResearchController ledger (growth record)', () => {
  const EVENT = {
    id: 'ev-1',
    ts: '2026-08-24T10:00:00.000Z',
    actor: { kind: 'system' as const, id: 'service' },
    action: 'compute.job.settled',
    refs: { projectId: 'p1' },
    payload: { status: 'succeeded' },
  }

  it('loadLedger forwards the window filter and publishes the events', async () => {
    const seen: unknown[] = []
    const controller = new ResearchController(stubRemote({
      listEvents: (request) => {
        seen.push(request)
        return Promise.resolve(carried<ResearchListEventsResult>({ ok: true, value: { events: [EVENT] } }))
      },
    }))
    controller.loadLedger({ until: '2026-08-24T12:00:00.000Z', order: 'desc', limit: 200 })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual([{ until: '2026-08-24T12:00:00.000Z', order: 'desc', limit: 200 }])
    expect(controller.getSnapshot().ledger).toEqual({
      status: 'ready', list: [EVENT], failure: null,
    })
  })

  it('loadLedger surfaces a business failure in the slice', async () => {
    const controller = new ResearchController(stubRemote({
      listEvents: () => Promise.resolve(carried<ResearchListEventsResult>({
        ok: false,
        error: { code: 'invalid-input', message: 'bad since' },
      })),
    }))
    controller.loadLedger({ since: 'not-a-date' })
    await Promise.resolve()
    await Promise.resolve()
    const ledger = controller.getSnapshot().ledger
    expect(ledger.status).toBe('error')
    expect(ledger.failure).toEqual({ code: 'invalid-input', message: 'bad since' })
  })

  it('loadLedger keeps the previous window on screen while a switch is in flight', async () => {
    const gate = deferred<RemoteResult<ResearchListEventsResult>>()
    let listCalls = 0
    const controller = new ResearchController(stubRemote({
      listEvents: () => {
        listCalls += 1
        return listCalls === 1
          ? Promise.resolve(carried<ResearchListEventsResult>({ ok: true, value: { events: [EVENT] } }))
          : gate.promise
      },
    }))
    controller.loadLedger({ order: 'desc' })
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().ledger.status).toBe('ready')
    // The second window starts loading without blanking the first one.
    controller.loadLedger({ order: 'asc' })
    const switching = controller.getSnapshot().ledger
    expect(switching.status).toBe('loading')
    expect(switching.list).toEqual([EVENT])
    gate.resolve(carried<ResearchListEventsResult>({ ok: true, value: { events: [] } }))
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().ledger).toEqual({ status: 'ready', list: [], failure: null })
  })

  it('generateReport publishes the Markdown and toasts the success', async () => {
    const controller = new ResearchController(stubRemote({
      generateProgressReport: () => Promise.resolve(carried<ResearchProgressReportResult>({
        ok: true,
        value: { markdown: '# Mimir Research Progress Report', generatedAt: '2026-08-24T12:00:00.000Z', eventCount: 3 },
      })),
    }))
    const failure = await controller.generateReport({ since: '2026-08-17T00:00:00.000Z' })
    expect(failure).toBeNull()
    expect(controller.getSnapshot().report).toEqual({
      status: 'ready',
      markdown: '# Mimir Research Progress Report',
      generatedAt: '2026-08-24T12:00:00.000Z',
      eventCount: 3,
      failure: null,
    })
    expect(controller.getSnapshot().toasts).toHaveLength(1)
    expect(controller.getSnapshot().toasts[0]?.copy).toBe('ledger.report.ready')
  })

  it('generateReport returns the failure view and freezes the slice on error', async () => {
    const controller = new ResearchController(stubRemote({
      generateProgressReport: () => Promise.resolve(carried<ResearchProgressReportResult>({
        ok: false,
        error: { code: 'project-not-found', message: 'no such project' },
      })),
    }))
    const failure = await controller.generateReport({ projectId: 'missing' })
    expect(failure).toEqual({ code: 'project-not-found', message: 'no such project' })
    const report = controller.getSnapshot().report
    expect(report.status).toBe('error')
    expect(report.failure?.code).toBe('project-not-found')
  })
})

describe('ResearchController cognitive brief (CBE)', () => {
  /** One stored journal event, as the service would return it. */
  const JOURNAL_EVENT = {
    id: 'ev-j1',
    ts: '2026-08-27T06:00:00.000Z',
    actor: { kind: 'user' as const, id: 'panel' },
    action: 'journal.entry.added',
    refs: { projectId: 'p1' },
    payload: { text: '这一句算数' },
  }

  it('generateBrief publishes the brief slice and toasts the success', async () => {
    const controller = new ResearchController(stubRemote({
      generateBrief: () => Promise.resolve(carried<ResearchGenerateBriefResult>({
        ok: true,
        value: {
          markdown: '# Cognitive Brief',
          generatedAt: '2026-08-27T06:00:00.000Z',
          eventCount: 4,
          derivationVersion: 2,
          questions: [{ kind: 'pending-claim', lineId: 'c9', label: 'delta transfers' }],
        },
      })),
    }))
    const failure = await controller.generateBrief({ projectId: 'p1' })
    expect(failure).toBeNull()
    expect(controller.getSnapshot().brief).toEqual({
      status: 'ready',
      markdown: '# Cognitive Brief',
      generatedAt: '2026-08-27T06:00:00.000Z',
      eventCount: 4,
      derivationVersion: 2,
      recalibrated: false,
      questions: [{ kind: 'pending-claim', lineId: 'c9', label: 'delta transfers' }],
      failure: null,
    })
    expect(controller.getSnapshot().toasts).toHaveLength(1)
    expect(controller.getSnapshot().toasts[0]?.copy).toBe('brief.ready')
  })

  it('generateBrief returns the failure view and freezes the slice on error', async () => {
    const controller = new ResearchController(stubRemote({
      generateBrief: () => Promise.resolve(carried<ResearchGenerateBriefResult>({
        ok: false,
        error: { code: 'project-not-found', message: 'no such project' },
      })),
    }))
    const failure = await controller.generateBrief({ projectId: 'ghost' })
    expect(failure).toEqual({ code: 'project-not-found', message: 'no such project' })
    const brief = controller.getSnapshot().brief
    expect(brief.status).toBe('error')
    expect(brief.failure?.code).toBe('project-not-found')
  })

  it('addJournal sends exactly the text and project scope, and toasts once', async () => {
    const seen: unknown[] = []
    const controller = new ResearchController(stubRemote({
      addJournalEntry: (request) => {
        seen.push(request)
        return Promise.resolve(carried<ResearchAddJournalEntryResult>({ ok: true, value: { event: JOURNAL_EVENT } }))
      },
    }))
    const failure = await controller.addJournal('这一句算数', 'p1')
    expect(failure).toBeNull()
    expect(seen).toEqual([{ text: '这一句算数', projectId: 'p1' }])
    expect(controller.getSnapshot().toasts).toHaveLength(1)
    expect(controller.getSnapshot().toasts[0]?.copy).toBe('journal.added')
  })

  it('addJournal omits the projectId key entirely for an unscoped entry', async () => {
    const seen: unknown[] = []
    const controller = new ResearchController(stubRemote({
      addJournalEntry: (request) => {
        seen.push(request)
        return Promise.resolve(carried<ResearchAddJournalEntryResult>({ ok: true, value: { event: JOURNAL_EVENT } }))
      },
    }))
    const failure = await controller.addJournal('不限项目的一句', null)
    expect(failure).toBeNull()
    // exactOptionalPropertyTypes: the absent scope must not cross as `undefined`.
    expect(seen).toEqual([{ text: '不限项目的一句' }])
    expect(Object.prototype.hasOwnProperty.call(seen[0], 'projectId')).toBe(false)
  })

  it('addJournal forwards a line ref and mood ratings, absent keys omitted', async () => {
    const seen: unknown[] = []
    const controller = new ResearchController(stubRemote({
      addJournalEntry: (request) => {
        seen.push(request)
        return Promise.resolve(carried<ResearchAddJournalEntryResult>({ ok: true, value: { event: JOURNAL_EVENT } }))
      },
    }))
    const failure = await controller.addJournal('留着这条线', null, { ideaId: 'idea-r', valence: 4 })
    expect(failure).toBeNull()
    expect(seen).toEqual([{ text: '留着这条线', ideaId: 'idea-r', valence: 4 }])
    expect(Object.prototype.hasOwnProperty.call(seen[0], 'projectId')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(seen[0], 'arousal')).toBe(false)
  })

  it('addJournal forwards a boundary-question ref exactly when present', async () => {
    const seen: unknown[] = []
    const controller = new ResearchController(stubRemote({
      addJournalEntry: (request) => {
        seen.push(request)
        return Promise.resolve(carried<ResearchAddJournalEntryResult>({ ok: true, value: { event: JOURNAL_EVENT } }))
      },
    }))
    const failure = await controller.addJournal('先放着', null, {
      question: { kind: 'pending-claim', lineId: 'c9' },
    })
    expect(failure).toBeNull()
    expect(seen).toEqual([{ text: '先放着', question: { kind: 'pending-claim', lineId: 'c9' } }])
    expect(Object.prototype.hasOwnProperty.call(seen[0], 'ideaId')).toBe(false)
  })

  it('addJournal returns the failure view inline and stays quiet', async () => {
    const controller = new ResearchController(stubRemote({
      addJournalEntry: () => Promise.resolve(carried<ResearchAddJournalEntryResult>({
        ok: false,
        error: { code: 'invalid-input', message: 'journal text must not be empty' },
      })),
    }))
    const failure = await controller.addJournal('   ', null)
    expect(failure).toEqual({ code: 'invalid-input', message: 'journal text must not be empty' })
    expect(controller.getSnapshot().toasts).toEqual([])
  })
})

describe('ResearchController worktree (S2)', () => {
  const TREE: ResearchWorktreeView = {
    derivedAt: '2026-08-27T07:00:00.000Z',
    lanes: [
      {
        lineId: 'i1', label: 'Idea One', status: 'open', state: 'dominant',
        parentLineId: null, parentLabel: null,
        firstSeen: '2026-08-01T00:00:00.000Z', lastSeen: '2026-08-26T00:00:00.000Z',
        eventCount: 6, drift: 4.5, closedAt: null, closeReason: null, gutDays: null, idleDays: 1,
        touches: [],
      },
      {
        lineId: 'i2', label: 'Old branch', status: 'failed', state: 'settled',
        parentLineId: 'i1', parentLabel: 'Idea One',
        firstSeen: '2026-08-02T00:00:00.000Z', lastSeen: '2026-08-10T00:00:00.000Z',
        eventCount: 3, drift: -1.2, closedAt: '2026-08-10T00:00:00.000Z', closeReason: 'no effect', gutDays: 4, idleDays: null,
        touches: [],
      },
    ],
    mainline: { lineId: 'i1', label: 'Idea One', declaredAt: '2026-08-20T00:00:00.000Z' , touches: [] },
    mainlineHistory: [{ lineId: 'i1', label: 'Idea One', declaredAt: '2026-08-20T00:00:00.000Z' }],
    counts: { open: 1, failed: 1, adopted: 0 },
  }

  const STRUCTURAL_EVENT = {
    id: 'ev-s1',
    ts: '2026-08-27T07:10:00.000Z',
    actor: { kind: 'user' as const, id: 'panel' },
    action: 'cbe.mainline.set',
    refs: { ideaId: 'i1' },
    payload: {},
  }

  it('ensureWorktree loads once and publishes the ready slice', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      getWorktree: () => {
        calls += 1
        return Promise.resolve(carried<ResearchGetWorktreeResult>({ ok: true, value: { worktree: TREE } }))
      },
    }))
    controller.ensureWorktree()
    controller.ensureWorktree()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(calls).toBe(1)
    expect(controller.getSnapshot().worktree).toEqual({ status: 'ready', view: TREE, failure: null })
  })

  it('getWorktree business failure freezes the slice with the failure view', async () => {
    const controller = new ResearchController(stubRemote({
      getWorktree: () => Promise.resolve(carried<ResearchGetWorktreeResult>({
        ok: false,
        error: { code: 'operation-failed', message: 'the worktree could not be derived' },
      })),
    }))
    controller.ensureWorktree()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const worktree = controller.getSnapshot().worktree
    expect(worktree.status).toBe('error')
    expect(worktree.failure).toEqual({ code: 'operation-failed', message: 'the worktree could not be derived' })
  })

  it('setMainline splits a project lane into a projectId-only request', async () => {
    const seen: unknown[] = []
    const controller = new ResearchController(stubRemote({
      setMainline: request => {
        seen.push(request)
        return Promise.resolve(carried<ResearchSetMainlineResult>({ ok: true, value: { event: STRUCTURAL_EVENT } }))
      },
      getWorktree: () => Promise.resolve(carried<ResearchGetWorktreeResult>({ ok: true, value: { worktree: TREE } })),
    }))
    const failure = await controller.setMainline('project:p1')
    expect(failure).toBeNull()
    expect(seen).toEqual([{ projectId: 'p1' }])
    expect(Object.prototype.hasOwnProperty.call(seen[0], 'ideaId')).toBe(false)
  })

  it('setMainline toasts once and refreshes the tree', async () => {
    let loads = 0
    const controller = new ResearchController(stubRemote({
      setMainline: () => Promise.resolve(carried<ResearchSetMainlineResult>({ ok: true, value: { event: STRUCTURAL_EVENT } })),
      getWorktree: () => {
        loads += 1
        return Promise.resolve(carried<ResearchGetWorktreeResult>({ ok: true, value: { worktree: TREE } }))
      },
    }))
    controller.ensureWorktree()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const failure = await controller.setMainline('i1')
    expect(failure).toBeNull()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(loads).toBe(2)
    expect(controller.getSnapshot().toasts[0]?.copy).toBe('worktree.mainline.ready')
  })

  it('setIdeaParent forwards null as an explicit clear and stays quiet on failure', async () => {
    const seen: unknown[] = []
    const controller = new ResearchController(stubRemote({
      setIdeaParent: request => {
        seen.push(request)
        return Promise.resolve(carried<ResearchSetIdeaParentResult>({
          ok: false,
          error: { code: 'invalid-input', message: 'that derivation would create a cycle' },
        }))
      },
    }))
    const failure = await controller.setIdeaParent('i1', null)
    expect(seen).toEqual([{ ideaId: 'i1', parentIdeaId: null }])
    expect(failure).toEqual({ code: 'invalid-input', message: 'that derivation would create a cycle' })
    expect(controller.getSnapshot().toasts).toEqual([])
  })

  it('closeIdea rejects an over-cap reason client-side without a remote call', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      closeIdea: () => {
        calls += 1
        return Promise.resolve(carried<ResearchCloseIdeaResult>({ ok: true, value: { event: STRUCTURAL_EVENT } }))
      },
    }))
    const failure = await controller.closeIdea('i2', 'x'.repeat(49))
    expect(failure).toEqual({ code: 'invalid-input', message: 'close reason is capped at 48 characters' })
    expect(calls).toBe(0)
  })

  it('closeIdea records the documented No and refreshes the tree', async () => {
    const seen: unknown[] = []
    let loads = 0
    const closeEvent = { ...STRUCTURAL_EVENT, action: 'knowledge.idea.failed', refs: { ideaId: 'i2' }, payload: { reason: 'no effect' } }
    const controller = new ResearchController(stubRemote({
      closeIdea: request => {
        seen.push(request)
        return Promise.resolve(carried<ResearchCloseIdeaResult>({ ok: true, value: { event: closeEvent } }))
      },
      getWorktree: () => {
        loads += 1
        return Promise.resolve(carried<ResearchGetWorktreeResult>({ ok: true, value: { worktree: TREE } }))
      },
    }))
    controller.ensureWorktree()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const failure = await controller.closeIdea('i2', 'no effect')
    expect(failure).toBeNull()
    expect(seen).toEqual([{ ideaId: 'i2', reason: 'no effect' }])
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(loads).toBe(2)
    expect(controller.getSnapshot().toasts[0]?.copy).toBe('worktree.closed')
  })
})

describe('ResearchController foraging (S4)', () => {
  const LAYER: ResearchForagingView = {
    derivedAt: '2026-08-27T08:00:00.000Z',
    territories: [
      {
        projectId: 'p1', label: 'Project One', eventCount: 6,
        firstSeen: '2026-08-01T00:00:00.000Z', lastSeen: '2026-08-26T00:00:00.000Z',
        activityMass: 4.2, harvestCount: 1, lastHarvestAt: '2026-08-20T00:00:00.000Z',
        daysSinceHarvest: 6, daysSinceActivity: 1,
      },
    ],
    baseline: { samples: 2, medianDays: null, iqrDays: null, minSamples: 5, speaks: false },
    cards: [
      { projectId: 'p1', label: 'Project One', daysSinceHarvest: 6, daysSinceActivity: 1, baselineMedianDays: null },
    ],
  }

  it('ensureForaging loads once and publishes the ready slice', async () => {
    let calls = 0
    const controller = new ResearchController(stubRemote({
      getForaging: () => {
        calls += 1
        return Promise.resolve(carried<ResearchGetForagingResult>({ ok: true, value: { foraging: LAYER } }))
      },
    }))
    controller.ensureForaging()
    controller.ensureForaging()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(calls).toBe(1)
    expect(controller.getSnapshot().foraging).toEqual({ status: 'ready', view: LAYER, failure: null })
  })

  it('a documented close refreshes the foraging layer (a new GUT sample)', async () => {
    let loads = 0
    const closeEvent = {
      id: 'ev-c1',
      ts: '2026-08-27T08:10:00.000Z',
      actor: { kind: 'user' as const, id: 'panel' },
      action: 'knowledge.idea.failed',
      refs: { ideaId: 'i2' },
      payload: { reason: 'no effect' },
    }
    const controller = new ResearchController(stubRemote({
      closeIdea: () => Promise.resolve(carried<ResearchCloseIdeaResult>({ ok: true, value: { event: closeEvent } })),
      getWorktree: () => Promise.resolve(carried<ResearchGetWorktreeResult>({ ok: true, value: { worktree: TREE } })),
      getForaging: () => {
        loads += 1
        return Promise.resolve(carried<ResearchGetForagingResult>({ ok: true, value: { foraging: LAYER } }))
      },
    }))
    controller.ensureWorktree()
    controller.ensureForaging()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const failure = await controller.closeIdea('i2', 'no effect')
    expect(failure).toBeNull()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(loads).toBe(2)
  })
})

describe('ResearchController adoptIdea (worktree merge)', () => {
  it('a merge refreshes the worktree but not the foraging baseline (not a departure)', async () => {
    let worktreeLoads = 0
    let foragingLoads = 0
    const mergeEvent = {
      id: 'ev-a1',
      ts: '2026-08-27T08:00:00.000Z',
      actor: { kind: 'user' as const, id: 'panel' },
      action: 'knowledge.idea.adopted',
      refs: { ideaId: 'i2' },
      payload: {},
    }
    const controller = new ResearchController(stubRemote({
      adoptIdea: () => Promise.resolve(carried<ResearchAdoptIdeaResult>({ ok: true, value: { event: mergeEvent } })),
      getWorktree: () => {
        worktreeLoads += 1
        return Promise.resolve(carried<ResearchGetWorktreeResult>({ ok: true, value: { worktree: TREE } }))
      },
      getForaging: () => {
        foragingLoads += 1
        return Promise.resolve(carried<ResearchGetForagingResult>({ ok: true, value: { foraging: LAYER } }))
      },
    }))
    controller.ensureWorktree()
    controller.ensureForaging()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const failure = await controller.adoptIdea('i2')
    expect(failure).toBeNull()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(worktreeLoads).toBe(2) // the merge re-derives the tree
    expect(foragingLoads).toBe(1) // a merge is not a GUT departure
  })
})
