/**
 * The `web_search` tool: SearXNG multi-engine web search through the `sxng`
 * CLI (a self-hosted SearXNG deployment is the CLI's own concern — its
 * config carries the base URL). One flat parameter set; the output mirrors
 * the CLI's JSON envelope (`{status, data.results[]}`). The runner is
 * injectable so tests never touch the real executable.
 * @module dsh-mimir/src/tools/web-search
 */

import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { installCommandFor, detectPackageManager } from '../pm-detect.ts'

/** Install hint carried in every missing-CLI error, tuned to the detected PM. */
function installGuidance(): string {
  const command = installCommandFor(detectPackageManager())
  return ['Install the sxng CLI with ', command, ' and point it at a self-hosted SearXNG instance (`sxng init`), or set search.command to the binary path.'].join('')
}

/** Whether one command resolves to a runnable executable. Injectable so tests never touch the real PATH. */
export type WebSearchRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<string>

/** Deployment knobs for the web search tool. */
export interface WebSearchOptions {
  /** The sxng executable: a bare name resolved on PATH or an absolute path. */
  readonly command: string
  /** Positive kill timeout in milliseconds. */
  readonly timeoutMs: number
  /** Default result cap for tool calls that omit one. */
  readonly maxResults: number
  /** Test hook replacing the real child process; never used in production. */
  readonly run?: WebSearchRunner
}

/** One parsed SearXNG result row (the tool/Remote wire shape). */
export interface WebSearchEntry {
  readonly title: string
  readonly url: string
  readonly content: string
  readonly engine: string
  readonly category: string
  readonly publishedDate: string
}

/** Raw shape of one row inside the CLI's JSON envelope. */
interface RawSxngRow {
  title?: unknown
  url?: unknown
  content?: unknown
  engine?: unknown
  category?: unknown
  publishedDate?: unknown
}

