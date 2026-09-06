/**
 * CCF conference-deadline domain logic: parsing the ccfddl/ccf-deadlines
 * aggregate YAML (`https://ccfddl.github.io/conference/allconf.yml`), the
 * `YYYY-MM-DD HH:mm:ss` + `UTC±H` instant math, per-series current-edition
 * selection, and the name/rank/field/time-window query fold. Everything here
 * is pure and DOM-free — the fetch/cache shell lives in
 * `./services/venue-deadlines.ts`, the panel presentation fold in ui-mimir's
 * `venues-view.ts`. Also carries the small static CCF-A journal directory
 * (ccfddl tracks conferences only).
 * @module dsh-mimir/src/venue-deadlines
 */

import { load as parseYaml } from 'js-yaml'

/** CCF rank letter, `N` = not ranked by CCF. */
export type CcfRank = 'A' | 'B' | 'C' | 'N'

/** One submission round of one conference edition. */
export interface VenueTimelineEntry {
  /** Raw `abstract_deadline` string, or null when the round has none. */
  readonly abstractDeadline: string | null
  /** Raw `deadline` string. */
  readonly deadline: string | null
  readonly comment: string | null
}

/** One edition (year) of a conference series. */
export interface VenueConf {
  readonly year: number
  /** ccfddl edition id, e.g. `cvpr26`. */
  readonly id: string
  readonly link: string
  readonly timeline: readonly VenueTimelineEntry[]
  /** ccfddl timezone string, e.g. `UTC-12`. */
  readonly timezone: string
  /** Human date range, e.g. `June 10-17, 2026`. */
  readonly date: string
  readonly place: string
}

/** One conference series (all its editions). */
export interface VenueSeries {
  /** Stable key: the lowercased title (`cvpr`). */
  readonly key: string
  readonly title: string
  readonly description: string
  /** ccfddl field code, e.g. `AI`, `DB`, `NW`. */
  readonly sub: string
  readonly ccfRank: CcfRank
  readonly dblp: string | null
  readonly confs: readonly VenueConf[]
}

/** Which deadline of an edition is next. */
export interface VenueNextDeadline {
  readonly kind: 'abstract' | 'paper'
  /** Epoch milliseconds of the instant. */
  readonly atMs: number
}

/** The IANA zone the ccfddl `PT` label means. */
const PACIFIC_ZONE = 'America/Los_Angeles'

/**
 * Pacific's UTC offset at one wall-clock date, in milliseconds.
 *
 * A fixed -8 is wrong for two thirds of the year, and wrong in the direction
 * that costs a submission: during PDT it places the deadline an hour later
 * than it is, so the countdown shows time that has already passed.
 *
 * Resolved by asking `Intl` what the zone's local time is for a UTC instant
 * and taking the difference. The first pass uses a standard-time guess; the
 * second re-resolves at that instant, which is what gets a date inside PDT
 * right. `-7` is the fallback if `Intl` has no zone data, because erring
 * toward the *earlier* instant is the safe half of the ambiguity.
 */
function pacificOffsetMs(wall: RegExpExecArray): number {
  const asUtc = Date.UTC(
    Number(wall[1]), Number(wall[2]) - 1, Number(wall[3]),
    Number(wall[4]), Number(wall[5]), Number(wall[6] ?? '0'),
  )
  try {
    const resolve = (instantMs: number): number => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: PACIFIC_ZONE,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(instantMs))
      const at = (type: string): number =>
        Number(parts.find(part => part.type === type)?.value ?? '0')
      const local = Date.UTC(
        at('year'), at('month') - 1, at('day'), at('hour'), at('minute'), at('second'),
      )
      return local - instantMs
    }
    // Two passes: the first offset is measured at the wrong instant when the
    // wall time is inside PDT, the second at the corrected one.
    const first = resolve(asUtc)
    return resolve(asUtc - first)
  } catch {
    return -7 * 3_600_000
  }
}

