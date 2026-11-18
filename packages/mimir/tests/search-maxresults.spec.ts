/**
 * Behavior tests for the web-search result cap being its own config knob
 * (#232). Before this landed, the registered `web_search` tool read
 * `resolved.arxiv.maxResults`: a user who set `arxiv.maxResults: 50` silently
 * got 50 web results per call, and `searchWeb` bounded its own default by the
 * arXiv constants. Memory-backed config, injected CLI runner, no mocks of the
 * code under test.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.ts'
import { createWebSearchTool } from '../src/tools/web-search.ts'

/** The digdig JSON envelope carrying `count` placeholder rows. */
function digdigBody(count: number): string {
  const results = Array.from({ length: count }, (_, index) => ({
    title: `row ${index}`,
    url: `https://example.com/${index}`,
    content: 'snippet',
    engine: 'brave',
    category: 'general',
    publishedDate: '',
  }))
  return JSON.stringify({ status: 'ok', data: { results } })
}

/** A runner that records its argv and answers with `count` rows. */
function recordingRunner(seen: string[][], count = 3) {
  return (_command: string, args: readonly string[], _timeoutMs: number, _signal?: AbortSignal): Promise<string> => {
    seen.push([...args])
    return Promise.resolve(digdigBody(count))
  }
}

/** The `-l` value a recorded argv asked for, or undefined when absent. */
function limitArg(args: readonly string[]): string | undefined {
  const index = args.indexOf('-l')
  return index === -1 ? undefined : args[index + 1]
}

const signal = new AbortController().signal

describe('search.maxResults is its own knob (#232)', () => {
  it('defaults to 10 independently of arxiv.maxResults', () => {
    const config = Config({})
    expect(config.search?.maxResults).toBe(10)
    expect(config.arxiv?.maxResults).toBe(10)
  })

  it('takes a value the arXiv knob does not share', () => {
    const config = Config({ arxiv: { maxResults: 50 }, search: { maxResults: 20 } })
    expect(config.arxiv?.maxResults).toBe(50)
    expect(config.search?.maxResults).toBe(20)
  })

  it('rejects a non-integer, sub-1, or over-cap value', () => {
    expect(() => Config({ search: { maxResults: 0 } })).toThrow()
    expect(() => Config({ search: { maxResults: 1.5 } })).toThrow()
    expect(() => Config({ search: { maxResults: 51 } })).toThrow()
  })

  it('apply() validates it even without Loader normalization', async () => {
    // resolveConfig runs first inside apply(), so the bad value throws before
    // any inject service is touched.
    await expect(apply(new Context(), { search: { maxResults: 0 } })).rejects.toThrow(TypeError)
  })
})

describe('the registered tool caps at search.maxResults, not arxiv.maxResults', () => {
  it('sends the deployment default when the call omits a limit', async () => {
    const seen: string[][] = []
    const tool = createWebSearchTool({ command: 'dg', timeoutMs: 1000, maxResults: 20, run: recordingRunner(seen) })
    await tool.execute({ query: 'mesh' }, { signal } as never)
    expect(limitArg(seen[0] ?? [])).toBe('20')
  })

  it('lets a per-call limit win over the deployment default', async () => {
    const seen: string[][] = []
    const tool = createWebSearchTool({ command: 'dg', timeoutMs: 1000, maxResults: 20, run: recordingRunner(seen) })
    await tool.execute({ query: 'mesh', limit: 3 }, { signal } as never)
    expect(limitArg(seen[0] ?? [])).toBe('3')
  })

  it('advertises the configured default in the parameter description', () => {
    const tool = createWebSearchTool({ command: 'dg', timeoutMs: 1000, maxResults: 20 })
    const limit = (tool.parameters as { properties: Record<string, { description?: string }> }).properties.limit
    expect(limit.description).toContain('20')
  })

  it('a bad config value never reaches the CLI as a silent cap', async () => {
    const seen: string[][] = []
    const tool = createWebSearchTool({ command: 'dg', timeoutMs: 1000, maxResults: 10, run: recordingRunner(seen) })
    await expect(tool.execute({ query: 'q', limit: -1 }, { signal } as never)).rejects.toThrow('limit must be a positive integer')
    expect(seen).toHaveLength(0)
  })
})
