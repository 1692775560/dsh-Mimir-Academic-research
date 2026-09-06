/**
 * Behavior tests for the venue-deadline surface: the ccfddl instant math
 * (AoE/UTC±H/PT), the defensive aggregate-YAML parse over a real-data fixture,
 * current-edition selection and the query fold, the fetch/cache shell (fake
 * fetch seam, corrupt-cache fail-open, refresh keeps the last good snapshot),
 * the watch-list Remote, and the `venue_search` tool's wire sentinels.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import type { ProjectRecord } from '../src/types.ts'
import {
  CCF_A_JOURNALS,
  currentConfOf,
  daysUntil,
  parseAllconfYaml,
  parseCcfddlInstant,
  queryVenues,
  venueSubsOf,
} from '../src/venue-deadlines.ts'
import {
  loadVenueCache,
  refreshVenueCache,
  searchVenueCache,
  VENUE_CACHE_FILE,
} from '../src/services/venue-deadlines.ts'
import { createVenueSearchTool } from '../src/tools/venue.ts'

/** Real-data extract: AAAI/CVPR/SOSP with AoE, UTC-12/-8/-7/-4 zones. */
const FIXTURE = fileURLToPath(new URL('./fixtures/ccfddl-sample.yml', import.meta.url))

/** 2026-01-01T00:00:00Z — SOSP26 + AAAI27 pending, CVPR fully past. */
const NOW = Date.UTC(2026, 0, 1)

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
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-ddl-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
  })
  return { ctx, domain, workspaceDir, service }
}

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Project',
  stage: 'writing',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

/** A fetch seam answering with the fixture body. */
function fixtureFetch(body: string) {
  return async (url: string, _signal: AbortSignal): Promise<string> => {
    expect(url).toBe('https://ccfddl.github.io/conference/allconf.yml')
    return body
  }
}

describe('parseCcfddlInstant', () => {
  it('parses AoE as UTC-12', () => {
    expect(parseCcfddlInstant('2025-08-01 23:59:59', 'AoE')).toBe(Date.UTC(2025, 7, 2, 11, 59, 59))
    expect(parseCcfddlInstant('2025-08-01 23:59:59', 'UTC-12')).toBe(Date.UTC(2025, 7, 2, 11, 59, 59))
  })

  it('parses UTC±H offsets in both directions', () => {
    expect(parseCcfddlInstant('2023-04-10 23:59:59', 'UTC-4')).toBe(Date.UTC(2023, 3, 11, 3, 59, 59))
    expect(parseCcfddlInstant('2026-01-01 08:00:00', 'UTC+8')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0))
    expect(parseCcfddlInstant('2026-01-01 00:00:00', 'UTC')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0))
  })

  it('approximates PT as UTC-8', () => {
    expect(parseCcfddlInstant('2026-01-01 00:00:00', 'PT')).toBe(Date.UTC(2026, 0, 1, 8, 0, 0))
  })

  it('accepts missing seconds and a T separator', () => {
    expect(parseCcfddlInstant('2026-01-01 08:00', 'UTC')).toBe(Date.UTC(2026, 0, 1, 8, 0, 0))
    expect(parseCcfddlInstant('2026-01-01T08:00:00', 'UTC')).toBe(Date.UTC(2026, 0, 1, 8, 0, 0))
  })

  it('returns null for an unparseable wall time or zone', () => {
    expect(parseCcfddlInstant('midnightish', 'UTC')).toBeNull()
    expect(parseCcfddlInstant('2026-01-01 00:00:00', 'EST')).toBeNull()
  })
})

describe('daysUntil', () => {
  it('rounds up whole days; a deadline today is 0 and past is negative', () => {
    expect(daysUntil(NOW, NOW)).toBe(0)
    expect(daysUntil(NOW + 1, NOW)).toBe(1)
    expect(daysUntil(NOW + 86_400_000, NOW)).toBe(1)
    expect(daysUntil(NOW - 86_400_000, NOW)).toBe(-1)
  })
})

