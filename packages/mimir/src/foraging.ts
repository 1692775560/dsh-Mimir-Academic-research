/**
 * CBE foraging organs (S4): the research territory ledger, the personal
 * giving-up-time baseline, and the data behind the GUT card — foraging
 * ECOLOGY as the map layer's native vocabulary (R6, user-ratified), never
 * as an optimization backbone. Everything here is E0 arithmetic: dates,
 * counts, and decayed sums. Two numbers, zero verbs — the card reports
 * "N days since the last harvest · your median close interval is M days"
 * and NOTHING that says go or stay (Charnov's theorem is copy/trigger
 * only; Nonacs 2001 showed even animals are not optimal, and telling a
 * researcher when to leave would violate the origin rule anyway).
 *
 * v1 honesty notes (registered issues, not silent choices):
 *  - territory = projectId; the surveyor draws borders by creating
 *    projects, the system only keeps books;
 *  - the v1 "harvest" proxy is a CLEAN COMPILE (`writing.compile.settled`
 *    with zero issues) — the only decision-grade completion event that
 *    carries a project ref today. Claim and job terminals carry no
 *    projectId, so true harvest attribution waits on richer refs;
 *  - the baseline's GUT sample is "close minus the lane's last touch"
 *    (any event), not "close minus last terminal" — per-idea terminals
 *    are too sparse for a median; the terminal-GUT variant is a G1 item.
 * @module dsh-mimir/src/foraging
 */

import { deriveWorktree } from './worktree.ts'
import { CBE_HALF_LIFE_DAYS } from './vocabulary.ts'
import type { CbeWikiSnapshot } from './cognitive-map.ts'
import { signedWeight } from './vocabulary.ts'
import type { EventRecord } from './types.ts'
import { MS_PER_DAY, orderedEvents, tsToMs } from './time.ts'

/** Documented closes before the personal baseline may speak (I2's floor). */
export const CBE_GUT_BASELINE_MIN_DEPARTURES = 5


/** Round to 3 decimals for stable rendering/serialization. */
function r3(value: number): number {
  return Math.round(value * 1000) / 1000
}


/** One research territory's E0 ledger row. */
export interface CbeTerritory {
  readonly projectId: string
  readonly label: string
  readonly eventCount: number
  readonly firstSeen: string
  readonly lastSeen: string
  /** Kernel-decayed sum of |signed weight| — attention mass, sign-blind. */
  readonly activityMass: number
  /** Clean compiles in the stream — the v1 harvest proxy (see module doc). */
  readonly harvestCount: number
  /** The last harvest's timestamp; null while the territory never harvested. */
  readonly lastHarvestAt: string | null
  /** Days from the last harvest to `now`; null while never harvested. */
  readonly daysSinceHarvest: number | null
  /** Days from the last event of any kind to `now`. */
  readonly daysSinceActivity: number
}

/** The personal giving-up-time baseline over documented closes. */
export interface CbeGutBaseline {
  /** GUT samples collected (close minus last touch, one per failed lane). */
  readonly samples: number
  /** Median GUT in days; null while the baseline may not speak. */
  readonly medianDays: number | null
  /** Interquartile range in days; null while the baseline may not speak. */
  readonly iqrDays: number | null
  /** The floor the baseline needs before it speaks (registry-governed). */
  readonly minSamples: number
  /** Whether the baseline speaks at all (samples ≥ minSamples). */
  readonly speaks: boolean
}

/** The GUT card's data for one territory: two numbers, zero verbs. */
export interface CbeGutCard {
  readonly projectId: string
  readonly label: string
  /** Days since the territory's last harvest (the card's first number). */
  readonly daysSinceHarvest: number | null
  /** Days since any activity — the honest fallback before a first harvest. */
  readonly daysSinceActivity: number
  /** The personal baseline median; null while the baseline stays silent. */
  readonly baselineMedianDays: number | null
}

/** The whole derived foraging layer (L1: re-derivable, never persisted). */
export interface CbeForaging {
  readonly asOf: string
  readonly territories: readonly CbeTerritory[]
  readonly baseline: CbeGutBaseline
  readonly cards: readonly CbeGutCard[]
}

/** Median of a numeric list (even length → mean of the two middle values). */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Quantile of a sorted ascending list (nearest-rank). */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index] ?? 0
}

/**
 * Derive the territory ledger: one row per declared project (wiki) or
 * project seen in the stream — a territory exists once the surveyor
 * draws it, not once work lands on it. Attention mass decays with the
 * same half-life the map uses; harvests are clean compiles (v1 proxy).
 * @param events - ledger events, any order.
 * @param wiki - the wiki tables (projects are the declared territories).
 * @param nowMs - "now" in epoch ms (injectable for determinism).
 * @returns territories sorted by last activity, newest first.
 */
