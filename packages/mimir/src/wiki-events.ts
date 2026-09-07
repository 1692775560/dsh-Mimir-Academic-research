/**
 * Wiki change push: one in-process hub plus the `/research/events` SSE
 * route. The plugin's apply wiring bridges cordis `domain/changed` (emitted
 * after every durable wiki write) and the ResearchService's file-side
 * notifications (main.tex, bibliography.bib) into the hub; each open panel
 * holds one EventSource connection and re-reads the slices it shows. The
 * stream is one-way — upstream traffic stays on the Remote RPC path.
 * @module dsh-mimir/src/wiki-events
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResearchWikiChangeEvent } from './types.ts'

/** Keep-alive comment cadence; intermediaries drop quieter SSE streams. */
const HEARTBEAT_MS = 30_000

/** Fan-out of wiki change notifications to the connected panels. */
export interface WikiChangeHub {
  /** Broadcast one change to every subscriber; one bad stream never stalls the wiki. */
  readonly publish: (event: ResearchWikiChangeEvent) => void
  /** @param listener - change consumer. @returns the unsubscribe function. */
  readonly subscribe: (listener: (event: ResearchWikiChangeEvent) => void) => () => void
  /** Open subscriber count (route diagnostics and tests). */
  readonly size: () => number
}

/** Build the in-process change hub. */
export function createWikiChangeHub(): WikiChangeHub {
  const listeners = new Set<(event: ResearchWikiChangeEvent) => void>()
  return {
    publish(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch {
          // A broken stream is dropped by its own close handler; the write
          // path that triggered the event must never observe it.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    size: () => listeners.size,
  }
}

/**
 * Build the `/research/events` route handler: one SSE stream per connection,
 * one `data:` frame per change, a heartbeat comment every HEARTBEAT_MS, and
 * unsubscribe on close. Same-origin like the other `/research/*` routes.
 * @param hub - the wiki change hub.
 * @returns the route handler owning the full response lifecycle.
 */
export function createWikiEventsHandler(
  hub: WikiChangeHub,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Reverse proxies (nginx) buffer event streams unless told not to.
      'X-Accel-Buffering': 'no',
    })
    res.write(': research wiki events\n\n')
    const unsubscribe = hub.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    })
    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    const heartbeat = setInterval(() => {
      // A zombie connection (client gone, close not yet fired) must not take
      // the route down: a throwing write drops this stream's subscription.
      try {
        res.write(': ping\n\n')
      } catch {
        cleanup()
      }
    }, HEARTBEAT_MS)
    res.on('error', cleanup)
    req.on('close', cleanup)
  }
}