describe('parseAllconfYaml', () => {
  it('parses the real-data fixture into three ranked series', async () => {
    const series = parseAllconfYaml(await readFile(FIXTURE, 'utf8'))
    expect(series.map(row => row.key)).toEqual(['aaai', 'cvpr', 'sosp'])
    const aaai = series[0]
    expect(aaai?.ccfRank).toBe('A')
    expect(aaai?.dblp).toBe('aaai')
    expect(aaai?.sub).toBe('AI')
    expect(aaai?.confs.length).toBe(6)
    const sosp = series[2]
    expect(sosp?.sub).toBe('SE')
    expect(sosp?.confs[3]?.timezone).toBe('UTC-7')
    expect(sosp?.confs[1]?.timeline.length).toBe(2)
    expect(sosp?.confs[1]?.timeline[0]?.comment).toBe('Deadline to Register Abstracts')
  })

  it('skips malformed series, editions, and deadline-less rounds', () => {
    const series = parseAllconfYaml([
      '- description: no title',
      '  confs: []',
      '- title: BROKEN',
      '  confs:',
      '  - id: broken26',
      '    timeline: []',
      '- title: HALF',
      '  rank: { ccf: b }',
      '  confs:',
      '  - year: 2026',
      '    id: half26',
      '    timeline:',
      '    - comment: no deadlines at all',
      '    - deadline: \'2026-05-01 23:59:59\'',
    ].join('\n'))
    expect(series.length).toBe(1)
    expect(series[0]?.key).toBe('half')
    expect(series[0]?.ccfRank).toBe('B')
    expect(series[0]?.confs[0]?.timeline.length).toBe(1)
  })

  it('returns an empty catalog for a non-array document', () => {
    expect(parseAllconfYaml('foo: bar')).toEqual([])
  })
})

describe('currentConfOf / queryVenues', () => {
  it('picks the nearest edition with a pending deadline', async () => {
    const catalog = parseAllconfYaml(await readFile(FIXTURE, 'utf8'))
    const sosp = catalog.find(row => row.key === 'sosp')
    expect(sosp).toBeDefined()
    if (sosp === undefined) return
    const current = currentConfOf(sosp, NOW)
    expect(current?.conf.id).toBe('sosp26')
    expect(current?.next?.kind).toBe('abstract')
    expect(current?.next?.atMs).toBe(Date.UTC(2026, 2, 27, 11, 59, 59))
  })

  it('falls back to the latest edition when every deadline is past', async () => {
    const catalog = parseAllconfYaml(await readFile(FIXTURE, 'utf8'))
    const cvpr = catalog.find(row => row.key === 'cvpr')
    const aaai = catalog.find(row => row.key === 'aaai')
    if (cvpr === undefined || aaai === undefined) throw new Error('fixture drift')
    expect(currentConfOf(cvpr, NOW)?.conf.id).toBe('cvpr26')
    expect(currentConfOf(cvpr, NOW)?.next).toBeNull()
    const future = currentConfOf(aaai, Date.UTC(2027, 6, 1))
    expect(future?.conf.id).toBe('aaai27')
    expect(future?.next).toBeNull()
  })

  it('sorts by next deadline, deadline-less editions last', async () => {
    const catalog = parseAllconfYaml(await readFile(FIXTURE, 'utf8'))
    const cards = queryVenues(catalog, {}, NOW)
    expect(cards.map(card => card.series.key)).toEqual(['sosp', 'aaai', 'cvpr'])
  })

  it('filters by free text, rank, field, and time window', async () => {
    const catalog = parseAllconfYaml(await readFile(FIXTURE, 'utf8'))
    expect(queryVenues(catalog, { query: 'vision' }, NOW).map(card => card.series.key)).toEqual(['cvpr'])
    expect(queryVenues(catalog, { query: 'AAAI' }, NOW).map(card => card.series.key)).toEqual(['aaai'])
    expect(queryVenues(catalog, { rank: 'A' }, NOW).length).toBe(3)
    expect(queryVenues(catalog, { rank: 'B' }, NOW).length).toBe(0)
    expect(queryVenues(catalog, { sub: 'se' }, NOW).map(card => card.series.key)).toEqual(['sosp'])
    expect(queryVenues(catalog, { withinDays: 90 }, NOW).map(card => card.series.key)).toEqual(['sosp'])
    expect(queryVenues(catalog, { withinDays: 300 }, NOW).map(card => card.series.key)).toEqual(['sosp', 'aaai'])
    expect(venueSubsOf(catalog)).toEqual(['AI', 'SE'])
  })
})

describe('CCF_A_JOURNALS', () => {
  it('carries the static CCF-A journal directory', () => {
    expect(CCF_A_JOURNALS.length).toBe(29)
    expect(CCF_A_JOURNALS.map(journal => journal.title)).toContain('TPAMI')
    for (const journal of CCF_A_JOURNALS) {
      expect(journal.fullName.length).toBeGreaterThan(0)
      expect(journal.sub.length).toBeGreaterThan(0)
    }
  })
})

