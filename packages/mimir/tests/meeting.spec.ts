/**
 * Behavior tests for the meeting-deck verbs: the pure slide-plan builder
 * (order, caps, relevance injection), generateMeetingDeck (default and
 * explicit selection, svg-only figures skipped, a real pptx render), and the
 * list/delete pair. Real memory-backed domain, real temp workspace — no
 * mocks.
 */

import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import { buildDeckModel, meetingDeckPath, DECK_MAX_PAPERS, localToday } from '../src/services/meeting.ts'
import type {
  ExperimentRecord,
  FigureRecord,
  PaperRecord,
  ProjectRecord,
} from '../src/types.ts'

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-meeting-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
    // No network in tests: the PDF warm-up seam is a no-op here.
    meetings: { fetchPdf: async () => undefined },
  })
  return { ctx, domain, workspaceDir, service }
}

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Quant Agent',
  stage: 'experiment',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

/** One library paper linked to the project, relevance-scored or not. */
function paperOf(arxivId: string, score?: number): PaperRecord {
  return {
    arxivId,
    title: `Paper ${arxivId}`,
    authors: ['Alice', 'Bob'],
    summary: 'A summary long enough to be a fallback bullet.',
    url: `https://arxiv.org/abs/${arxivId}`,
    notes: '为什么重要：这是本项目必须打过的 baseline。',
    tags: ['baseline'],
    projectIds: ['p1'],
    ...(score === undefined
      ? {}
      : { relevance: { p1: { score, reason: '机制与本项目相同', scoredAt: '2026-08-20T00:00:00.000Z' } } }),
    addedAt: '2026-08-19T00:00:00.000Z',
  }
}

/** One recent experiment of the project. */
function experimentOf(id: string): ExperimentRecord {
  return {
    id,
    projectId: 'p1',
    name: `run-${id}`,
    status: 'success',
    metrics: { accuracy: 0.91 },
    updatedAt: '2026-08-20T00:00:00.000Z',
  }
}

