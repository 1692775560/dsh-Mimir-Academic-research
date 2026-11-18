/**
 * Behavior tests for the server-organization helpers behind the servers
 * view's filter bar: collecting the deduped tag list and filtering by one
 * tag.
 */

import { describe, expect, it } from 'vitest'
import type { ServerView } from 'dsh-mimir/types'
import { collectServerTags, filterServers } from '../src/client/view-common.ts'

/**
 * One server fixture; only the fields the helpers read differ. The helpers take
 * `ServerView` — the record minus the password plus `hasPassword` — so the
 * fixture has to be that view, not the stored record. Key auth, hence `false`.
 */
function server(id: string, tags: string[]): ServerView {
  return {
    id, name: id, host: '10.0.0.1', port: 22, username: '', note: '',
    tags, hasPassword: false,
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
  }
}

const SERVERS = [
  server('srv-a', ['gpu-cluster', 'dev']),
  server('srv-b', ['gpu-cluster']),
  server('srv-c', []),
]

describe('collectServerTags', () => {
  it('collects the deduped, alphabetically sorted tag list', () => {
    expect(collectServerTags(SERVERS)).toEqual(['dev', 'gpu-cluster'])
    expect(collectServerTags([])).toEqual([])
    expect(collectServerTags([server('srv-x', [])])).toEqual([])
  })
})

describe('filterServers', () => {
  it('passes everything when the selector is null', () => {
    expect(filterServers(SERVERS, null)).toHaveLength(3)
  })

  it('filters by one tag; a tag nobody carries is empty, not an error', () => {
    expect(filterServers(SERVERS, 'gpu-cluster').map(s => s.id)).toEqual(['srv-a', 'srv-b'])
    expect(filterServers(SERVERS, 'dev').map(s => s.id)).toEqual(['srv-a'])
    expect(filterServers(SERVERS, 'windows')).toEqual([])
  })
})
