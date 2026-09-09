/**
 * Meeting-deck domain service: assemble a group-meeting PPTX from the wiki —
 * project progress, experiment runs, paper-directory figures, and selected
 * library papers (with their AI relevance verdicts). The slide plan is a
 * pure, unit-testable model ({@link buildDeckModel}); the pptxgenjs render
 * is a thin shell over it ({@link renderDeck}).
 *
 * Decks land in `<workspace>/meetings/<projectId>/<name>.pptx` — the
 * filesystem is the source of truth, no store table.
 * @module dsh-mimir/src/services/meeting
 */

import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type {
  ExperimentRecord,
  FigureRecord,
  MeetingInclude,
  PaperRecord,
  ProjectRecord,
  ResearchDeleteMeetingDeckResult,
  ResearchGenerateMeetingResult,
  ResearchMeetingDecksResult,
} from '../types.ts'
import { resolvePaperDir } from '../paper-source.ts'
import { listPaperFigures, type FigureFile } from '../artifacts.ts'
import { isValidArxivId } from '../arxiv-id.ts'
import { isValidProjectId } from '../project-id.ts'
import { extractPaperFigures, resolvePaperPdf } from './paper-figures.ts'
import { fetchPaperPdf } from './library.ts'
import {
  IMAGE_GEN_MAX_PER_DECK,
  coverPrompt,
  generateImage,
  paperArtPrompt,
  readImageGenConfig,
  saveDeckIllustration,
} from './image-gen.ts'
import { success, rejected } from './common.ts'
import type { WikiAdminDeps } from './wiki-admin.ts'

/** Directory under the workspace root holding one subfolder per project. */
export const MEETINGS_DIR_NAME = 'meetings'
/** Directory under meetings/ holding per-paper extracted figure crops (the 逐图 assets). */
export const PAPER_FIGURES_DIR_NAME = '.paper-figures'
/** The deck font, per the group-meeting house style. */
export const DECK_FONT = 'Microsoft YaHei'
/** Caps keeping a deck presentable: papers and figures per deck. */
export const DECK_MAX_PAPERS = 12
export const DECK_MAX_FIGURES = 12
/** Per-paper figure-crop cap inside the papers section (the 逐图 slides). */
export const DECK_MAX_PAPER_FIGURES = 3

const DEFAULT_INCLUDE: MeetingInclude = Object.freeze({
  progress: true, experiments: true, figures: true, papers: true,
})

/** One figure chosen for the deck: metadata plus the on-disk image to embed. */
export interface MeetingFigureInput {
  readonly record: FigureRecord
  /** Absolute path of the raster image to embed (png/jpg/jpeg only). */
  readonly imagePath: string
}

/** One figure crop extracted from a paper's PDF (the 逐图 slides of the papers section). */
export interface PaperFigureAsset {
  /** Absolute path of the extracted crop (png). */
  readonly imagePath: string
  /** Figure label as printed in the paper (`Figure 2`, `Fig. 3a`…). */
  readonly label: string
  /** Caption text — the takeaway sentence after the agent's polish pass. */
  readonly caption: string
}

/** Everything {@link buildDeckModel} needs, already gathered. */
export interface DeckModelInput {
  readonly project: ProjectRecord
  readonly title: string
  readonly date: string
  readonly presenter?: string | undefined
  /** Total library papers associated with the project (the slide's count, uncapped). */
  readonly paperCount: number
  readonly papers: readonly PaperRecord[]
  /** Extracted figure crops per paper, keyed by arXiv id (missing = text-only paper slide). */
  readonly paperFigures: Readonly<Record<string, readonly PaperFigureAsset[]>>
  /** AI cover illustration (absolute path), embedded on the title slide. */
  readonly coverArt?: string | undefined
  /** AI concept illustrations per paper, keyed by arXiv id (embedded on the paper's intro slide). */
  readonly paperArt?: Readonly<Record<string, string>> | undefined
  readonly experiments: readonly ExperimentRecord[]
  readonly figures: readonly MeetingFigureInput[]
  readonly include: MeetingInclude
}