describe('venue cache shell', () => {
  it('refreshVenueCache parses the payload and writes the cache atomically', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-cache-'))
    const body = await readFile(FIXTURE, 'utf8')
    const cache = await refreshVenueCache(workspaceDir, fixtureFetch(body))
    expect(cache.venues.length).toBe(3)
    expect(typeof cache.fetchedAt).toBe('string')
    const loaded = await loadVenueCache(workspaceDir)
    expect(loaded?.fetchedAt).toBe(cache.fetchedAt)
    expect(loaded?.venues.length).toBe(3)
  })

  it('coalesces concurrent refreshes for the same workspace', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-cache-'))
    const body = await readFile(FIXTURE, 'utf8')
    let calls = 0
    let resolveFetch!: (value: string) => void
    const pendingFetch = new Promise<string>((resolve) => {
      resolveFetch = resolve
    })
    const fetchImpl = async () => {
      calls += 1
      return pendingFetch
    }

    const first = refreshVenueCache(workspaceDir, fetchImpl)
    await Promise.resolve()
    const second = refreshVenueCache(workspaceDir, async () => {
      calls += 1
      return body
    })

    resolveFetch(body)
    const [left, right] = await Promise.all([first, second])

    expect(calls).toBe(1)
    expect(left).toBe(right)
  })

  it('rejects a payload that parses to an empty catalog', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-cache-'))
    await expect(refreshVenueCache(workspaceDir, async () => 'foo: bar')).rejects.toThrow('empty catalog')
    expect(await loadVenueCache(workspaceDir)).toBeNull()
  })

  it('a failed refresh keeps the last good cache', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-cache-'))
    const body = await readFile(FIXTURE, 'utf8')
    const good = await refreshVenueCache(workspaceDir, fixtureFetch(body))
    await expect(refreshVenueCache(workspaceDir, async () => {
      throw new Error('offline')
    })).rejects.toThrow('offline')
    const loaded = await loadVenueCache(workspaceDir)
    expect(loaded?.fetchedAt).toBe(good.fetchedAt)
    expect(loaded?.venues.length).toBe(3)
  })

  it('loadVenueCache fails open on a missing or corrupt cache file', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-cache-'))
    expect(await loadVenueCache(workspaceDir)).toBeNull()
    await writeFile(join(workspaceDir, VENUE_CACHE_FILE), 'not json')
    expect(await loadVenueCache(workspaceDir)).toBeNull()
    await writeFile(join(workspaceDir, VENUE_CACHE_FILE), '{"fetchedAt": 1}')
    expect(await loadVenueCache(workspaceDir)).toBeNull()
  })
})

