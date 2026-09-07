/**
 * Security boundaries shared by browser-originated write routes.
 * @module dsh-mimir/src/http-write-boundary
 */

import type { IncomingHttpHeaders } from 'node:http'
import { resolvePaperDir } from './paper-source.ts'

/** Whether a browser write request originated from the same web-server origin. */
export function isSameOriginWrite(headers: IncomingHttpHeaders): boolean {
  const origin = headers.origin
  const host = headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/** Resolve a write destination only from the target project's configured paper directory. */
export function projectPaperDir(workspaceDir: string, paperDir: string | undefined): string | undefined {
  return resolvePaperDir(workspaceDir, undefined, paperDir)
}