/** 1×1 transparent PNG, enough for pptxgenjs to embed. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

describe('localToday', () => {
  it('formats the local calendar date with zero padding, not the UTC one', () => {
    // Constructed from local components, so the expectation holds in any zone.
    expect(localToday(new Date(2026, 0, 15, 1, 0))).toBe('2026-01-15')
    expect(localToday(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
    expect(localToday(new Date(2026, 2, 3, 12, 0))).toBe('2026-03-03')
  })
})

describe('buildDeckModel', () => {
  it('orders slides title → agenda → progress → experiments → figures → papers → closing', () => {
    const slides = buildDeckModel({
      project: PROJECT,
      title: '组会汇报',
      date: '2026-08-24',
      paperCount: 3,
      papers: [paperOf('2103.00020', 9)],
      paperFigures: {},
      experiments: [experimentOf('e1')],
      figures: [{
        record: {
          id: 'p1:figures/a.png', projectId: 'p1', relPath: 'figures/a.png',
          caption: 'Fig.1 去掉检索后召回掉 8 个点', createdAt: '2026-08-20T00:00:00.000Z',
        },
        imagePath: '/tmp/a.png',
      }],
      include: { progress: true, experiments: true, figures: true, papers: true },
    })
    expect(slides[0]?.kind).toBe('title')
    expect(slides[1]?.kind).toBe('agenda')
    expect(slides[2]?.kind).toBe('bullets')
    expect(slides.at(-1)?.kind).toBe('closing')
    const figureSlide = slides.find(slide => slide.kind === 'figure')
    expect(figureSlide?.kind === 'figure' ? figureSlide.caption : '').toContain('Fig.1')
  })

  it('embeds AI illustrations on the title and paper intro slides, with kickers', () => {
    const slides = buildDeckModel({
      project: PROJECT,
      title: '组会汇报',
      date: '2026-08-24',
      paperCount: 1,
      papers: [paperOf('2103.00020', 9)],
      paperFigures: {
        '2103.00020': [{ imagePath: '/tmp/fig1.png', label: 'Figure 1', caption: '首图要点' }],
      },
      coverArt: '/tmp/cover.png',
      paperArt: { '2103.00020': '/tmp/paper-art.png' },
      experiments: [],
      figures: [],
      include: { progress: true, experiments: true, figures: true, papers: true },
    })
    const title = slides[0]
    expect(title?.kind === 'title' ? title.imagePath : undefined).toBe('/tmp/cover.png')
    const paperSlide = slides.find(slide => slide.kind === 'bullets' && slide.heading !== '项目进展')
    expect(paperSlide?.kind === 'bullets' ? paperSlide.imagePath : undefined).toBe('/tmp/paper-art.png')
    expect(paperSlide?.kind === 'bullets' ? paperSlide.kicker : undefined).toBe('文献分享')
    const figureSlide = slides.find(slide => slide.kind === 'figure')
    expect(figureSlide?.kind === 'figure' ? figureSlide.kicker : undefined).toBe(paperOf('2103.00020', 9).title)
    expect(figureSlide?.kind === 'figure' ? figureSlide.heading : undefined).toBe('Figure 1')
  })

  it('honors the include switches and drops empty sections from the agenda', () => {
    const slides = buildDeckModel({
      project: PROJECT,
      title: '组会汇报',
      date: '2026-08-24',
      paperCount: 0,
      papers: [],
      paperFigures: {},
      experiments: [],
      figures: [],
      include: { progress: true, experiments: true, figures: true, papers: true },
    })
    const agenda = slides.find(slide => slide.kind === 'agenda')
    expect(agenda?.kind === 'agenda' ? agenda.sections : []).toEqual(['项目进展', '下一步计划'])
    expect(slides.filter(slide => slide.kind === 'bullets').map(slide => slide.kind === 'bullets' ? slide.heading : ''))
      .toEqual(['项目进展'])
  })

  it('injects the relevance verdict into the paper slide', () => {
    const slides = buildDeckModel({
      project: PROJECT,
      title: '组会汇报',
      date: '2026-08-24',
      paperCount: 1,
      papers: [paperOf('2103.00020', 9)],
      paperFigures: {},
      experiments: [],
      figures: [],
      include: { progress: false, experiments: false, figures: false, papers: true },
    })
    const paperSlide = slides.find(slide => slide.kind === 'bullets' && slide.heading.startsWith('Paper'))
    expect(paperSlide?.kind === 'bullets'
      ? paperSlide.bullets.some(bullet => bullet.text.includes('相关度 9/10'))
      : false).toBe(true)
  })

  it('caps the experiment slide at eight runs and names the remainder', () => {
    const experiments = Array.from({ length: 10 }, (_, index) => experimentOf(`e${String(index)}`))
    const slides = buildDeckModel({
      project: PROJECT,
      title: '组会汇报',
      date: '2026-08-24',
      paperCount: 0,
      papers: [],
      paperFigures: {},
      experiments,
      figures: [],
      include: { progress: false, experiments: true, figures: false, papers: false },
    })
    const slide = slides.find(entry => entry.kind === 'bullets' && entry.heading === '实验结果')
    if (slide?.kind !== 'bullets') throw new Error('expected an experiments slide')
    expect(slide.bullets.length).toBe(9)
    expect(slide.bullets.at(-1)?.text).toContain('另外 2 次实验')
  })

  it('appends one 逐图 slide per extracted paper figure after the intro', () => {
    const slides = buildDeckModel({
      project: PROJECT,
      title: '组会汇报',
      date: '2026-08-24',
      paperCount: 1,
      papers: [paperOf('2103.00020', 9)],
      paperFigures: {
        '2103.00020': [
          { imagePath: '/tmp/fig-01.png', label: 'Figure 1', caption: 'Fig.1 方法总览：检索模块是核心' },
          { imagePath: '/tmp/fig-02.png', label: 'Figure 2', caption: 'Fig.2 去掉检索召回掉 8 个点' },
        ],
      },
      experiments: [],
      figures: [],
      include: { progress: false, experiments: false, figures: false, papers: true },
    })
    const figureSlides = slides.filter(slide => slide.kind === 'figure')
    expect(figureSlides.length).toBe(2)
    expect(figureSlides[0]?.kind === 'figure' ? figureSlides[0].heading : '').toContain('Figure 1')
    expect(figureSlides[1]?.kind === 'figure' ? figureSlides[1].caption : '').toContain('召回掉 8 个点')
    // The intro slide still precedes the figure slides.
    const introIndex = slides.findIndex(slide => slide.kind === 'bullets' && slide.heading.startsWith('Paper'))
    expect(slides.indexOf(figureSlides[0] as never)).toBeGreaterThan(introIndex)
  })
})

describe('generateMeetingDeck', () => {
  it('rejects an unknown project', async () => {
    const { service } = await harness()
    const result = await service.generateMeetingDeck({ projectId: 'nope' })
    expect(result).toMatchObject({ ok: false, error: { code: 'project-not-found' } })
  })

  it('renders a real pptx from the wiki and lists it afterwards', async () => {
    const { domain, workspaceDir, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await mkdir(join(workspaceDir, 'paper', 'figures'), { recursive: true })
    await writeFile(join(workspaceDir, 'paper', 'figures', 'a.png'), PNG_BYTES)
    // A disk-only figure (no metadata row, e.g. uploaded through the panel)
    // must still reach the deck.
    await writeFile(join(workspaceDir, 'paper', 'figures', 'c.png'), PNG_BYTES)
    // An svg-only record has no raster sibling and must not reach the deck.
    await domain.table('figures').put('p1:figures/a.png', {
      id: 'p1:figures/a.png', projectId: 'p1', relPath: 'figures/a.png',
      caption: 'Fig.1 主结果', createdAt: '2026-08-20T00:00:00.000Z',
    } satisfies FigureRecord)
    await domain.table('figures').put('p1:figures/b.svg', {
      id: 'p1:figures/b.svg', projectId: 'p1', relPath: 'figures/b.svg',
      caption: 'svg only', createdAt: '2026-08-20T00:00:00.000Z',
    } satisfies FigureRecord)
    await domain.table('papers').put('2103.00020', paperOf('2103.00020', 9))
    await domain.table('papers').put('2103.00021', paperOf('2103.00021', 4))
    await domain.table('experiments').put('e1', experimentOf('e1'))

    const result = await service.generateMeetingDeck({
      projectId: 'p1',
      title: 'Weekly Sync',
      presenter: 'wujie',
      date: '2026-08-24',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.file.endsWith('.pptx')).toBe(true)
    // title + agenda + progress + experiments + two figures + two papers + closing
    expect(result.value.slides).toBe(9)

    const deckPath = meetingDeckPath(workspaceDir, 'p1', result.value.file)
    expect(deckPath).toBeDefined()
    if (deckPath === undefined) return
    const stats = await stat(deckPath)
    expect(stats.size).toBeGreaterThan(10_000)

    const list = await service.listMeetingDecks({ projectId: 'p1' })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.value.decks.map(deck => deck.file)).toContain(result.value.file)
    expect(list.value.decks[0]?.sizeBytes).toBe(stats.size)
  })

  it('prefers an explicit paper selection and caps the default at DECK_MAX_PAPERS', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    for (let index = 0; index < DECK_MAX_PAPERS + 3; index += 1) {
      const id = `2103.000${String(30 + index)}`
      await domain.table('papers').put(id, paperOf(id, index))
    }
    const defaulted = await service.generateMeetingDeck({ projectId: 'p1', date: '2026-08-24' })
    expect(defaulted.ok).toBe(true)
    if (!defaulted.ok) return
    // title + agenda + progress + DECK_MAX_PAPERS paper slides + closing
    expect(defaulted.value.slides).toBe(3 + DECK_MAX_PAPERS + 1)

    const picked = await service.generateMeetingDeck({
      projectId: 'p1',
      date: '2026-08-24',
      paperIds: ['2103.00030', '2103.00031'],
      include: { progress: false },
    })
    expect(picked.ok).toBe(true)
    if (!picked.ok) return
    // title + agenda + two paper slides + closing
    expect(picked.value.slides).toBe(5)
  })

  it('embeds extracted paper figures when an extraction manifest exists', async () => {
    const { domain, workspaceDir, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await domain.table('papers').put('2103.00020', paperOf('2103.00020', 9))
    const assetsDir = join(workspaceDir, 'meetings', '.paper-figures', '2103.00020')
    await mkdir(assetsDir, { recursive: true })
    await writeFile(join(assetsDir, 'fig-01.png'), PNG_BYTES)
    await writeFile(join(assetsDir, 'manifest.json'), JSON.stringify([
      { file: 'fig-01.png', label: 'Figure 1', caption: 'Fig.1 方法总览' },
      // A manifest row whose crop file is gone is dropped, not fatal.
      { file: 'gone.png', label: 'Figure 2', caption: 'missing' },
    ]))
    const result = await service.generateMeetingDeck({
      projectId: 'p1',
      date: '2026-08-24',
      include: { progress: false, experiments: false, figures: false },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // title + agenda + paper intro + one 逐图 slide + closing
    expect(result.value.slides).toBe(5)
  })
})

describe('listMeetingDecks / deleteMeetingDeck', () => {
  it('lists nothing before the first generation and rejects a bad delete', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const list = await service.listMeetingDecks({ projectId: 'p1' })
    expect(list).toMatchObject({ ok: true, value: { decks: [] } })

    const bad = await service.deleteMeetingDeck({ projectId: 'p1', file: '../../etc/passwd.pptx' })
    expect(bad.ok).toBe(false)
    const missing = await service.deleteMeetingDeck({ projectId: 'p1', file: 'gone.pptx' })
    expect(missing).toMatchObject({ ok: false, error: { code: 'invalid-path' } })
  })

  it('deletes a generated deck', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const generated = await service.generateMeetingDeck({ projectId: 'p1', date: '2026-08-24' })
    expect(generated.ok).toBe(true)
    if (!generated.ok) return
    const removed = await service.deleteMeetingDeck({ projectId: 'p1', file: generated.value.file })
    expect(removed).toMatchObject({ ok: true, value: { file: generated.value.file } })
    const list = await service.listMeetingDecks({ projectId: 'p1' })
    expect(list).toMatchObject({ ok: true, value: { decks: [] } })
  })
})