/** One text bullet on a content slide. */
export interface DeckBullet {
  readonly text: string
  /** Emphasis lines render bold/accented (section headers within a slide). */
  readonly emph?: boolean
}

/** The pure slide plan: what each slide shows, before any pptxgenjs call. */
export type DeckSlide =
  | { readonly kind: 'title'; readonly title: string; readonly subtitle: string; readonly imagePath?: string | undefined }
  | { readonly kind: 'agenda'; readonly sections: readonly string[] }
  | { readonly kind: 'bullets'; readonly heading: string; readonly kicker?: string | undefined; readonly bullets: readonly DeckBullet[]; readonly imagePath?: string | undefined }
  | { readonly kind: 'figure'; readonly heading: string; readonly kicker?: string | undefined; readonly imagePath: string; readonly caption: string }
  | { readonly kind: 'closing' }

/** Format an ISO date (or raw string) as YYYY-MM-DD for the deck. */
function dateOnly(iso: string): string {
  return iso.slice(0, 10)
}

/**
 * Today as YYYY-MM-DD in the host's LOCAL timezone — the deck's default date
 * line. `new Date().toISOString()` would report the UTC date, which is
 * already tomorrow for evening hosts east of Greenwich.
 */
export function localToday(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** One-line metric summary of an experiment record. */
function metricsLineOf(record: ExperimentRecord): string {
  const entries = Object.entries(record.metrics)
  if (entries.length === 0) return ''
  return entries.slice(0, 4).map(([key, value]) => `${key}: ${String(value)}`).join(' · ')
}

/** Stage → Chinese label used on the progress slide. */
const STAGE_LABELS: Record<ProjectRecord['stage'], string> = {
  idea: '想法', plan: '方案', experiment: '实验', writing: '写作', done: '完成',
}

/**
 * Build the pure slide plan. Slide order: title → agenda → progress →
 * experiments → figures → papers → closing. Papers arrive pre-selected and
 * pre-sorted; figures likewise.
 * @param input - the gathered deck data.
 * @returns the ordered slide plan.
 */
export function buildDeckModel(input: DeckModelInput): readonly DeckSlide[] {
  const slides: DeckSlide[] = []
  const { project, include } = input

  const subtitleParts = [input.date]
  if (input.presenter !== undefined && input.presenter !== '') subtitleParts.push(`汇报人：${input.presenter}`)
  if (project.venue !== undefined) subtitleParts.push(`目标会议：${project.venue.name}`)
  slides.push({ kind: 'title', title: input.title, subtitle: subtitleParts.join('  ·  '), imagePath: input.coverArt })

  const sections: string[] = []
  if (include.progress) sections.push('项目进展')
  if (include.experiments && input.experiments.length > 0) sections.push('实验结果')
  if (include.figures && input.figures.length > 0) sections.push('图表')
  if (include.papers && input.papers.length > 0) sections.push('文献分享')
  sections.push('下一步计划')
  slides.push({ kind: 'agenda', sections })

  if (include.progress) {
    const bullets: DeckBullet[] = [
      { text: `当前阶段：${STAGE_LABELS[project.stage]}`, emph: true },
      { text: `文献库 ${String(input.paperCount)} 篇 · 实验 ${String(input.experiments.length)} 次 · 图表 ${String(input.figures.length)} 张` },
      ...(project.venue === undefined ? [] : [{ text: `目标会议：${project.venue.name}` }]),
      { text: `最近更新：${dateOnly(project.updatedAt)}` },
    ]
    slides.push({ kind: 'bullets', heading: '项目进展', bullets })
  }

  if (include.experiments && input.experiments.length > 0) {
    const bullets: DeckBullet[] = input.experiments.slice(0, 8).map(record => ({
      text: `${record.name}（${record.status === 'success' ? '成功' : record.status === 'running' ? '运行中' : '失败'}）`
        + (metricsLineOf(record) === '' ? '' : ` — ${metricsLineOf(record)}`),
    }))
    if (input.experiments.length > 8) {
      bullets.push({ text: `…以及另外 ${String(input.experiments.length - 8)} 次实验` })
    }
    slides.push({ kind: 'bullets', heading: '实验结果', bullets })
  }

  if (include.figures) {
    for (const figure of input.figures) {
      slides.push({
        kind: 'figure',
        kicker: '图表',
        heading: figure.record.relPath.replace(/^figures\//, '').replace(/\.[^.]+$/, ''),
        imagePath: figure.imagePath,
        caption: figure.record.caption,
      })
    }
  }

  if (include.papers) {
    for (const paper of input.papers) {
      const verdict = paper.relevance?.[project.id]
      const bullets: DeckBullet[] = []
      if (paper.authors.length > 0) {
        bullets.push({ text: paper.authors.slice(0, 3).join(', ') + (paper.authors.length > 3 ? ' et al.' : '') })
      }
      if (verdict !== undefined) {
        bullets.push({ text: `相关度 ${String(verdict.score)}/10 — ${verdict.reason}`, emph: true })
      }
      if (paper.notes !== '') bullets.push({ text: `笔记：${paper.notes}` })
      if (paper.tags.length > 0) bullets.push({ text: `标签：${paper.tags.join(' / ')}` })
      slides.push({
        kind: 'bullets',
        kicker: '文献分享',
        heading: paper.title,
        bullets: bullets.length > 0 ? bullets : [{ text: paper.summary.slice(0, 200) }],
        imagePath: input.paperArt?.[paper.arxivId],
      })
      // 逐图 slides: extracted figure crops follow the paper's intro slide,
      // one figure per slide with its takeaway caption (the house layout).
      for (const asset of input.paperFigures[paper.arxivId] ?? []) {
        slides.push({
          kind: 'figure',
          kicker: paper.title,
          heading: asset.label,
          imagePath: asset.imagePath,
          caption: asset.caption,
        })
      }
    }
  }

  slides.push({ kind: 'closing' })
  return Object.freeze(slides)
}

/* ── pptxgenjs render shell ─────────────────────────────────────────────── */

/* pptxgenjs 4's bundled d.ts (`export as namespace` + `export default`) does
 * not yield a constructable type under nodenext, so renderDeck casts the
 * dynamic import once onto this narrow structural surface — exactly the
 * members the render shell below uses. */

/** Loose option bag — pptxgenjs accepts far more keys than we pass. */
type PptxOptions = Record<string, unknown>

/** One text run inside a rich-text paragraph. */
interface PptxTextRun {
  readonly text: string
  readonly options?: PptxOptions
}

/** The slide surface the render shell draws on. */
interface PptxSlideSurface {
  addText(text: string | readonly PptxTextRun[], options: PptxOptions): void
  addShape(name: 'rect' | 'line', options: PptxOptions): void
  addImage(options: PptxOptions): void
}

/** The deck surface the render shell drives. */
interface PptxDeck {
  layout: string
  defineLayout(layout: { readonly name: string; readonly width: number; readonly height: number }): void
  addSlide(): PptxSlideSurface
  writeFile(options: { readonly fileName: string }): Promise<void>
}

/** Constructor signature of the pptxgenjs default export. */
type PptxDeckCtor = new () => PptxDeck

/** 16:9 canvas metrics (inches). */
const PAGE = { width: 10, height: 5.625 } as const
const ACCENT = '4F7CFF'
const INK = '17233D'
const MUTED = '64748B'
const BG = 'F7F9FC'
const CARD = 'FFFFFF'
const CARD_LINE = 'E2E8F0'

/**
 * Render one slide plan to a pptx file via pptxgenjs. House style: light
 * canvas, accent kicker + divider on content slides, images inside bordered
 * cards, and a footer carrying the deck title + page number.
 * @param slides - the plan from {@link buildDeckModel}.
 * @param outPath - absolute target path (parent must exist).
 * @param meta - footer metadata (deck title).
 * @returns resolution after the file is written.
 */
export async function renderDeck(
  slides: readonly DeckSlide[],
  outPath: string,
  meta: { readonly title?: string | undefined } = {},
): Promise<void> {
  const { default: PptxGenJS } = (await import('pptxgenjs')) as unknown as { default: PptxDeckCtor }
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'W16x9', width: PAGE.width, height: PAGE.height })
  pptx.layout = 'W16x9'

  const footer = (page: PptxSlideSurface, index: number) => {
    if (meta.title !== undefined && meta.title !== '') {
      page.addText(meta.title, { x: 0.6, y: PAGE.height - 0.32, w: 6, h: 0.25, fontFace: DECK_FONT, fontSize: 8, color: MUTED })
    }
    page.addText(`${String(index + 1)} / ${String(slides.length)}`, {
      x: PAGE.width - 1.4, y: PAGE.height - 0.32, w: 0.8, h: 0.25, fontFace: DECK_FONT, fontSize: 8, color: MUTED, align: 'right',
    })
  }
  /** Kicker + heading + accent divider shared by content slides. */
  const header = (page: PptxSlideSurface, kicker: string | undefined, heading: string) => {
    if (kicker !== undefined && kicker !== '') {
      page.addText(kicker, { x: 0.6, y: 0.24, w: PAGE.width - 1.2, h: 0.28, fontFace: DECK_FONT, fontSize: 10, bold: true, color: ACCENT, charSpacing: 2 })
    }
    page.addText(heading, {
      x: 0.6, y: 0.52, w: PAGE.width - 1.2, h: 0.6, fontFace: DECK_FONT, fontSize: 21, bold: true, color: INK,
    })
    page.addShape('line', { x: 0.6, y: 1.14, w: PAGE.width - 1.2, h: 0, line: { color: ACCENT, width: 1.5 } })
  }

  for (const [index, slide] of slides.entries()) {
    const page = pptx.addSlide()
    page.addShape('rect', { x: 0, y: 0, w: PAGE.width, h: PAGE.height, fill: { color: BG } })

    if (slide.kind === 'title') {
      page.addShape('rect', { x: 0, y: 0, w: 0.22, h: PAGE.height, fill: { color: ACCENT } })
      const hasArt = slide.imagePath !== undefined
      page.addText(slide.title, {
        x: 0.9, y: 1.5, w: hasArt ? 4.9 : PAGE.width - 1.8, h: 1.6, fontFace: DECK_FONT,
        fontSize: 30, bold: true, color: INK, align: hasArt ? 'left' : 'center', valign: 'middle',
      })
      page.addText(slide.subtitle, {
        x: 0.9, y: 3.25, w: hasArt ? 4.9 : PAGE.width - 1.8, h: 0.5, fontFace: DECK_FONT,
        fontSize: 13, color: MUTED, align: hasArt ? 'left' : 'center',
      })
      if (hasArt) {
        page.addShape('rect', { x: 6.0, y: 0.6, w: 3.6, h: 4.4, fill: { color: CARD }, line: { color: CARD_LINE, width: 1 } })
        page.addImage({ path: slide.imagePath!, x: 6.15, y: 0.75, w: 3.3, h: 4.1, sizing: { type: 'contain', w: 3.3, h: 4.1 } })
      }
      continue
    }
    if (slide.kind === 'agenda') {
      header(page, 'AGENDA', '目录')
      page.addText(
        slide.sections.flatMap((section, row) => [
          { text: `${String(row + 1).padStart(2, '0')}  `, options: { bold: true, color: ACCENT } },
          { text: section, options: { color: INK, breakLine: true } },
        ]),
        { x: 1.0, y: 1.5, w: 8, h: 3.5, fontFace: DECK_FONT, fontSize: 19, lineSpacing: 40, valign: 'top' },
      )
      footer(page, index)
      continue
    }
    if (slide.kind === 'bullets') {
      header(page, slide.kicker, slide.heading)
      const hasArt = slide.imagePath !== undefined
      page.addText(
        slide.bullets.map(bullet => ({
          text: bullet.text,
          options: { bullet: { code: '2022' }, bold: bullet.emph === true, color: bullet.emph === true ? ACCENT : INK, breakLine: true },
        })),
        { x: 0.8, y: 1.4, w: hasArt ? 5.3 : PAGE.width - 1.6, h: 3.7, fontFace: DECK_FONT, fontSize: 14, lineSpacing: 24, valign: 'top' },
      )
      if (hasArt) {
        page.addShape('rect', { x: 6.3, y: 1.4, w: 3.3, h: 3.7, fill: { color: CARD }, line: { color: CARD_LINE, width: 1 } })
        page.addImage({ path: slide.imagePath!, x: 6.45, y: 1.55, w: 3.0, h: 3.4, sizing: { type: 'contain', w: 3.0, h: 3.4 } })
      }
      footer(page, index)
      continue
    }
    if (slide.kind === 'figure') {
      header(page, slide.kicker, slide.heading)
      page.addShape('rect', { x: 0.6, y: 1.35, w: 5.9, h: 3.8, fill: { color: CARD }, line: { color: CARD_LINE, width: 1 } })
      page.addImage({ path: slide.imagePath, x: 0.78, y: 1.53, w: 5.54, h: 3.44, sizing: { type: 'contain', w: 5.54, h: 3.44 } })
      if (slide.caption !== '') {
        page.addShape('rect', { x: 6.8, y: 1.42, w: 0.05, h: 0.5, fill: { color: ACCENT } })
        page.addText(slide.caption, {
          x: 6.98, y: 1.35, w: 2.6, h: 3.8, fontFace: DECK_FONT, fontSize: 12.5, color: INK, valign: 'top', lineSpacing: 20,
        })
      }
      footer(page, index)
      continue
    }
    // closing
    page.addShape('rect', { x: 0, y: 0, w: 0.22, h: PAGE.height, fill: { color: ACCENT } })
    page.addText('下一步计划', { x: 0.9, y: 1.8, w: PAGE.width - 1.8, h: 0.8, fontFace: DECK_FONT, fontSize: 26, bold: true, color: INK, align: 'center' })
    page.addText('（现场讨论填充）', { x: 0.9, y: 2.8, w: PAGE.width - 1.8, h: 0.5, fontFace: DECK_FONT, fontSize: 14, color: MUTED, align: 'center' })
  }

  await pptx.writeFile({ fileName: outPath })
}