describe('listVenueDeadlines / setVenueWatch / refreshVenueDeadlines', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('an empty cache yields an empty list with fetchedAt null, never a failure', async () => {
    const { service } = await harness()
    const result = await service.listVenueDeadlines({ projectId: 'p1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.venues).toEqual([])
    expect(result.value.fetchedAt).toBeNull()
    expect(result.value.watched).toEqual([])
    expect(result.value.journals.length).toBe(29)
  })

  it('lists the cached catalog with every series resolved to its current edition', async () => {
    const { workspaceDir, service } = await harness()
    await refreshVenueCache(workspaceDir, fixtureFetch(await readFile(FIXTURE, 'utf8')))
    const result = await service.listVenueDeadlines({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.venues.length).toBe(3)
    expect(typeof result.value.fetchedAt).toBe('string')
    const aaai = result.value.venues.find(venue => venue.key === 'aaai')
    // Every fixture deadline is past at real now: the latest edition rides along.
    expect(aaai?.ccfRank).toBe('A')
    expect(aaai?.conf.id).toBe('aaai27')
    expect(aaai?.nextDeadlineAt).toBeNull()
    expect(aaai?.conf.timeline.length).toBe(1)
  })

  it('scopes the watch list to the addressed project', async () => {
    const { domain, service } = await harness()
    await domain.table('venue_watches').put('p1:cvpr', {
      id: 'p1:cvpr', projectId: 'p1', series: 'cvpr', createdAt: '2026-08-20T00:00:00.000Z',
    })
    await domain.table('venue_watches').put('p2:aaai', {
      id: 'p2:aaai', projectId: 'p2', series: 'aaai', createdAt: '2026-08-20T00:00:00.000Z',
    })
    const result = await service.listVenueDeadlines({ projectId: 'p1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.watched).toEqual(['cvpr'])
  })

  it('setVenueWatch puts and deletes the composite row idempotently', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)

    const on = await service.setVenueWatch({ projectId: 'p1', series: 'CVPR', watched: true })
    expect(on).toMatchObject({ ok: true, value: { projectId: 'p1', series: 'cvpr', watched: true } })
    expect(domain.table('venue_watches').get('p1:cvpr')).toBeDefined()
    await service.setVenueWatch({ projectId: 'p1', series: 'cvpr', watched: true })
    expect([...domain.table('venue_watches').entries()].length).toBe(1)

    const off = await service.setVenueWatch({ projectId: 'p1', series: 'cvpr', watched: false })
    expect(off).toMatchObject({ ok: true, value: { watched: false } })
    expect(domain.table('venue_watches').get('p1:cvpr')).toBeUndefined()
  })

  it('setVenueWatch rejects an unknown project and a blank series', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    const ghost = await service.setVenueWatch({ projectId: 'ghost', series: 'cvpr', watched: true })
    expect(ghost).toMatchObject({ ok: false, error: { code: 'project-not-found' } })
    const blank = await service.setVenueWatch({ projectId: 'p1', series: '  ', watched: true })
    expect(blank).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })

  it('refreshVenueDeadlines reports operation-failed and keeps the old cache', async () => {
    const { workspaceDir, service } = await harness()
    const good = await refreshVenueCache(workspaceDir, fixtureFetch(await readFile(FIXTURE, 'utf8')))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const result = await service.refreshVenueDeadlines()
    expect(result).toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    expect((await loadVenueCache(workspaceDir))?.fetchedAt).toBe(good.fetchedAt)
  })
})

describe('searchVenueCache / venue_search tool', () => {
  /** Seed a cache file directly with one fabricated series. */
  async function seedCache(workspaceDir: string, deadline: string): Promise<void> {
    const venue = {
      key: 'xconf',
      title: 'XCONF',
      description: 'X Conference on Everything',
      sub: 'AI',
      ccfRank: 'A',
      dblp: null,
      confs: [{
        year: 2099,
        id: 'xconf99',
        link: 'https://xconf.example/',
        timeline: [{ abstractDeadline: null, deadline, comment: null }],
        timezone: 'UTC',
        date: 'June 1-4, 2099',
        place: 'Mars',
      }],
    }
    await writeFile(
      join(workspaceDir, VENUE_CACHE_FILE),
      JSON.stringify({ fetchedAt: '2026-09-01T00:00:00.000Z', venues: [venue] }),
    )
  }

  it('returns null when no cache exists yet', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-search-'))
    expect(await searchVenueCache(workspaceDir, {}, NOW)).toBeNull()
  })

  it('answers the query fold against the cache', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-search-'))
    await seedCache(workspaceDir, '2026-02-01 00:00:00')
    const answer = await searchVenueCache(workspaceDir, { query: 'xconf' }, NOW)
    expect(answer?.fetchedAt).toBe('2026-09-01T00:00:00.000Z')
    expect(answer?.results.length).toBe(1)
    expect(answer?.results[0]?.nextDeadlineKind).toBe('paper')
    expect(answer?.results[0]?.daysLeft).toBe(31)
    expect(await searchVenueCache(workspaceDir, { query: 'nope' }, NOW)).toMatchObject({ results: [] })
  })

  it('execute validates rank and within_days', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-search-'))
    const tool = createVenueSearchTool(workspaceDir)
    const call = { signal: new AbortController().signal } as never
    await expect(tool.execute({ rank: 'D' }, call)).rejects.toThrow("rank must be 'A', 'B', or 'C'")
    await expect(tool.execute({ within_days: 0 }, call)).rejects.toThrow('within_days must be a positive integer')
  })

  it('execute fails with a hint when the catalog was never fetched', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-search-'))
    const tool = createVenueSearchTool(workspaceDir)
    await expect(tool.execute({}, { signal: new AbortController().signal } as never))
      .rejects.toThrow('has not been fetched yet')
  })

  it('execute returns the wire shape and maps a past edition to the sentinels', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-search-'))
    await seedCache(workspaceDir, '2020-01-01 00:00:00')
    const tool = createVenueSearchTool(workspaceDir)
    const value = await tool.execute({}, { signal: new AbortController().signal } as never) as {
      fetched_at: string
      results: { title: string, nextDeadlineAt: string, nextDeadlineKind: string, daysLeft: number }[]
    }
    expect(value.fetched_at).toBe('2026-09-01T00:00:00.000Z')
    expect(value.results.length).toBe(1)
    expect(value.results[0]?.title).toBe('XCONF')
    expect(value.results[0]?.nextDeadlineAt).toBe('')
    expect(value.results[0]?.nextDeadlineKind).toBe('')
    expect(value.results[0]?.daysLeft).toBe(-1)
  })

  it('execute answers a pending deadline with kind and day count', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-venue-search-'))
    await seedCache(workspaceDir, '2099-01-01 00:00:00')
    const tool = createVenueSearchTool(workspaceDir)
    const value = await tool.execute({ rank: 'a', within_days: 36500 }, { signal: new AbortController().signal } as never) as {
      results: { nextDeadlineKind: string, daysLeft: number, year: number }[]
    }
    expect(value.results.length).toBe(1)
    expect(value.results[0]?.nextDeadlineKind).toBe('paper')
    expect(value.results[0]?.year).toBe(2099)
    expect(value.results[0]?.daysLeft).toBeGreaterThan(1000)
  })
})
