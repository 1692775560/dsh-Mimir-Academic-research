/**
 * Behavior tests for the shared project-id path-safety predicate and its
 * enforcement points (#140).
 *
 * `projectRecord.id` is an unconstrained `z.string()` and joins filesystem
 * paths as `meetings/<projectId>/`, so an imported wiki snapshot carrying
 * `projectId: "../../x"` could take a later deck request outside the
 * workspace. The id is now checked at import and at every path join, the same
 * split `isValidArxivId` already uses.
 *
 * Mirrors `arxiv-id.spec.ts`: the predicate, then each place that must apply
 * it.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { isValidProjectId } from '../src/project-id.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import { ResearchService } from '../src/service.ts'
import { meetingDeckPath } from '../src/services/meeting.ts'
import type { ProjectRecord } from '../src/types.ts'

/** The traversal id from the issue, plus its neighbours. */
const TRAVERSAL = '../../x'

describe('isValidProjectId', () => {
  it('accepts the ids this codebase actually generates', () => {
    // `createProject` uses randomUUID; `import-project` uses `slugify`, which
    // emits [a-z0-9-]. Both must keep passing.
    expect(isValidProjectId('3f1c9d0e-2b7a-4c55-9a11-8de0f6b21c34')).toBe(true)
    expect(isValidProjectId('my-imported-paper')).toBe(true)
    expect(isValidProjectId('project')).toBe(true)
    expect(isValidProjectId('p1')).toBe(true)
    expect(isValidProjectId('v1.2_final')).toBe(true)
  })

  it('rejects traversal, absolute paths, separators, and empty input', () => {
    expect(isValidProjectId(TRAVERSAL)).toBe(false)
    expect(isValidProjectId('..')).toBe(false)
    expect(isValidProjectId('a/../b')).toBe(false)
    expect(isValidProjectId('/etc/passwd')).toBe(false)
    expect(isValidProjectId('..\\windows')).toBe(false)
    expect(isValidProjectId('C:/temp')).toBe(false)
    expect(isValidProjectId('')).toBe(false)
    expect(isValidProjectId('some id')).toBe(false)
  })

  it('rejects a plain separator even without traversal', () => {
    // Unlike an arXiv id, a project id is one directory name. A slash is not
    // an escape on its own, but it takes the deck out of the directory the
    // caller named, so it is not a valid id either.
    expect(isValidProjectId('a/b')).toBe(false)
  })
})

/** Boot a service over a memory-backed domain and a fresh temp workspace. */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-project-id-'))
  const service = new ResearchService(ctx, {
    workspaceDir,
    domain,
    latex: { engine: 'auto', timeoutMs: 1000 },
    meetings: { fetchPdf: async () => undefined },
  })
  return { ctx, domain, workspaceDir, service }
}

const UNSAFE_PROJECT: ProjectRecord = {
  id: TRAVERSAL,
  title: 'escaped',
  stage: 'idea',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

describe('project-id enforcement', () => {
  it('meetingDeckPath resolves nothing for a traversal id', () => {
    // The download route's resolver. `file` was already reduced to a
    // basename; the project id was the unchecked half of the same path.
    expect(meetingDeckPath('/workspace', TRAVERSAL, 'deck.pptx')).toBeUndefined()
    expect(meetingDeckPath('/workspace', 'p1', 'deck.pptx')).toBeDefined()
  })

  it('meetingDeckPath stays inside the meetings directory for a valid id', () => {
    const resolved = meetingDeckPath('/workspace', 'p1', 'deck.pptx')
    expect(resolved).toBe(join('/workspace', 'meetings', 'p1', 'deck.pptx'))
  })

  it('generating a deck for a traversal id is refused, not mkdir-ed', async () => {
    const { domain, service } = await harness()
    // Written straight to the table, as a pre-existing bad row would be.
    await domain.table('projects').put(UNSAFE_PROJECT.id, UNSAFE_PROJECT)

    const result = await service.generateMeetingDeck({ projectId: TRAVERSAL, title: 'x' })

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-path' } })
  })

  it('listing decks for a traversal id is refused', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(UNSAFE_PROJECT.id, UNSAFE_PROJECT)

    const result = await service.listMeetingDecks({ projectId: TRAVERSAL })

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-path' } })
  })

  it('deleting a deck under a traversal id is refused', async () => {
    const { domain, service } = await harness()
    await domain.table('projects').put(UNSAFE_PROJECT.id, UNSAFE_PROJECT)

    const result = await service.deleteMeetingDeck({ projectId: TRAVERSAL, file: 'a.pptx' })

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-path' } })
  })

  it('importWiki skips a project row with a path-unsafe id', async () => {
    // The route in the issue: an untrusted snapshot is the thing that can
    // introduce such an id in the first place.
    const { domain, service } = await harness()
    const result = await service.importWiki({
      mode: 'merge',
      snapshot: {
        format: 'mimir-wiki',
        version: 2,
        exportedAt: '2026-08-20T00:00:00.000Z',
        tables: {
          papers: [], ideas: [], claims: [], experiments: [], servers: [], figures: [], events: [],
          projects: [UNSAFE_PROJECT, { ...UNSAFE_PROJECT, id: 'good-project', title: 'fine' }],
        },
      } as never,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.skipped.projects).toBe(1)
    expect(result.value.imported.projects).toBe(1)
    // The unsafe row is not in the table at all, so nothing downstream can
    // reach it even if a later caller forgets to check.
    expect(domain.table('projects').get(TRAVERSAL)).toBeUndefined()
    expect(domain.table('projects').get('good-project')).toBeDefined()
  })

  it('a normal project still generates and lists decks', async () => {
    // The guard must not fire on the ordinary path.
    const { domain, service, workspaceDir } = await harness()
    await domain.table('projects').put('p1', { ...UNSAFE_PROJECT, id: 'p1', title: 'fine' })

    const generated = await service.generateMeetingDeck({ projectId: 'p1', title: 'Weekly' })
    expect(generated.ok).toBe(true)
    if (!generated.ok) return

    const listed = await service.listMeetingDecks({ projectId: 'p1' })
    expect(listed.ok).toBe(true)
    expect(meetingDeckPath(workspaceDir, 'p1', generated.value.file)).toBeDefined()
  })
})
