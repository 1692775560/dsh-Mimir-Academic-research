/**
 * Shared presentational helpers for the research workbench views: the stage
 * label map, failure-copy translation, byte-size and run-duration formatting,
 * the figure route
 * URL builder, the experiments comparison-chart helpers (numeric metric
 * keys, chart rows, bar widths, value formatting), the library tag
 * collection/filter helpers, the server probe stage inference
 * ({@link probeStageOf}), and the figure-upload drop filter
 * ({@link filterDropFiles}). No JSX, no subscriptions.
 * @module dsh-client-ui-mimir/client/view-common
 */

import type { BibEntry, ExperimentRecord, ExperimentStatus, MetricDirection, OutlineNode, PaperRecord, ProjectStage, SectionMove, SectionOutlineTitles, ServerRecord, SubsectionMove } from 'dsh-mimir/types'
import type { ResearchFailureView, ResearchSaveState } from './controller.ts'
import type { ResearchKey } from './locales.ts'

/** The `t` function shape every view receives from the panel. */
export type ResearchT = (key: ResearchKey, params?: Record<string, unknown>) => string

/** Locale key of one autosave state label (the editor's and the bib panel's pill). */
export const SAVE_KEYS: Record<ResearchSaveState, ResearchKey> = {
  clean: 'save.saved',
  dirty: 'save.dirty',
  saving: 'save.saving',
  saved: 'save.saved',
  conflict: 'save.conflict',
  'save-error': 'save.error',
}

/** Locale key of one pipeline stage label. */
export const STAGE_KEYS: Record<ProjectStage, ResearchKey> = {
  idea: 'stage.idea',
  plan: 'stage.plan',
  experiment: 'stage.experiment',
  writing: 'stage.writing',
  done: 'stage.done',
}

/** Pipeline stages in order (the overview progress bar). */
export const STAGES: readonly ProjectStage[] = ['idea', 'plan', 'experiment', 'writing', 'done']

/**
 * Locale key of one host failure code. Codes absent here carry a
 * context-bearing `message` from the host (the offending path, the parse
 * detail); those fall through to that message rather than losing it behind a
 * generic line.
 */
export const FAILURE_CODE_KEYS: Record<string, ResearchKey> = {
  'invalid-dir': 'error.invalidDir',
  'project-not-found': 'error.code.projectNotFound',
  'paper-not-found': 'error.code.paperNotFound',
  'experiment-not-found': 'error.code.experimentNotFound',
  'figure-not-found': 'error.code.figureNotFound',
  'artifact-not-found': 'error.code.artifactNotFound',
  'bib-not-found': 'error.code.bibNotFound',
  'job-not-found': 'error.code.jobNotFound',
  'server-not-found': 'error.code.serverNotFound',
  'snapshot-not-found': 'error.code.snapshotNotFound',
  'subscription-not-found': 'error.code.subscriptionNotFound',
  'section-not-found': 'error.code.sectionNotFound',
  'subsection-not-found': 'error.code.subsectionNotFound',
  'conflict': 'error.code.conflict',
  'invalid-artifact': 'error.code.invalidArtifact',
  'invalid-content': 'error.code.invalidContent',
  'invalid-name': 'error.code.invalidName',
  'invalid-path': 'error.code.invalidPath',
}

/**
 * Localized copy for one failure: a mapped code renders its dedicated string,
 * an unmapped one falls back to the host message, and a code that arrives
 * with neither (an unmapped code whose message is empty) renders the generic
 * line so the UI never shows an empty error.
 */
export function failureCopy(t: ResearchT, failure: ResearchFailureView | null): string {
  if (failure === null) return ''
  const key = FAILURE_CODE_KEYS[failure.code]
  if (key !== undefined) return t(key)
  return failure.message === '' ? t('error.code.unknown') : failure.message
}

/** Human-readable byte size (B/KB/MB, one decimal above 1 KB). */
export function formatSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Character range of one 1-based line in one text (the issue/outline
 * click-to-jump selection). Offsets count newlines; the last line runs to the
 * text's end. Returns null for a line past the end or below 1.
 */
export function lineRangeOf(text: string, line: number): { readonly start: number; readonly end: number } | null {
  if (line < 1) return null
  let start = 0
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf('\n', start)
    if (next === -1) return null
    start = next + 1
  }
  const newline = text.indexOf('\n', start)
  return { start, end: newline === -1 ? text.length : newline }
}