/**
 * Parse one ccfddl instant: a `YYYY-MM-DD HH:mm:ss` wall time plus a zone
 * string. The upstream file uses `AoE` (= UTC-12, the common case), `UTC±H`,
 * plain `UTC`, and a handful of `PT`.
 *
 * `PT` is resolved through the IANA zone rather than a fixed UTC-8. During
 * PDT the fixed offset put the instant an hour later than it really is, which
 * is the dangerous direction: the countdown said there was an hour left that
 * had already gone.
 * @param value - the wall-time string.
 * @param timezone - the zone string.
 * @returns epoch milliseconds, or null for an unparseable pair.
 */
export function parseCcfddlInstant(value: string, timezone: string): number | null {
  const wall = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim())
  if (wall === null) return null
  const zoneRaw = timezone.trim()
  let offsetMs: number
  if (/^aoe$/i.test(zoneRaw)) offsetMs = -12 * 3_600_000
  else if (/^pt$/i.test(zoneRaw)) offsetMs = pacificOffsetMs(wall)
  else if (/^utc$/i.test(zoneRaw)) offsetMs = 0
  else {
    const zone = /^UTC([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(zoneRaw)
    if (zone === null) return null
    offsetMs = (Number(zone[2]) * 3_600_000 + Number(zone[3] ?? '0') * 60_000) * (zone[1] === '-' ? -1 : 1)
  }
  const utcMs = Date.UTC(
    Number(wall[1]), Number(wall[2]) - 1, Number(wall[3]),
    Number(wall[4]), Number(wall[5]), Number(wall[6] ?? '0'),
  )
  return utcMs - offsetMs
}

/**
 * Calendar days from `nowMs` to `atMs` in the host's local zone, so a
 * deadline today is 0.
 *
 * `Math.ceil` on the millisecond gap does not answer that question: a
 * deadline five minutes away is 0.003 days, which rounds up to "1 day left",
 * and `withinDays=0` then matched nothing at all -- it excluded exactly the
 * deadlines it most needed to show. Truncating both ends to a local date
 * counts the boundaries a person actually reads.
 */
export function daysUntil(atMs: number, nowMs: number): number {
  const startOfLocalDay = (ms: number): number => {
    const date = new Date(ms)
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  }
  return Math.round((startOfLocalDay(atMs) - startOfLocalDay(nowMs)) / 86_400_000)
}

/* eslint-disable @typescript-eslint/no-unnecessary-condition -- the YAML is
   third-party data; every field is defensive regardless of the declared
   shape. */

/** Coerce one raw YAML timeline entry, or null when it carries no deadline. */
function timelineEntryOf(raw: unknown): VenueTimelineEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as Record<string, unknown>
  const deadline = typeof entry['deadline'] === 'string' ? entry['deadline'] : null
  const abstract = typeof entry['abstract_deadline'] === 'string' ? entry['abstract_deadline'] : null
  if (deadline === null && abstract === null) return null
  return {
    abstractDeadline: abstract,
    deadline,
    comment: typeof entry['comment'] === 'string' ? entry['comment'] : null,
  }
}

/** Coerce one raw YAML edition, or null when it lacks a usable identity. */
function confOf(raw: unknown): VenueConf | null {
  if (typeof raw !== 'object' || raw === null) return null
  const conf = raw as Record<string, unknown>
  if (typeof conf['id'] !== 'string' || typeof conf['year'] !== 'number') return null
  const timeline = Array.isArray(conf['timeline'])
    ? conf['timeline'].map(timelineEntryOf).filter((entry): entry is VenueTimelineEntry => entry !== null)
    : []
  return {
    year: conf['year'],
    id: conf['id'],
    link: typeof conf['link'] === 'string' ? conf['link'] : '',
    timeline: Object.freeze(timeline),
    timezone: typeof conf['timezone'] === 'string' ? conf['timezone'] : 'UTC-12',
    date: typeof conf['date'] === 'string' ? conf['date'] : '',
    place: typeof conf['place'] === 'string' ? conf['place'] : '',
  }
}

