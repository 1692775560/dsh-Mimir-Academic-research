/**
 * Behavior tests for the wiki change push: the hub's fan-out and failure
 * isolation, and the SSE route's headers, frames, heartbeat, and close
 * cleanup. Request/response are minimal fakes — the handler only touches
 * method, writeHead/write/end, and the close event.
 */

import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { createWikiChangeHub, createWikiEventsHandler } from '../src/wiki-events.ts'
import type { ResearchWikiChangeEvent } from '../src/types.ts'

const CHANGE: ResearchWikiChangeEvent = { table: 'papers', key: '2608.00001v1', operation: 'put' }

/** One fake GET request (an EventEmitter for the close event). */
function fakeReq(method = 'GET'): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  req.method = method
  // The route is loopback-panel-only (#210): fake the panel's own request.
  req.headers = { host: 'localhost:3080' }
  return req
}

/** One fake response capturing headers and frames. */
function fakeRes(): ServerResponse & { readonly status: () => number | undefined; readonly body: () => string } {
  let status: number | undefined
  let body = ''
  const emitter = new EventEmitter()
  const res = {
    writeHead(code: number) { status = code; return res },
    write(chunk: string) { body += chunk; return true },
    end() { return res },
    on: emitter.on.bind(emitter),
    status: () => status,
    body: () => body,
  }
  return res as unknown as ServerResponse & { status: () => number | undefined; body: () => string }
}

describe('createWikiChangeHub', () => {
  it('fans one change out to every subscriber and unsubscribes cleanly', () => {
    const hub = createWikiChangeHub()
    const seen: ResearchWikiChangeEvent[][] = [[], []]
    const offA = hub.subscribe(event => seen[0]?.push(event))
    hub.subscribe(event => seen[1]?.push(event))
    expect(hub.size()).toBe(2)
    hub.publish(CHANGE)
    hub.publish({ table: 'experiments', key: 'e1', operation: 'deleted' })
    expect(seen[0]).toHaveLength(2)
    expect(seen[1]).toHaveLength(2)
    offA()
    expect(hub.size()).toBe(1)
    hub.publish(CHANGE)
    expect(seen[0]).toHaveLength(2)
    expect(seen[1]).toHaveLength(3)
  })

  it('isolates a throwing subscriber from the publisher and the others', () => {
    const hub = createWikiChangeHub()
    const seen: ResearchWikiChangeEvent[] = []
    hub.subscribe(() => { throw new Error('broken stream') })
    hub.subscribe(event => seen.push(event))
    expect(() => hub.publish(CHANGE)).not.toThrow()
    expect(seen).toEqual([CHANGE])
  })
})

describe('createWikiEventsHandler', () => {
  it('rejects non-GET requests', () => {
    const handler = createWikiEventsHandler(createWikiChangeHub())
    const res = fakeRes()
    handler(fakeReq('POST'), res)
    expect(res.status()).toBe(405)
  })

  it('opens an SSE stream, frames each change, and unsubscribes on close', () => {
    vi.useFakeTimers()
    try {
      const hub = createWikiChangeHub()
      const handler = createWikiEventsHandler(hub)
      const req = fakeReq()
      const res = fakeRes()
      handler(req, res)
      expect(res.status()).toBe(200)
      expect(hub.size()).toBe(1)
      hub.publish(CHANGE)
      expect(res.body()).toContain('data: {"table":"papers","key":"2608.00001v1","operation":"put"}\n\n')
      // The heartbeat keeps intermediaries from dropping the quiet stream.
      vi.advanceTimersByTime(31_000)
      expect(res.body()).toContain(': ping\n\n')
      req.emit('close')
      expect(hub.size()).toBe(0)
      hub.publish(CHANGE)
      const frames = res.body().match(/data: /g)
      expect(frames).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the subscription when a heartbeat write throws (zombie connection)', () => {
    vi.useFakeTimers()
    try {
      const hub = createWikiChangeHub()
      const handler = createWikiEventsHandler(hub)
      const res = fakeRes()
      handler(fakeReq(), res)
      expect(hub.size()).toBe(1)
      // The socket dies silently: the next heartbeat write throws, and the
      // route must drop the stream instead of leaking the subscription.
      vi.spyOn(res, 'write').mockImplementation(() => { throw new Error('socket destroyed') })
      vi.advanceTimersByTime(31_000)
      expect(hub.size()).toBe(0)
      // The interval is disarmed too: advancing further changes nothing.
      vi.advanceTimersByTime(60_000)
      expect(hub.size()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
