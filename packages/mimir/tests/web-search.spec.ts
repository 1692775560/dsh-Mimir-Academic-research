/**
 * Behavior tests for the digdig-backed web search: argument assembly, the
 * SearXNG JSON envelope parse, and failure mapping. The CLI runner is
 * injected — no test touches the real `digdig` executable or PATH.
 */

import { describe, expect, it } from 'vitest'
import { createWebSearchTool, fetchWebSearch } from '../src/tools/web-search.ts'

/** A runner capturing its argv and answering with one canned payload. */
function runCapturing(stdout: string): { run: (command: string, args: readonly string[], timeoutMs: number, _signal?: AbortSignal) => Promise<string>; argv: () => readonly string[] } {
  const seen: string[][] = []
  return {
    run: (_command, args, _timeoutMs, _signal) => { seen.push([...args]); return Promise.resolve(stdout) },
    argv: () => seen[0] ?? [],
  }
}

const DIGDIG_OK = JSON.stringify({
  status: 'ok',
  data: {
    query: 'attention',
    totalResults: 2,
    results: [
      {
        title: 'Attention Is All You Need',
        url: 'https://arxiv.org/abs/1706.03762',
        content: 'The dominant sequence transduction models…',
        engine: 'arxiv',
        category: 'science',
        publishedDate: '2017-06-12T17:57:34',
        thumbnail: '',
        score: 3,
      },
      {
        title: 'A blog post about attention',
        url: 'https://example.com/post',
        content: 'Second row.',
        engine: 'brave',
        category: 'general',
        publishedDate: '',
        thumbnail: '',
        score: 1,
      },
    ],
  },
})

describe('fetchWebSearch', () => {
  it('passes the query and flags through to the CLI', async () => {
    const fake = runCapturing(DIGDIG_OK)
    await fetchWebSearch('attention mechanism', {
      command: 'dg',
      timeoutMs: 30_000,
      maxResults: 5,
      categories: 'science',
      lang: 'en',
      timeRange: 'year',
      run: fake.run,
    })
    expect(fake.argv()).toEqual([
      '-f', 'json', '-l', '5', '-c', 'science', '--lang', 'en', '--time', 'year', '--', 'attention mechanism',
    ])
  })

  it('keeps a dash-leading query intact behind the -- separator', async () => {
    const fake = runCapturing(DIGDIG_OK)
    await fetchWebSearch('-l 5 free textbooks', {
      command: 'dg', timeoutMs: 30_000, maxResults: 5, run: fake.run,
    })
    expect(fake.argv().slice(-3)).toEqual(['5', '--', '-l 5 free textbooks'])
  })

  it('parses the ok envelope into entries', async () => {
    const results = await fetchWebSearch('attention', {
      command: 'dg', timeoutMs: 1000, maxResults: 10, run: runCapturing(DIGDIG_OK).run,
    })
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Attention Is All You Need',
      url: 'https://arxiv.org/abs/1706.03762',
      content: 'The dominant sequence transduction models…',
      engine: 'arxiv',
      category: 'science',
      publishedDate: '2017-06-12T17:57:34',
    })
  })

  it('rejects the error envelope with its message', async () => {
    const stderr = JSON.stringify({
      status: 'error', data: null,
      error: { code: 'SEARCH_FAILED', message: 'connect ECONNREFUSED 127.0.0.1:3668' },
    })
    await expect(fetchWebSearch('q', {
      command: 'dg', timeoutMs: 1000, maxResults: 10, run: runCapturing(stderr).run,
    })).rejects.toThrow(/connect ECONNREFUSED/)
  })

  it('rejects a non-JSON stdout with a readable message', async () => {
    await expect(fetchWebSearch('q', {
      command: 'dg', timeoutMs: 1000, maxResults: 10, run: () => Promise.resolve('not json'),
    })).rejects.toThrow(/digdig output was not valid JSON/)
  })

  it('forwards the abort signal to the runner', async () => {
    let seenSignal: AbortSignal | undefined
    const controller = new AbortController()
    await fetchWebSearch('q', {
      command: 'dg', timeoutMs: 1000, maxResults: 10,
      run: (_command, _args, _timeoutMs, signal) => { seenSignal = signal; return Promise.resolve(DIGDIG_OK) },
    }, controller.signal)
    expect(seenSignal).toBe(controller.signal)
  })

  it('rejects an unknown envelope shape', async () => {
    await expect(fetchWebSearch('q', {
      command: 'dg', timeoutMs: 1000, maxResults: 10, run: () => Promise.resolve('{}'),
    })).rejects.toThrow(/unexpected digdig output shape/)
  })
})

describe('createWebSearchTool', () => {
  it('executes through the injected runner and renders entries as text', async () => {
    const tool = createWebSearchTool({ command: 'dg', timeoutMs: 1000, maxResults: 10, run: runCapturing(DIGDIG_OK).run })
    const value = await tool.execute({ query: 'attention', limit: 2 }, { signal: new AbortController().signal } as never) as Record<string, unknown>
    expect(value).toMatchObject({ results: [{ engine: 'arxiv' }, { engine: 'brave' }] })
    const rendered = tool.output?.render?.({}, value)
    expect(String(rendered?.[0]?.text)).toContain('Attention Is All You Need')
  })

  it('rejects a non-positive limit', async () => {
    const tool = createWebSearchTool({ command: 'dg', timeoutMs: 1000, maxResults: 10, run: runCapturing(DIGDIG_OK).run })
    await expect(tool.execute({ query: 'q', limit: 0 }, { signal: new AbortController().signal } as never)).rejects.toThrow('limit must be a positive integer')
  })
})