/**
 * Parse the ccfddl aggregate YAML into series rows. Malformed series and
 * editions are skipped, never fatal — a single bad upstream entry must not
 * blank the whole catalog.
 * @param text - the raw `allconf.yml` body.
 * @returns the parsed series (unfrozen; callers freeze at their boundary).
 */
export function parseAllconfYaml(text: string): VenueSeries[] {
  const doc: unknown = parseYaml(text)
  if (!Array.isArray(doc)) return []
  const out: VenueSeries[] = []
  for (const raw of doc) {
    if (typeof raw !== 'object' || raw === null) continue
    const series = raw as Record<string, unknown>
    if (typeof series['title'] !== 'string') continue
    const rankRaw = typeof series['rank'] === 'object' && series['rank'] !== null
      ? (series['rank'] as Record<string, unknown>)['ccf']
      : undefined
    const rank = typeof rankRaw === 'string' ? rankRaw.toUpperCase() : 'N'
    const confs = Array.isArray(series['confs'])
      ? series['confs'].map(confOf).filter((conf): conf is VenueConf => conf !== null)
      : []
    if (confs.length === 0) continue
    out.push({
      key: series['title'].toLowerCase(),
      title: series['title'],
      description: typeof series['description'] === 'string' ? series['description'] : '',
      sub: typeof series['sub'] === 'string' ? series['sub'] : '',
      ccfRank: (rank === 'A' || rank === 'B' || rank === 'C') ? rank : 'N',
      dblp: typeof series['dblp'] === 'string' ? series['dblp'] : null,
      confs: Object.freeze(confs),
    })
  }
  return out
}

/* eslint-enable @typescript-eslint/no-unnecessary-condition */

/**
 * The next pending deadline of one edition: the nearest future instant across
 * every round's abstract/paper deadlines.
 * @param conf - the edition.
 * @param nowMs - the reference instant.
 * @returns the next deadline, or null when the edition is fully past.
 */
export function nextDeadlineOf(conf: VenueConf, nowMs: number): VenueNextDeadline | null {
  let best: VenueNextDeadline | null = null
  for (const round of conf.timeline) {
    const candidates: VenueNextDeadline[] = []
    if (round.abstractDeadline !== null) {
      const atMs = parseCcfddlInstant(round.abstractDeadline, conf.timezone)
      if (atMs !== null) candidates.push({ kind: 'abstract', atMs })
    }
    if (round.deadline !== null) {
      const atMs = parseCcfddlInstant(round.deadline, conf.timezone)
      if (atMs !== null) candidates.push({ kind: 'paper', atMs })
    }
    for (const candidate of candidates) {
      if (candidate.atMs < nowMs) continue
      if (best === null || candidate.atMs < best.atMs) best = candidate
    }
  }
  return best
}

/**
 * The edition of one series the panel should show: the nearest edition with a
 * pending deadline; when every edition is past, the latest one (so the card
 * still answers "when/where was/is it" and links out). Series are year-sorted
 * by the upstream file, but we sort defensively.
 * @param series - the series.
 * @param nowMs - the reference instant.
 * @returns the edition plus its next deadline (null when fully past).
 */
export function currentConfOf(series: VenueSeries, nowMs: number): { conf: VenueConf; next: VenueNextDeadline | null } | null {
  const ordered = [...series.confs].sort((a, b) => a.year - b.year)
  if (ordered.length === 0) return null
  let upcoming: { conf: VenueConf; next: VenueNextDeadline } | null = null
  for (const conf of ordered) {
    const next = nextDeadlineOf(conf, nowMs)
    if (next === null) continue
    if (upcoming === null || next.atMs < upcoming.next.atMs) upcoming = { conf, next }
  }
  if (upcoming !== null) return upcoming
  const latest = ordered[ordered.length - 1]
  return latest === undefined ? null : { conf: latest, next: null }
}

