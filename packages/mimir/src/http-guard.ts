/**
 * One error boundary for every panel HTTP route (#209).
 *
 * A route handler owns its whole response lifecycle. The host's HTTP carrier
 * does not serialize our failures for us: it `await`s the handler and, on a
 * throw, writes `400` if nothing was sent yet or destroys the socket if
 * something was. So an I/O failure that escapes a handler reaches the browser
 * as the status for a *bad request*, with a body the route never wrote — and
 * nothing tells the caller what actually happened.
 *
 * There are two ways a route can fail after its guards have passed, and they
 * need two different mechanisms because only one of them is catchable:
 *
 * 1. **A rejected promise.** `for await (const chunk of req)` rejects when a
 *    client disappears mid-body; `mkdir`/`writeFile` reject on a bad
 *    destination. {@link guardRoute} catches these at the registration seam.
 * 2. **An `'error'` event on a stream.** `createReadStream(p).pipe(res)` reports
 *    a file that vanished between the route's `stat` and the stream's `open` as
 *    an event, which no `try/catch` around the handler can see — with no
 *    listener it becomes an uncaught exception on the process.
 *    {@link streamToResponse} is the only place that pipes, so it is the only
 *    place that has to listen.
 *
 * Both funnel into {@link failRequest}, which keeps the status and the body
 * fixed. The body is a constant on purpose: an I/O error's `message` carries
 * absolute paths and errno names, and the panel is a browser surface.
 *
 * @module dsh-mimir/src/http-guard
 */

import type { ReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The fixed 5xx body. Never the filesystem's own words (#209).
 *
 * A route that fails after its guards has nothing useful to tell a browser:
 * the caller cannot act on `EACCES` or on a workspace path, and both leak the
 * deployment's layout.
 */
export const INTERNAL_FAILURE_COPY = 'the research route could not complete this request'

/** The shape a route handler has once registered with the host. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/**
 * End a request that failed unexpectedly (#209).
 *
 * `500`, not the carrier's fallback `400`: the request was well formed and the
 * *work* failed, which is a different thing to say. Once headers are out the
 * status is committed and cannot be revised, so the honest close is
 * `destroy()` — the same thing the carrier does, but decided here where the
 * route's own contract is still in view.
 * @param res - The response owning this request's lifecycle.
 */
export function failRequest(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(500).end(INTERNAL_FAILURE_COPY)
}

/**
 * Hand a file to the response without letting a stream error escape (#209).
 *
 * The listener is attached *before* the pipe so a failure that fires
 * immediately (the missing-file case emits on the next tick) cannot slip
 * between the two calls.
 * @param stream - The file stream to forward.
 * @param res - The response owning this request's lifecycle.
 */
export function streamToResponse(stream: ReadStream, res: ServerResponse): void {
  stream.on('error', () => {
    failRequest(res)
  })
  stream.pipe(res)
}

/**
 * Wrap a route so a rejection ends the response instead of escaping (#209).
 *
 * Applied at the registration seam rather than inside each handler: the
 * boundary is the same for every route, and a handler that forgets it is
 * exactly the bug this exists to prevent. The wrapper never swallows an
 * already-resolved answer — a route that returned normally is untouched, and
 * one that already wrote a status falls through to `failRequest`'s
 * `headersSent` branch.
 * @param handler - The route handler to protect.
 * @returns a handler with the same signature that cannot reject.
 */
export function guardRoute(handler: RouteHandler): RouteHandler {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch {
      failRequest(res)
    }
  }
}
