/**
 * The `venue_search` agent tool: answers "when does CVPR close", "which CCF-A
 * systems conferences close within 90 days" against the local ccfddl cache
 * (never the network — the refresh loop owns fetching, so the tool works
 * offline on the last good snapshot). Name matching is a case-insensitive
 * substring over title, full name, and dblp key.
 * @module dsh-mimir/src/tools/venue
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { searchVenueCache } from '../services/venue-deadlines.ts'
import type { CcfRank } from '../venue-deadlines.ts'

/** Hard cap of one answer's rows (a guard, not a tunable). */
export const VENUE_SEARCH_MAX_RESULTS = 30

/** Render one result list as model-facing text (wire form: ''/-1 sentinels). */
function renderResults(results: readonly {
  title: string; year: number; ccfRank: string; sub: string; description: string
  link: string; date: string; place: string
  nextDeadlineAt: string; nextDeadlineKind: string; daysLeft: number
  /** Present at runtime; the output schema keeps the rows summary-only. */
  timeline?: readonly { abstractDeadline: string | null; deadline: string | null; comment: string | null }[] | undefined
}[], fetchedAt: string): string {
  if (results.length === 0) return 'No matching venues in the cached CCF catalog.'
  const lines = results.map((row) => {
    const ddl = row.nextDeadlineAt === ''
      ? 'no pending deadline'
      : `${row.nextDeadlineKind === 'abstract' ? 'abstract' : 'paper'} deadline ${row.nextDeadlineAt} (${String(row.daysLeft)}d left)`
    const timeline = (row.timeline ?? []).map((round) => {
      const parts = [
        round.abstractDeadline === null ? null : `abstract ${round.abstractDeadline}`,
        round.deadline === null ? null : `paper ${round.deadline}`,
      ].filter(part => part !== null)
      return `    - ${parts.join(' · ')}${round.comment === null ? '' : ` (${round.comment})`}`
    })
    return [
      `- ${row.title} ${String(row.year)} [CCF-${row.ccfRank}] (${row.sub}): ${row.description}`,
      `  ${ddl}; conference ${row.date}, ${row.place}`,
      `  ${row.link}`,
      ...timeline,
    ].join('\n')
  })
  return [`Catalog fetched at ${fetchedAt} (ccfddl/ccf-deadlines cache):`, ...lines].join('\n')
}

/**
 * Build the `venue_search` tool.
 * @param workspaceDir - workspace root the venue cache lives under.
 * @returns the registry-ready tool definition.
 */
export function createVenueSearchTool(workspaceDir: string): ToolDefinition {
  return defineTool({
    name: 'venue_search',
    description: 'Query the CCF conference-deadline catalog (ccfddl/ccf-deadlines, cached locally and refreshed every 6h). Answers questions like "when is the CVPR deadline", "which CCF-A architecture conferences close in the next 90 days", "list CCF-B NLP venues". Returns each venue\'s full name, CCF rank, field, every round\'s abstract/paper deadlines, and the conference date/place/link. All deadlines are ISO instants already converted from the source timezone (usually AoE / UTC-12).',
    parameters: {
      query: { type: 'string', description: 'Name fragment matched against the title, full name, and dblp key (e.g. "cvpr", "vision").' },
      rank: { type: 'string', description: 'CCF rank filter: A, B, or C.' },
      sub: { type: 'string', description: 'Field code filter (exact, case-insensitive): AI (人工智能/CV/ML/NLP), DS (体系结构/系统), SE (软件工程/PL), DB (数据库/数据挖掘), NW (网络), SC (安全), CG (图形学/多媒体), HI (人机交互), CT (理论), MX (交叉).' },
      within_days: { type: 'integer', description: 'Keep only venues whose next deadline falls within this many days from now.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fetched_at: { type: 'string', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                description: { type: 'string', required: true },
                sub: { type: 'string', required: true },
                ccfRank: { type: 'string', required: true },
                year: { type: 'integer', required: true },
                link: { type: 'string', required: true },
                date: { type: 'string', required: true },
                place: { type: 'string', required: true },
                nextDeadlineAt: { type: 'string', required: true },
                nextDeadlineKind: { type: 'string', required: true },
                daysLeft: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResults(value.results, value.fetched_at) }],
    },
    async execute(args) {
      const rank = args.rank?.trim().toUpperCase()
      if (rank !== undefined && rank !== '' && rank !== 'A' && rank !== 'B' && rank !== 'C') {
        throw new TypeError("rank must be 'A', 'B', or 'C'")
      }
      const withinDays = args.within_days
      if (withinDays !== undefined && (!Number.isSafeInteger(withinDays) || withinDays < 1)) {
        throw new TypeError('within_days must be a positive integer')
      }
      const answer = await searchVenueCache(workspaceDir, {
        ...(args.query === undefined ? {} : { query: args.query }),
        ...(rank === undefined || rank === '' ? {} : { rank: rank as CcfRank }),
        ...(args.sub === undefined ? {} : { sub: args.sub }),
        ...(withinDays === undefined ? {} : { withinDays }),
      })
      if (answer === null) {
        throw new Error('the venue catalog has not been fetched yet (first refresh runs right after plugin start; offline hosts keep the last cache) — try again shortly')
      }
      return {
        fetched_at: answer.fetchedAt,
        // The output schema is null-free: a fully past edition reports ''/-1.
        results: answer.results.slice(0, VENUE_SEARCH_MAX_RESULTS).map(row => ({
          ...row,
          nextDeadlineAt: row.nextDeadlineAt ?? '',
          nextDeadlineKind: row.nextDeadlineKind ?? '',
          daysLeft: row.daysLeft ?? -1,
        })),
      }
    },
  })
}