/* ── gathering + Remote-facing verbs ────────────────────────────────────── */

/** The generate request's shape. */
export interface GenerateMeetingRequest {
  readonly projectId: string
  readonly title?: string | undefined
  readonly presenter?: string | undefined
  readonly date?: string | undefined
  /** Selected library papers; absent = the project's associated papers, relevance-sorted. */
  readonly paperIds?: readonly string[] | undefined
  /** Selected figure relPaths; absent = every figure with a raster sibling. */
  readonly figureRelPaths?: readonly string[] | undefined
  readonly include?: Partial<MeetingInclude> | undefined
  /** Embed AI-generated illustrations (cover + per-paper concept art); needs a configured image-gen API. */
  readonly aiIllustrations?: boolean | undefined
}

/** Raster extensions a deck can embed (pptxgenjs has no svg-by-path). */
const DECK_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])

/** Injectable seams of {@link generateMeetingDeck}; absent outside tests. */
export interface MeetingDeps {
  /**
   * PDF warm-up run before extraction when the paper has no cached PDF;
   * defaults to the library's arXiv fetch (tests inject a no-op).
   */
  readonly fetchPdf?: (arxivId: string) => Promise<unknown>
}

/** Filesystem-safe slug of a display name, falling back to the project id. */
function slugOf(title: string, fallback: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return slug === '' ? fallback.slice(0, 8) : slug
}