/** One venue query: every set field narrows the result. */
export interface VenueQuery {
  /** Free text matched case-insensitively against title, full name, dblp key. */
  readonly query?: string | undefined
  /** Keep only one CCF rank. */
  readonly rank?: CcfRank | undefined
  /** Keep only one ccfddl field code (exact, case-insensitive). */
  readonly sub?: string | undefined
  /** Keep only editions whose next deadline lands within this many days. */
  readonly withinDays?: number | undefined
}

/** One series row with its current edition resolved, the query/list currency. */
export interface VenueCard {
  readonly series: VenueSeries
  readonly conf: VenueConf
  readonly next: VenueNextDeadline | null
}

/**
 * Fold the catalog against one query. A series without a resolvable current
 * edition never matches; `withinDays` additionally requires a pending
 * deadline inside the window.
 * @param catalog - the parsed series.
 * @param query - the narrowing fields.
 * @param nowMs - the reference instant.
 * @returns the matching cards, nearest deadline first (deadline-less last).
 */
export function queryVenues(catalog: readonly VenueSeries[], query: VenueQuery, nowMs: number): VenueCard[] {
  const needle = query.query?.trim().toLowerCase() ?? ''
  const sub = query.sub?.trim().toLowerCase() ?? ''
  const out: VenueCard[] = []
  for (const series of catalog) {
    if (query.rank !== undefined && series.ccfRank !== query.rank) continue
    if (sub !== '' && series.sub.toLowerCase() !== sub) continue
    if (needle !== ''
      && !series.title.toLowerCase().includes(needle)
      && !series.description.toLowerCase().includes(needle)
      && !(series.dblp ?? '').toLowerCase().includes(needle)) continue
    const current = currentConfOf(series, nowMs)
    if (current === null) continue
    if (query.withinDays !== undefined) {
      if (current.next === null) continue
      if (daysUntil(current.next.atMs, nowMs) > query.withinDays) continue
    }
    out.push({ series, conf: current.conf, next: current.next })
  }
  return out.sort((a, b) => {
    if (a.next === null) return b.next === null ? a.series.title.localeCompare(b.series.title) : 1
    if (b.next === null) return -1
    return a.next.atMs - b.next.atMs
  })
}

/** The distinct field codes present in one catalog, sorted, for filter UIs. */
export function venueSubsOf(catalog: readonly VenueSeries[]): readonly string[] {
  return Object.freeze([...new Set(catalog.map(series => series.sub).filter(sub => sub !== ''))].sort())
}

/** One entry of the static CCF-A journal directory (ccfddl tracks no journals). */
export interface VenueJournal {
  readonly title: string
  readonly fullName: string
  /** CCF field label (Chinese, matching the official catalog's naming). */
  readonly sub: string
  readonly publisher: string
}

/**
 * The static CCF-A journal directory: a fixed, well-known list (CCF 2022
 * catalog), offered as plain reference without deadlines. Ordered by field.
 */
