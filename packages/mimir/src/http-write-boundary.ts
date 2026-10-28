/**
 * Security boundaries shared by browser-originated routes (#210).
 *
 * THE PERMISSION MODEL. Write routes (uploads) require a loopback `Host`
 * header plus an exact same-origin `Origin` ({@link isSameOriginWrite}): the
 * loopback Host whitelist is the DNS-rebinding defense — on a rebound request
 * Origin==Host passes trivially (both name the attacker), so the Host must
 * independently name the loopback listener. Read/download routes (compiled
 * PDF, paper PDF, figure, meeting deck, SSE events) are LOOPBACK-PANEL-ONLY:
 * the `Host` header must name the loopback listener, and an `Origin` header,
 * when present (a cross-origin fetch always carries one), must match that
 * Host exactly ({@link isTrustedRead}). This holds under DNS rebinding (the
 * rebound request carries the attacker's host name, not a loopback one) and
 * refuses cross-site reads. Plain same-origin navigations and embeds — the
 * panel's `<img>`/`<iframe>`/`<a>` GETs — carry no `Origin` and pass on the
 * Host check. Deployment boundary: when dsh is exposed through a reverse
 * proxy or LAN bind, these routes stay loopback-only by design; expose them
 * remotely only behind an authenticating proxy that rewrites `Host` to the
 * loopback listener.
 * @module dsh-mimir/src/http-write-boundary
 */

import type { IncomingHttpHeaders } from 'node:http'
import { resolvePaperDir } from './paper-source.ts'

/** Host names the loopback listener may present as (any port). */
const LOOPBACK_HOST_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The host name of one `Host` header value, port stripped, IPv6 brackets kept. */
function hostNameOf(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host.toLowerCase() : host.slice(0, end + 1).toLowerCase()
  }
  return (host.split(':')[0] ?? '').toLowerCase()
}

/**
 * Whether the `Host` header names the loopback listener (any port). The
 * shared first gate of the read AND the write boundary: under DNS rebinding
 * the rebound request carries the attacker's host name, and an Origin==Host
 * comparison alone passes trivially there (both name the attacker), so the
 * loopback Host whitelist is what actually confines these routes.
 */
function isLoopbackHost(headers: IncomingHttpHeaders): boolean {
  const host = headers.host
  return typeof host === 'string' && LOOPBACK_HOST_NAMES.has(hostNameOf(host))
}

/**
 * Whether a browser write request originated from the loopback panel: the
 * `Host` names the loopback listener AND the `Origin` header matches it
 * exactly. The Host whitelist is the DNS-rebinding defense (a rebound write
 * would carry matching attacker names in both headers otherwise).
 */
export function isSameOriginWrite(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin
  const host = headers.host
  if (typeof origin !== 'string' || typeof host !== 'string' || !isLoopbackHost(headers)) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/**
 * Whether a read (GET/HEAD) of a workspace download route is authorized
 * (#210): the `Host` names the loopback listener, and an `Origin`, when
 * present, matches it exactly (same rule as {@link isSameOriginWrite}).
 * @param headers - the incoming request headers.
 * @returns whether the read may proceed.
 */
export function isTrustedRead(headers: IncomingHttpHeaders): boolean {
  if (!isLoopbackHost(headers)) return false
  if (headers.origin === undefined) return true
  return isSameOriginWrite(headers)
}

/** Resolve a write destination only from the target project's configured paper directory. */
export function projectPaperDir(workspaceDir: string, paperDir: string | undefined): string | undefined {
  return resolvePaperDir(workspaceDir, undefined, paperDir)
}