/** Localized relative timestamp (e.g. a probe's checkedAt), coarse-grained. */
export function relativeTime(t: ResearchT, iso: string): string {
  const elapsedMs = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return t('time.justNow')
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 60) return `${minutes} ${t('time.minutesAgo')}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${t('time.hoursAgo')}`
  return `${Math.floor(hours / 24)} ${t('time.daysAgo')}`
}

/** Human-readable run duration (a job's wall-clock time): `900ms`, `12.3s`, `3.2min`. */
export function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return ''
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${(seconds / 60).toFixed(1)}min`
}

/**
 * Build the figure route URL for one file of one project's paper directory.
 * The record's `paperDir` rides along as `?dir=`, same convention as the
 * PDF preview URL.
 */
export function figureUrl(projectId: string, relPath: string, dir: string | undefined): string {
  return `/research/figure/${encodeURIComponent(projectId)}?path=${encodeURIComponent(relPath)}`
    + (dir === undefined ? '' : `&dir=${encodeURIComponent(dir)}`)
}

/**
 * Build the meeting-deck download URL for one generated pptx. The route
 * answers with `Content-Disposition: attachment`, so an `<a href>` download
 * works without an RPC round-trip.
 */
export function meetingDeckUrl(projectId: string, file: string): string {
  return `/research/meeting?project=${encodeURIComponent(projectId)}&file=${encodeURIComponent(file)}`
}

/** One run's row in one metric's comparison chart. */
export interface MetricChartRow {
  readonly id: string
  readonly name: string
  readonly status: ExperimentStatus
  readonly value: number
}

/**
 * Metric keys shared as finite numbers by at least two experiments — the keys
 * worth a comparison chart (a key only one run carries has nothing to compare
 * against). Sorted alphabetically so the chart grid is stable across renders.
 */
export function numericMetricKeys(experiments: readonly ExperimentRecord[]): string[] {
  const counts = new Map<string, number>()
  for (const record of experiments) {
    for (const [key, value] of Object.entries(record.metrics)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([key]) => key)
    .sort()
}

/**
 * Rows of one metric's comparison chart: every run carrying a finite number
 * for the key, oldest first (updatedAt order) so the bars read as a trend.
 */
export function metricChartRows(experiments: readonly ExperimentRecord[], key: string): MetricChartRow[] {
  const rows: Array<{ readonly record: ExperimentRecord; readonly value: number }> = []
  for (const record of experiments) {
    const value = record.metrics[key]
    if (typeof value === 'number' && Number.isFinite(value)) rows.push({ record, value })
  }
  rows.sort((left, right) => left.record.updatedAt.localeCompare(right.record.updatedAt))
  return rows.map(({ record, value }) => ({
    id: record.id,
    name: record.name,
    status: record.status,
    value,
  }))
}

/** One bar's geometry in a zero-baseline chart: percentages of the bar lane. */
export interface BarSpan {
  /** Left edge of the bar (0–100). */
  readonly leftPct: number
  /** Width of the bar (0–100). */
  readonly widthPct: number
  /** True for a negative value: the bar extends LEFT of the zero line. */
  readonly negative: boolean
}

/**
 * Bar geometry (percentages) for one chart's values on a ZERO baseline
 * (#220): the lane spans [min(0, values), max(0, values)], so negative bars
 * extend left of the zero line and positive bars right. An all-zero chart
 * yields zero-width bars. Both the panel chart and the exported SVG figure
 * consume this one rule, so they can never disagree.
 */
export function barSpans(values: readonly number[]): BarSpan[] {
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const span = hi - lo
  if (span <= 0) return values.map(() => ({ leftPct: 0, widthPct: 0, negative: false }))
  return values.map(value => ({
    leftPct: ((Math.min(value, 0) - lo) / span) * 100,
    widthPct: (Math.abs(value) / span) * 100,
    negative: value < 0,
  }))
}

/**
 * Zero-line position (percent of the bar lane) for one chart's values, or
 * null when every value is non-negative (the lane's left edge IS the zero
 * line, which both renderers already draw).
 */
export function zeroLinePct(values: readonly number[]): number | null {
  if (!values.some(value => value < 0)) return null
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const span = hi - lo
  return span <= 0 ? null : ((0 - lo) / span) * 100
}

/**
 * Index of a chart's best run under the metric's direction (#220): the
 * smallest value for `min`, the largest for `max`, and null for `none`
 * (unordered metric — no best exists). Ties keep the earliest row.
 */
export function bestRowIndex(rows: readonly MetricChartRow[], direction: MetricDirection): number | null {
  if (direction === 'none' || rows.length === 0) return null
  let best = 0
  rows.forEach((row, index) => {
    const top = rows[best]
    if (top !== undefined && (direction === 'min' ? row.value < top.value : row.value > top.value)) best = index
  })
  return best
}

/**
 * Per-metric directions merged across one project's experiments (#220):
 * later-updated records win, so the newest run's form edits govern the
 * chart. Records predating the field contribute nothing.
 */
export function metricDirectionsOf(experiments: readonly ExperimentRecord[]): Record<string, MetricDirection> {
  const directions: Record<string, MetricDirection> = {}
  const sorted = [...experiments].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
  for (const record of sorted) {
    for (const [key, direction] of Object.entries(record.metricDirections ?? {})) {
      directions[key] = direction
    }
  }
  return directions
}

/**
 * Visual-width budget of one chart-label line, in half-width units (a CJK or
 * fullwidth glyph counts double). Tuned so a full line stays inside the SVG
 * label lane at the 11px label size.
 */
const CHART_LABEL_LINE_UNITS = 22

/** Half-width-unit width of one code point: CJK/fullwidth glyphs count double. */
function charUnits(char: string): number {
  return /[⺀-鿿豈-﫿＀-￯]/.test(char) ? 2 : 1
}

/**
 * One run name wrapped to at most two chart-label lines so the bar charts stay
 * readable without ellipsizing mid-word. The wrap budget is in half-width
 * units (see {@link CHART_LABEL_LINE_UNITS}); the first line fills greedily
 * and breaks at the last colon or space inside the budget, and a name still
 * too long ellipsizes its second line (the full name rides the SVG `<title>`).
 */
export function chartNameLines(name: string): readonly [string] | readonly [string, string] {
  const chars = [...name]
  const unitsOf = (list: readonly string[]): number =>
    list.reduce((sum, char) => sum + charUnits(char), 0)
  if (unitsOf(chars) <= CHART_LABEL_LINE_UNITS) return [name]
  let units = 0
  let cut = 0
  let boundary = -1
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? ''
    const next = units + charUnits(char)
    if (next > CHART_LABEL_LINE_UNITS) break
    units = next
    cut = index + 1
    if (char === '：' || char === ':' || char === ' ') boundary = index + 1
  }
  const first = (boundary > 0 ? chars.slice(0, boundary) : chars.slice(0, cut)).join('').trimEnd()
  const restText = chars.slice(boundary > 0 ? boundary : cut).join('').trimEnd()
  let tail = [...restText]
  while (tail.length > 0 && unitsOf(tail) + 1 > CHART_LABEL_LINE_UNITS) tail = tail.slice(0, -1)
  const trimmed = tail.join('').trimEnd()
  return [first, trimmed === restText ? restText : `${trimmed}…`]
}

/**
 * Compact display form of one metric value: strings pass through, integers
 * print as-is, other numbers keep at most four significant digits.
 */
export function formatMetricValue(value: number | string): string {
  if (typeof value === 'string') return value
  if (!Number.isFinite(value) || Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(4)))
}

/**
 * Bibliography fields the bib panel edits through dedicated form inputs, in
 * display order; every other field of the entry rides the raw name/value rows.
 */
export const COMMON_BIB_FIELDS = [
  'title', 'author', 'year', 'journal', 'booktitle', 'eprint', 'archiveprefix', 'url', 'note',
] as const

/** One raw name/value field row of the bib entry editor. */
export interface BibFieldDraft {
  name: string
  value: string
}

/** The bib entry editor's draft: citation key, entry type, the common-field inputs, and the raw rows. */
export interface BibEntryDraft {
  key: string
  type: string
  /** Common-field input values keyed by field name (absent names read as ''). */
  common: Record<string, string>
  extra: BibFieldDraft[]
}

/** Open the editor on one entry: common fields into their inputs, the rest as raw rows. */
export function bibDraftFromEntry(entry: BibEntry): BibEntryDraft {
  const common: Record<string, string> = {}
  const extra: BibFieldDraft[] = []
  for (const [name, value] of Object.entries(entry.fields)) {
    if ((COMMON_BIB_FIELDS as readonly string[]).includes(name)) common[name] = value
    else extra.push({ name, value })
  }
  return { key: entry.key, type: entry.type, common, extra }
}

/**
 * Assemble the entry one draft saves to: key and type trimmed (an empty key
 * or type rejects with null — the panel shows its own validation copy), empty
 * common inputs dropped, empty-name or empty-value raw rows dropped, raw row
 * names lowercased, and a raw row naming a common field overriding the form
 * input (last write wins, matching the parser's field-merge rule).
 */
export function bibEntryFromDraft(draft: BibEntryDraft): BibEntry | null {
  const key = draft.key.trim()
  const type = draft.type.trim().toLowerCase()
  if (key === '' || type === '') return null
  const fields: Record<string, string> = {}
  for (const name of COMMON_BIB_FIELDS) {
    const value = (draft.common[name] ?? '').trim()
    if (value !== '') fields[name] = value
  }
  for (const row of draft.extra) {
    const name = row.name.trim().toLowerCase()
    const value = row.value.trim()
    if (name === '' || value === '') continue
    fields[name] = value
  }
  return { key, type, fields }
}

/**
 * Build the paper-PDF route URL of one remembered paper (the library card's
 * embedded reader). `version` cache-busts a refetch: the route serves the
 * same path after every fetch, and the no-cache reply alone does not force an
 * already-open iframe to re-request.
 */
export function paperPdfUrl(arxivId: string, version: number): string {
  return `/research/paper-pdf/${encodeURIComponent(arxivId)}?v=${version}`
}

/**
 * One-line summary of one bibliography entry (the bib panel's row): the
 * title when present, else the author/year pair, else the entry type.
 * Whitespace runs collapse; the result truncates at 80 characters.
 */
export function bibSummaryOf(entry: BibEntry): string {
  const title = entry.fields['title']?.replace(/\s+/g, ' ').trim()
  if (title !== undefined && title !== '') {
    return title.length > 80 ? `${title.slice(0, 80)}…` : title
  }
  const fallback = [entry.fields['author']?.trim(), entry.fields['year']?.trim()]
    .filter(part => part !== undefined && part !== '')
    .join(' · ')
  return fallback === '' ? entry.type : fallback
}

/**
 * Translate one outline drop into a section move. `insertAt` is the insertion
 * indicator's index in the CURRENT top-level order (0..titles.length); the
 * move's `targetIndex` addresses the order after the dragged section is
 * removed. Returns null for a no-op drop (back onto its own slot) or an
 * unknown title.
 */
export function sectionMoveFromDrop(
  titles: readonly string[],
  title: string,
  insertAt: number,
): SectionMove | null {
  const from = titles.indexOf(title)
  if (from === -1) return null
  const clamped = Math.min(Math.max(insertAt, 0), titles.length)
  const target = clamped > from ? clamped - 1 : clamped
  return target === from ? null : { title, targetIndex: target }
}

/**
 * The conflict-check snapshot of one parsed outline: the top-level section
 * titles plus each section's direct child titles, in document order. This is
 * the `baseOutline` a subsection reorder commits against.
 */
export function outlineSectionTitles(nodes: readonly OutlineNode[]): SectionOutlineTitles[] {
  return nodes
    .filter(node => node.level === 1)
    .map(node => ({ title: node.title, subsections: node.children.map(child => child.title) }))
}

/** The dragged subsection of one drop: its current section title and its own title. */
export interface SubsectionDrag {
  readonly sectionTitle: string
  readonly title: string
}

/**
 * Translate one subsection drop into a subsection move. `insertAt` is the
 * insertion indicator's index in the CURRENT subsection order of the target
 * section (0..count); for a same-section drop the move's `targetIndex`
 * addresses the order after the dragged subsection is removed, mirroring
 * {@link sectionMoveFromDrop}. Returns null for a no-op drop (back onto its
 * own slot) or an unknown section/subsection.
 */
export function subsectionMoveFromDrop(
  nodes: readonly OutlineNode[],
  drag: SubsectionDrag,
  targetSectionTitle: string,
  insertAt: number,
): SubsectionMove | null {
  const sections = nodes.filter(node => node.level === 1)
  const source = sections.find(node => node.title === drag.sectionTitle)
  const target = sections.find(node => node.title === targetSectionTitle)
  if (source === undefined || target === undefined) return null
  const from = source.children.findIndex(child => child.title === drag.title)
  if (from === -1) return null
  const same = source === target
  const clamped = Math.min(Math.max(insertAt, 0), target.children.length)
  const targetIndex = same && clamped > from ? clamped - 1 : clamped
  if (same && targetIndex === from) return null
  return { sectionTitle: drag.sectionTitle, title: drag.title, targetSectionTitle, targetIndex }
}

/** All tags across the library, deduped and alphabetically sorted (the filter bar). */
export function collectTags(papers: readonly PaperRecord[]): string[] {
  const tags = new Set<string>()
  for (const paper of papers) for (const tag of paper.tags) tags.add(tag)
  return [...tags].sort()
}

/** All tags across the server list, deduped and alphabetically sorted (the filter bar). */
export function collectServerTags(servers: readonly ServerRecord[]): string[] {
  const tags = new Set<string>()
  for (const server of servers) for (const tag of server.tags) tags.add(tag)
  return [...tags].sort()
}

/** One stage of the server probe pipeline (mirrors `ServerProbeStage` of dsh-mimir). */
export type ProbeStage = 'tcp' | 'ssh' | 'gpu'

/** End of the TCP stage's time window in ms (the host's TCP probe timeout). */
export const PROBE_TCP_WINDOW_MS = 4000
/**
 * End of the SSH stage's time window in ms: the TCP budget plus the ssh
 * connect timeout (4s + 5s). Past this the probe is reading the GPU table.
 */
export const PROBE_SSH_WINDOW_MS = 9000

/**
 * The probe stage the panel should DISPLAY after `elapsedMs` of an in-flight
 * probe, derived from the host's per-stage timeouts (pure client-side
 * inference — the host only reports the stage once the probe settles).
 */
export function probeStageOf(elapsedMs: number): ProbeStage {
  if (elapsedMs < PROBE_TCP_WINDOW_MS) return 'tcp'
  if (elapsedMs < PROBE_SSH_WINDOW_MS) return 'ssh'
  return 'gpu'
}

/** Locale key of one in-flight probe stage's progress label. */
export const PROBE_STAGE_KEYS: Record<ProbeStage, ResearchKey> = {
  tcp: 'servers.probe.stage.tcp',
  ssh: 'servers.probe.stage.ssh',
  gpu: 'servers.probe.stage.gpu',
}

/** Locale key of one settled probe's per-stage failure label (the host's `stage`). */
export const PROBE_FAILURE_KEYS: Record<ProbeStage, ResearchKey> = {
  tcp: 'servers.probe.fail.tcp',
  ssh: 'servers.probe.fail.ssh',
  gpu: 'servers.probe.fail.gpu',
}

/** Filter the server list by one active tag; a null selector passes everything. */
export function filterServers(
  servers: readonly ServerRecord[],
  tag: string | null,
): ServerRecord[] {
  return servers.filter(server => tag === null || server.tags.includes(tag))
}

/**
 * Filter the library by one active tag and/or one linked project; a null
 * selector passes everything on its axis.
 */
export function filterPapers(
  papers: readonly PaperRecord[],
  tag: string | null,
  projectId: string | null,
): PaperRecord[] {
  return papers.filter(paper =>
    (tag === null || paper.tags.includes(tag))
    && (projectId === null || paper.projectIds.includes(projectId)))
}

/**
 * Extract a bare arXiv id from one web result URL: an `arxiv.org/abs/<id>`
 * (or `arxiv.org/pdf/<id>`) path, version suffix allowed. Returns null for
 * every other URL — the bridge that lets a web result import into the wiki.
 * @param url - the result URL, verbatim from the engine.
 */
export function arxivIdFromUrl(url: string): string | null {
  const match = /^https?:\/\/arxiv\.org\/(?:abs|pdf)\/([a-zA-Z0-9._/-]+?)(?:\.pdf)?$/i.exec(url)
  return match?.[1] ?? null
}

/** Extensions the figure upload accepts, shared by the file input and the drop filter. */
export const FIGURE_ACCEPT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg', '.pdf'] as const

/** The result of splitting dragged files by the accept list. */
export interface DropFileFilter<T> {
  readonly accepted: T[]
  readonly rejected: T[]
}

/**
 * Split dragged files into those matching the accept list (by extension,
 * case-insensitive) and those rejected, so the figures view uploads the
 * accepted ones and reports the rest instead of silently dropping them.
 * Generic over anything carrying a `name` so it stays DOM-free and testable.
 */
export function filterDropFiles<T extends { readonly name: string }>(
  files: readonly T[],
  accept: readonly string[],
): DropFileFilter<T> {
  const accepted: T[] = []
  const rejected: T[] = []
  for (const file of files) {
    const name = file.name.toLowerCase()
    const bucket = accept.some(ext => name.endsWith(ext)) ? accepted : rejected
    bucket.push(file)
  }
  return { accepted, rejected }
}