export const CCF_A_JOURNALS: readonly VenueJournal[] = Object.freeze([
  { title: 'TOCS', fullName: 'ACM Transactions on Computer Systems', sub: '体系结构/并行与分布计算/存储系统', publisher: 'ACM' },
  { title: 'TOS', fullName: 'ACM Transactions on Storage', sub: '体系结构/并行与分布计算/存储系统', publisher: 'ACM' },
  { title: 'TCAD', fullName: 'IEEE Transactions on Computer-Aided Design of Integrated Circuits and System', sub: '体系结构/并行与分布计算/存储系统', publisher: 'IEEE' },
  { title: 'TC', fullName: 'IEEE Transactions on Computers', sub: '体系结构/并行与分布计算/存储系统', publisher: 'IEEE' },
  { title: 'TPDS', fullName: 'IEEE Transactions on Parallel and Distributed Systems', sub: '体系结构/并行与分布计算/存储系统', publisher: 'IEEE' },
  { title: 'TACO', fullName: 'ACM Transactions on Architecture and Code Optimization', sub: '体系结构/并行与分布计算/存储系统', publisher: 'ACM' },
  { title: 'JSAC', fullName: 'IEEE Journal on Selected Areas in Communications', sub: '计算机网络', publisher: 'IEEE' },
  { title: 'TMC', fullName: 'IEEE Transactions on Mobile Computing', sub: '计算机网络', publisher: 'IEEE' },
  { title: 'TON', fullName: 'IEEE/ACM Transactions on Networking', sub: '计算机网络', publisher: 'IEEE/ACM' },
  { title: 'TDSC', fullName: 'IEEE Transactions on Dependable and Secure Computing', sub: '网络与信息安全', publisher: 'IEEE' },
  { title: 'TIFS', fullName: 'IEEE Transactions on Information Forensics and Security', sub: '网络与信息安全', publisher: 'IEEE' },
  { title: 'JOC', fullName: 'Journal of Cryptology', sub: '网络与信息安全', publisher: 'Springer' },
  { title: 'TOPLAS', fullName: 'ACM Transactions on Programming Languages and Systems', sub: '软件工程/系统软件/程序设计语言', publisher: 'ACM' },
  { title: 'TOSEM', fullName: 'ACM Transactions on Software Engineering and Methodology', sub: '软件工程/系统软件/程序设计语言', publisher: 'ACM' },
  { title: 'TSE', fullName: 'IEEE Transactions on Software Engineering', sub: '软件工程/系统软件/程序设计语言', publisher: 'IEEE' },
  { title: 'TODS', fullName: 'ACM Transactions on Database Systems', sub: '数据库/数据挖掘/内容检索', publisher: 'ACM' },
  { title: 'TOIS', fullName: 'ACM Transactions on Information Systems', sub: '数据库/数据挖掘/内容检索', publisher: 'ACM' },
  { title: 'TKDE', fullName: 'IEEE Transactions on Knowledge and Data Engineering', sub: '数据库/数据挖掘/内容检索', publisher: 'IEEE' },
  { title: 'VLDBJ', fullName: 'The VLDB Journal', sub: '数据库/数据挖掘/内容检索', publisher: 'Springer' },
  { title: 'TOG', fullName: 'ACM Transactions on Graphics', sub: '计算机图形学与多媒体', publisher: 'ACM' },
  { title: 'TIP', fullName: 'IEEE Transactions on Image Processing', sub: '计算机图形学与多媒体', publisher: 'IEEE' },
  { title: 'TVCG', fullName: 'IEEE Transactions on Visualization and Computer Graphics', sub: '计算机图形学与多媒体', publisher: 'IEEE' },
  { title: 'AI', fullName: 'Artificial Intelligence', sub: '人工智能', publisher: 'Elsevier' },
  { title: 'TPAMI', fullName: 'IEEE Transactions on Pattern Analysis and Machine Intelligence', sub: '人工智能', publisher: 'IEEE' },
  { title: 'IJCV', fullName: 'International Journal of Computer Vision', sub: '人工智能', publisher: 'Springer' },
  { title: 'JMLR', fullName: 'Journal of Machine Learning Research', sub: '人工智能', publisher: 'JMLR.org' },
  { title: 'TIT', fullName: 'IEEE Transactions on Information Theory', sub: '计算机科学理论', publisher: 'IEEE' },
  { title: 'TOCHI', fullName: 'ACM Transactions on Computer-Human Interaction', sub: '人机交互与普适计算', publisher: 'ACM' },
  { title: 'IJHCS', fullName: 'International Journal of Human-Computer Studies', sub: '人机交互与普适计算', publisher: 'Elsevier' },
])