export function deriveTerritories(
  events: readonly EventRecord[],
  wiki: CbeWikiSnapshot,
  nowMs: number,
): readonly CbeTerritory[] {
  interface Accum {
    count: number
    firstMs: number
    lastMs: number
    mass: number
    harvests: number
    lastHarvestMs: number
  }
  const byProject = new Map<string, Accum>()
  const labels = new Map(wiki.projects.map(project => [project.id, project.title]))
  const touch = (projectId: string | undefined, ms: number): void => {
    if (projectId === undefined) return
    const current = byProject.get(projectId) ?? {
      count: 0, firstMs: ms, lastMs: ms, mass: 0, harvests: 0, lastHarvestMs: 0,
    }
    current.count += 1
    current.firstMs = Math.min(current.firstMs, ms)
    current.lastMs = Math.max(current.lastMs, ms)
    byProject.set(projectId, current)
  }

  const ordered = orderedEvents(events)
  for (const event of ordered) {
    const ms = tsToMs(event.ts)
    if (ms === null) continue
    const projectId = event.refs.projectId
    if (projectId === undefined) continue
    touch(projectId, ms)
    const accum = byProject.get(projectId)
    if (accum === undefined) continue
    accum.mass += Math.abs(signedWeight(event)) * Math.exp(-Math.LN2 * (nowMs - ms) / (CBE_HALF_LIFE_DAYS * MS_PER_DAY))
    // The v1 harvest proxy: a clean compile is the only project-attributed
    // decision-grade completion in today's vocabulary.
    if (event.action === 'writing.compile.settled' && event.payload['issues'] === 0) {
      accum.harvests += 1
      accum.lastHarvestMs = ms
    }
  }

  // Declared-but-quiet territories still appear (the surveyor drew them).
  for (const project of wiki.projects) {
    if (!byProject.has(project.id)) {
      byProject.set(project.id, { count: 0, firstMs: 0, lastMs: 0, mass: 0, harvests: 0, lastHarvestMs: 0 })
    }
  }

  const territories: CbeTerritory[] = [...byProject.entries()]
    .map(([projectId, accum]) => {
      const noEvents = accum.count === 0
      const declaredUpdateMs = tsToMs(
        wiki.projects.find(item => item.id === projectId)?.updatedAt ?? '',
      )
      const lastActivityMs = noEvents ? (declaredUpdateMs ?? nowMs) : accum.lastMs
      return Object.freeze({
        projectId,
        label: labels.get(projectId) ?? projectId,
        eventCount: accum.count,
        firstSeen: noEvents ? '' : new Date(accum.firstMs).toISOString(),
        lastSeen: noEvents ? '' : new Date(accum.lastMs).toISOString(),
        activityMass: r3(accum.mass),
        harvestCount: accum.harvests,
        lastHarvestAt: accum.lastHarvestMs === 0 ? null : new Date(accum.lastHarvestMs).toISOString(),
        daysSinceHarvest: accum.lastHarvestMs === 0
          ? null
          : r3(Math.max(0, (nowMs - accum.lastHarvestMs) / MS_PER_DAY)),
        daysSinceActivity: r3(Math.max(0, (nowMs - lastActivityMs) / MS_PER_DAY)),
      })
    })
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.projectId.localeCompare(b.projectId))
  return Object.freeze(territories)
}

/**
 * The personal GUT baseline: one sample per documented close (the failed
 * lanes' close-minus-last-touch numbers, reused from the worktree
 * derivation), reported as median and IQR — but only once
 * {@link CBE_GUT_BASELINE_MIN_DEPARTURES} closes exist. Below the floor
 * the baseline stays SILENT (I2's rule: not enough words have been earned).
 * @param events - ledger events, any order.
 * @param wiki - the wiki tables (idea statuses pick the failed lanes).
 * @param nowMs - "now" in epoch ms (injectable for determinism).
 * @returns the baseline with its silence flag.
 */
export function deriveGutBaseline(
  events: readonly EventRecord[],
  wiki: CbeWikiSnapshot,
  nowMs: number,
): CbeGutBaseline {
  const tree = deriveWorktree(events, wiki, nowMs)
  const samples = tree.lanes
    .map(lane => lane.gutDays)
    .filter((value): value is number => value !== null)
  const speaks = samples.length >= CBE_GUT_BASELINE_MIN_DEPARTURES
  if (!speaks) {
    return Object.freeze({
      samples: samples.length,
      medianDays: null,
      iqrDays: null,
      minSamples: CBE_GUT_BASELINE_MIN_DEPARTURES,
      speaks: false,
    })
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return Object.freeze({
    samples: samples.length,
    medianDays: r3(median(sorted)),
    iqrDays: r3(quantile(sorted, 0.75) - quantile(sorted, 0.25)),
    minSamples: CBE_GUT_BASELINE_MIN_DEPARTURES,
    speaks: true,
  })
}

/**
 * Compose the whole foraging layer: territories, the baseline, and the
 * GUT cards (one per territory with activity — the card's second number
 * appears only when the baseline speaks).
 * @param events - ledger events, any order.
 * @param wiki - the wiki tables.
 * @param nowMs - "now" in epoch ms (injectable for determinism).
 * @returns the frozen foraging model.
 */
export function deriveForaging(
  events: readonly EventRecord[],
  wiki: CbeWikiSnapshot,
  nowMs: number,
): CbeForaging {
  const territories = deriveTerritories(events, wiki, nowMs)
  const baseline = deriveGutBaseline(events, wiki, nowMs)
  const cards = territories
    .filter(territory => territory.eventCount > 0)
    .map(territory => Object.freeze({
      projectId: territory.projectId,
      label: territory.label,
      daysSinceHarvest: territory.daysSinceHarvest,
      daysSinceActivity: territory.daysSinceActivity,
      baselineMedianDays: baseline.speaks ? baseline.medianDays : null,
    }))
  return Object.freeze({
    asOf: new Date(nowMs).toISOString(),
    territories: Object.freeze(territories),
    baseline: Object.freeze(baseline),
    cards: Object.freeze(cards),
  })
}