/** Real runner: resolve stdout or reject with a readable message. */
const runOnPath: WebSearchRunner = (command, args, timeoutMs, signal) => new Promise((resolve, reject) => {
  execFile(
    command,
    [...args],
    { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', ...(signal === undefined ? {} : { signal }) },
    (error: ExecFileException | null, stdout: string) => {
      if (error !== null && error.code === 'ENOENT') {
        reject(new Error(`Web search command '${command}' was not found on PATH. ${installGuidance()}`, { cause: error }))
        return
      }
      if (error !== null && signal !== undefined && signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
        return
      }
      // The CLI reports its own failures in the JSON body with exit code 1;
      // the stdout still parses, so hand it over either way.
      resolve(stdout)
    },
  )
})

/** Coerce one raw row field to a trimmed string, absent → empty. */
function field(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Per-call search modifiers beyond the deployment knobs. */
interface WebSearchModifiers {
  /** Comma-separated SearXNG categories (e.g. `science`, `it,general`). */
  readonly categories?: string | undefined
  /** Language bias for results (e.g. `en`, `zh`). */
  readonly lang?: string | undefined
  /** Freshness filter (`day`, `week`, `month`, `year`, `all`). */
  readonly timeRange?: string | undefined
}

/**
 * Run one web search through the sxng CLI and parse the JSON envelope.
 * @param query - free-text query.
 * @param options - deployment knobs plus the optional per-call modifiers and
 * the test runner.
 * @returns the parsed entries, possibly empty for a resultless query.
 */
export async function fetchWebSearch(
  query: string,
  options: WebSearchOptions & WebSearchModifiers,
  signal?: AbortSignal,
): Promise<WebSearchEntry[]> {
  const args = ['-f', 'json']
  const maxResults = options.maxResults
  if (Number.isSafeInteger(maxResults) && maxResults > 0) args.push('-l', String(maxResults))
  if (options.categories !== undefined && options.categories.trim().length > 0) args.push('-c', options.categories.trim())
  if (options.lang !== undefined && options.lang.trim().length > 0) args.push('--lang', options.lang.trim())
  if (options.timeRange !== undefined && options.timeRange.trim().length > 0) args.push('--time', options.timeRange.trim())
  // `--` ends option parsing so a query starting with `-` stays the query
  // (commander would otherwise swallow it as an unknown flag).
  args.push('--', query)
  const run = options.run ?? runOnPath
  const stdout = await run(options.command, args, options.timeoutMs, signal)
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('sxng output was not valid JSON — is search.command pointing at the sxng CLI?')
  }
  const envelope = parsed as { status?: unknown; data?: unknown; error?: unknown }
  if (envelope.status === 'error') {
    const message = typeof (envelope.error as { message?: unknown } | null)?.message === 'string'
      ? String((envelope.error as { message: string }).message)
      : 'sxng reported an unspecified failure'
    throw new Error(message)
  }
  if (envelope.status !== 'ok' || typeof envelope.data !== 'object' || envelope.data === null) {
    throw new Error('unexpected sxng output shape')
  }
  const rows = (envelope.data as { results?: unknown }).results
  if (!Array.isArray(rows)) return []
  const entries: WebSearchEntry[] = []
  for (const row of rows as RawSxngRow[]) {
    const url = field(row.url)
    if (url === '') continue
    entries.push({
      title: field(row.title),
      url,
      content: field(row.content),
      engine: field(row.engine),
      category: field(row.category),
      publishedDate: field(row.publishedDate),
    })
  }
  return entries
}

/** Render one entry list as model-facing text (mirrors renderEntries). */
function renderWebEntries(entries: readonly WebSearchEntry[]): string {
  if (entries.length === 0) return 'No web results.'
  return entries.map(entry =>
    `- ${entry.title || entry.url}\n  ${entry.url}\n  Engine: ${entry.engine || '?'} · Category: ${entry.category || '?'}${entry.publishedDate === '' ? '' : ` · Published: ${entry.publishedDate}`}\n  ${entry.content}`,
  ).join('\n')
}

/** JSON-schema properties of one {@link WebSearchEntry} in tool output. */
const ENTRY_PROPERTIES = {
  title: { type: 'string', required: true },
  url: { type: 'string', required: true },
  content: { type: 'string', required: true },
  engine: { type: 'string', required: true },
  category: { type: 'string', required: true },
  publishedDate: { type: 'string', required: true },
} as const

/** Per-call arguments of the `web_search` tool. */
interface WebSearchArgs {
  readonly query: string
  readonly limit?: number
  readonly categories?: string
  readonly lang?: string
  readonly time_range?: string
}

/**
 * Build the `web_search` tool.
 * @param options - Deployment knobs; supply `run` only in tests.
 * @returns the registry-ready tool definition, or null when the caller
 * decides the command is unavailable.
 */
export function createWebSearchTool(options: WebSearchOptions): ToolDefinition {
  return defineTool({
    name: 'web_search',
    description: 'Search the web through a self-hosted SearXNG instance (via the sxng CLI): Google/Bing/DuckDuckGo/GitHub/StackOverflow/arXiv-portal and more. Complements arxiv_search with non-arXiv sources — official docs, blog posts, code repositories. Returns titles, URLs, snippets, engines, and publish dates.',
    parameters: {
      query: { type: 'string', required: true, description: 'Free-text web search query.' },
      limit: { type: 'integer', description: `Maximum results to return (default ${options.maxResults}).` },
      categories: { type: 'string', description: "Comma-separated SearXNG categories, e.g. 'science', 'it', 'general'." },
      lang: { type: 'string', description: "Language bias for results, e.g. 'en', 'zh'." },
      time_range: { type: 'string', description: "Freshness filter: 'day', 'week', 'month', 'year', or 'all'." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: ENTRY_PROPERTIES },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderWebEntries(value.results) }],
    },
    async execute(args: WebSearchArgs, exec) {
      const query = args.query.trim()
      if (query.length === 0) throw new TypeError('query must be a non-empty string')
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
        throw new TypeError('limit must be a positive integer')
      }
      return {
        results: await fetchWebSearch(query, {
          command: options.command,
          timeoutMs: options.timeoutMs,
          maxResults: args.limit ?? options.maxResults,
          categories: args.categories,
          lang: args.lang,
          timeRange: args.time_range,
          ...(options.run === undefined ? {} : { run: options.run }),
        }, exec.signal),
      }
    },
  })
}