/**
 * Load one paper's extracted figure crops, when an extraction pass ran (the
 * research-meeting-deck skill's script writes `manifest.json` plus png crops
 * here). A missing/invalid manifest reads as none; entries whose file is
 * gone are dropped. Capped at {@link DECK_MAX_PAPER_FIGURES}.
 * @param workspaceDir - research workspace root.
 * @param arxivId - the paper's bare arXiv id (the manifest folder name).
 * @returns the paper's deck-ready figure assets, possibly empty.
 */
export async function loadPaperFigures(
  workspaceDir: string,
  arxivId: string,
): Promise<readonly PaperFigureAsset[]> {
  // An unsafe id never reaches a path join; the read fails open.
  if (!isValidArxivId(arxivId)) return []
  const dir = join(workspaceDir, MEETINGS_DIR_NAME, PAPER_FIGURES_DIR_NAME, arxivId)
  let raw: string
  try {
    raw = await readFile(join(dir, 'manifest.json'), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const assets: PaperFigureAsset[] = []
  for (const entry of parsed as readonly { file?: unknown; label?: unknown; caption?: unknown }[]) {
    const file = basename(typeof entry?.file === 'string' ? entry.file : '')
    if (file === '' || extname(file).toLowerCase() !== '.png') continue
    const imagePath = join(dir, file)
    const stats = await stat(imagePath).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) continue
    assets.push({
      imagePath,
      label: typeof entry.label === 'string' && entry.label !== ''
        ? entry.label
        : file.replace(/\.png$/, ''),
      caption: typeof entry.caption === 'string' ? entry.caption : '',
    })
    if (assets.length >= DECK_MAX_PAPER_FIGURES) break
  }
  return Object.freeze(assets)
}

/**
 * Generate one project's meeting deck. Gathers the selected (or default)
 * papers/experiments/figures, plans the slides, renders the pptx into
 * `meetings/<projectId>/`, and returns the file name plus the slide count.
 * An unknown project is `project-not-found`.
 * @param deps - workspace root and open domain.
 * @param request - the deck options.
 * @param signal - caller cancellation; aborts figure extraction and stops the
 * deck promptly (a cancelled generation rejects instead of returning).
 * @returns the produced file.
 */
export async function generateMeetingDeck(
  deps: WikiAdminDeps & { readonly workspaceDir: string; readonly meetings?: MeetingDeps },
  request: GenerateMeetingRequest,
  signal?: AbortSignal,
): Promise<ResearchGenerateMeetingResult> {
  const project = deps.domain.table('projects').get(request.projectId)
  if (project === undefined) return rejected({ code: 'project-not-found', projectId: request.projectId })
  // Checked before any work: this is the site that *creates*
  // `meetings/<projectId>/`, so an unsafe id here would mkdir outside the
  // workspace rather than merely read outside it.
  if (!isValidProjectId(project.id)) {
    return rejected({ code: 'invalid-path', path: project.id })
  }
  const include: MeetingInclude = { ...DEFAULT_INCLUDE, ...(request.include ?? {}) }

  const allPapers = [...deps.domain.table('papers').entries()].map(([, record]) => record)
  const associated = allPapers.filter(paper => paper.projectIds.includes(project.id))
  const papers = (request.paperIds === undefined
    ? associated
      .sort((left, right) => (right.relevance?.[project.id]?.score ?? -1) - (left.relevance?.[project.id]?.score ?? -1))
    : request.paperIds
      .map(id => allPapers.find(paper => paper.arxivId === id))
      .filter((paper): paper is PaperRecord => paper !== undefined)
  ).slice(0, DECK_MAX_PAPERS)

  const experiments = [...deps.domain.table('experiments').entries()]
    .map(([, record]) => record)
    .filter(record => record.projectId === project.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

  const dir = resolvePaperDir(deps.workspaceDir, undefined, project.paperDir)
  const figures: MeetingFigureInput[] = []
  if (dir !== undefined) {
    // Scan the paper directory (not just the metadata table): figures dropped
    // in through the upload route have no table row, and a deck that silently
    // drops them reads as broken. Captions merge from the table when a row
    // exists (any sibling of the stem may carry it).
    const meta = deps.domain.table('figures')
    const scanned = (await listPaperFigures(dir))
      .filter(entry => request.figureRelPaths === undefined || request.figureRelPaths.includes(entry.relPath))
    // Group by stem: embed the raster sibling, skip svg-only files.
    const byStem = new Map<string, FigureFile[]>()
    for (const entry of scanned) {
      const stem = entry.relPath.replace(/\.[^.]+$/, '')
      const group = byStem.get(stem) ?? []
      group.push(entry)
      byStem.set(stem, group)
    }
    for (const group of byStem.values()) {
      const raster = group.find(entry => DECK_IMAGE_EXTENSIONS.has(extname(entry.relPath).toLowerCase()))
      if (raster === undefined) continue
      const caption = group
        .map(entry => meta.get(`${project.id}:${entry.relPath}`)?.caption ?? '')
        .find(text => text !== '') ?? ''
      figures.push({
        record: Object.freeze({
          id: `${project.id}:${raster.relPath}`,
          projectId: project.id,
          relPath: raster.relPath,
          caption,
          createdAt: new Date(raster.mtimeMs).toISOString(),
        }),
        imagePath: join(dir, raster.relPath),
      })
      if (figures.length >= DECK_MAX_FIGURES) break
    }
  }

  const date = request.date?.trim() || localToday(new Date())
  const title = request.title?.trim() || `${project.title} · 组会汇报`

  // 逐图 assets of the selected papers: reuse an existing manifest, else
  // extract from the paper's PDF on first use — fetching the PDF from arXiv
  // first when it was never cached (best-effort all the way down: no PDF or
  // no extractor just means no figure slides).
  const paperFigures: Record<string, readonly PaperFigureAsset[]> = {}
  if (include.papers) {
    const warmPdf = deps.meetings?.fetchPdf
      ?? (async (arxivId: string) => { await fetchPaperPdf(deps, { arxivId }) })
    for (const paper of papers) {
      signal?.throwIfAborted()
      if ((await resolvePaperPdf(deps.workspaceDir, paper.arxivId)) === undefined) {
        await warmPdf(paper.arxivId).catch(() => undefined)
      }
      const assets = await extractPaperFigures(deps.workspaceDir, paper.arxivId, { ...(signal === undefined ? {} : { signal }) })
      if (assets.length > 0) paperFigures[paper.arxivId] = assets
    }
  }

  // AI illustrations (opt-in): one cover image plus one concept art per
  // selected paper, filed under figures/ai-deck/ so the Figures tab manages
  // them. Every generation failure skips that one image — never the deck.
  let coverArt: string | undefined
  const paperArt: Record<string, string> = {}
  let illustrations = 0
  if (request.aiIllustrations === true && dir !== undefined) {
    const imageGen = await readImageGenConfig(deps.workspaceDir)
    if (imageGen.apiKey !== '') {
      const paperDir = project.paperDir ?? 'paper'
      const illustrate = async (stem: string, caption: string, prompt: string): Promise<string | undefined> => {
        try {
          const image = await generateImage(imageGen, prompt)
          const relPath = await saveDeckIllustration(deps, project.id, paperDir, stem, caption, image)
          illustrations += 1
          return join(deps.workspaceDir, paperDir, relPath)
        } catch {
          return undefined
        }
      }
      coverArt = await illustrate('cover', 'AI 配图 · 组会封面', coverPrompt(project.title))
      if (include.papers) {
        for (const paper of papers.slice(0, IMAGE_GEN_MAX_PER_DECK - 1)) {
          const stem = `paper-${paper.arxivId.replace(/[^a-z0-9]+/gi, '-')}`
          const art = await illustrate(stem, `AI 配图 · ${paper.title}`, paperArtPrompt(paper.title, paper.summary))
          if (art !== undefined) paperArt[paper.arxivId] = art
        }
      }
    }
  }

  const slides = buildDeckModel({
    project, title, date, presenter: request.presenter, paperCount: associated.length, papers, paperFigures, coverArt, paperArt, experiments, figures, include,
  })

  const meetingsDir = join(deps.workspaceDir, MEETINGS_DIR_NAME, project.id)
  await mkdir(meetingsDir, { recursive: true })
  const file = `${slugOf(title, project.id)}-${date.replace(/[^0-9]/g, '')}.pptx`
  await renderDeck(slides, join(meetingsDir, file), { title })
  return success({ file, slides: slides.length, illustrations })
}

/**
 * List one project's generated decks, newest first.
 * An unknown project is `project-not-found`; a missing directory is an
 * empty list (nothing generated yet).
 */
export async function listMeetingDecks(
  deps: WikiAdminDeps & { readonly workspaceDir: string },
  request: { readonly projectId: string },
): Promise<ResearchMeetingDecksResult> {
  const project = deps.domain.table('projects').get(request.projectId)
  if (project === undefined) return rejected({ code: 'project-not-found', projectId: request.projectId })
  // The stored id is unconstrained `z.string()`, so it is checked here rather
  // than trusted: an imported snapshot predating the import guard could still
  // hold `../../x`, and this joins it into a filesystem path.
  if (!isValidProjectId(project.id)) {
    return rejected({ code: 'invalid-path', path: project.id })
  }
  const meetingsDir = join(deps.workspaceDir, MEETINGS_DIR_NAME, project.id)
  let names: string[]
  try {
    names = (await readdir(meetingsDir)).filter(name => extname(name).toLowerCase() === '.pptx')
  } catch {
    names = []
  }
  const decks = []
  for (const name of names) {
    const stats = await stat(join(meetingsDir, name))
    decks.push(Object.freeze({ file: name, sizeBytes: stats.size, updatedAt: stats.mtime.toISOString() }))
  }
  decks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return success({ decks: Object.freeze(decks) })
}

/**
 * Delete one generated deck. The file name is reduced to its basename and
 * must be a .pptx, so no traversal is expressible.
 */
export async function deleteMeetingDeck(
  deps: WikiAdminDeps & { readonly workspaceDir: string },
  request: { readonly projectId: string; readonly file: string },
): Promise<ResearchDeleteMeetingDeckResult> {
  const project = deps.domain.table('projects').get(request.projectId)
  if (project === undefined) return rejected({ code: 'project-not-found', projectId: request.projectId })
  const file = basename(request.file)
  if (file === '' || extname(file).toLowerCase() !== '.pptx') {
    return rejected({ code: 'invalid-input', message: 'file must name a .pptx deck' })
  }
  if (!isValidProjectId(project.id)) {
    return rejected({ code: 'invalid-path', path: project.id })
  }
  try {
    await unlink(join(deps.workspaceDir, MEETINGS_DIR_NAME, project.id, file))
  } catch {
    return rejected({ code: 'invalid-path', path: file })
  }
  return success({ file })
}

/** Used by the download route: resolve one deck's absolute path, confined to the meetings dir. */
export function meetingDeckPath(
  workspaceDir: string,
  projectId: string,
  file: string,
): string | undefined {
  // `file` is already reduced to a basename below; `projectId` was not
  // checked at all, and it is the other half of the same path.
  if (!isValidProjectId(projectId)) return undefined
  const name = basename(file)
  if (name === '' || extname(name).toLowerCase() !== '.pptx') return undefined
  return join(workspaceDir, MEETINGS_DIR_NAME, projectId, name)
}
