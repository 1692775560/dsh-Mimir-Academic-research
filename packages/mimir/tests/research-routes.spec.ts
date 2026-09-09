/** Integration tests for the PDF and figure HTTP routes registered by apply(). */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { apply, type Config } from '../src/index.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import type { ProjectRecord } from '../src/types.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

interface CapturedRoute {
  readonly path: string
  readonly handler: RouteHandler
}

class ResponseRecorder {
  statusCode: number | undefined
  headers: OutgoingHttpHeaders | undefined
  body = ''

  writeHead(statusCode: number, headers?: OutgoingHttpHeaders): this {
    this.statusCode = statusCode
    this.headers = headers
    return this
  }

  end(chunk?: string | Uint8Array): this {
    this.body = typeof chunk === 'string' ? chunk : chunk === undefined ? '' : new TextDecoder().decode(chunk)
    return this
  }
}

const PROJECT: ProjectRecord = {
  id: 'p1',
  title: 'Project',
  stage: 'writing',
  artifacts: [],
  reviewRounds: 0,
  updatedAt: '2026-08-20T00:00:00.000Z',
}

async function bootRoutes(): Promise<{
  readonly routes: ReadonlyMap<string, RouteHandler>
  readonly domain: Awaited<ReturnType<DomainFacility['open']>>
  readonly workspaceDir: string
}> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)

  const routes = new Map<string, RouteHandler>()
  ctx.provide('webServer', {
    register: (route: CapturedRoute) => {
      routes.set(route.path, route.handler)
      return () => {}
    },
  })
  let domain: Awaited<ReturnType<DomainFacility['open']>> | undefined
  ctx.provide('storageDomain', {
    open: async (spec: typeof researchWikiDomainSpec) => {
      domain = await facility.open(spec)
      return domain
    },
  } as unknown as DomainFacility)

  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-research-routes-'))
  await apply(ctx, {
    workspaceDir,
    latex: { engine: 'auto', timeoutMs: 1000 },
    backup: { enabled: false },
    subscriptions: { enabled: false },
    skills: { enabled: false },
  } satisfies Config)
  if (domain === undefined) throw new Error('research domain never opened')
  return { routes, domain, workspaceDir }
}

function request(url: string): IncomingMessage {
  return { method: 'HEAD', url } as IncomingMessage
}

describe('research PDF and figure routes', () => {
  it('turns malformed project ids into 400 responses on both routes', async () => {
    const { routes } = await bootRoutes()
    const pdfResponse = new ResponseRecorder()
    const figureResponse = new ResponseRecorder()

    await expect(routes.get('/research/pdf')!(request('/research/pdf/%'), pdfResponse as unknown as ServerResponse))
      .resolves.toBeUndefined()
    await expect(routes.get('/research/figure')!(request('/research/figure/%'), figureResponse as unknown as ServerResponse))
      .resolves.toBeUndefined()

    expect(pdfResponse.statusCode).toBe(400)
    expect(figureResponse.statusCode).toBe(400)
  })

  it('no route throws on malformed percent-encoding; every one answers 4xx, never 500 (#211)', async () => {
    const { routes } = await bootRoutes()
    // Every route taking a path or query parameter, fed an illegal `%`
    // sequence in each parameter position. The SSE events route takes no
    // parameter at all (verified by inspection — it never decodes).
    const cases: readonly [route: string, url: string, expected: number][] = [
      ['/research/pdf', '/research/pdf/%zz', 400],
      ['/research/paper-pdf', '/research/paper-pdf/%zz', 400],
      ['/research/figure', '/research/figure/%zz', 400],
      ['/research/meeting', '/research/meeting?project=%zz&file=%zz', 404],
      ['/research/figure-upload', '/research/figure-upload?project=%zz&name=%zz', 405],
      ['/research/template-upload', '/research/template-upload?project=%zz&name=%zz', 405],
    ]
    for (const [route, url, expected] of cases) {
      const handler = routes.get(route)
      expect(handler, `route ${route} registered`).toBeDefined()
      const response = new ResponseRecorder()
      await expect(handler!(request(url), response as unknown as ServerResponse), url)
        .resolves.toBeUndefined()
      expect(response.statusCode, url).toBe(expected)
      expect(response.statusCode, url).toBeLessThan(500)
    }
  })

  it('adds defensive headers to compiled PDF responses', async () => {
    const { routes, domain, workspaceDir } = await bootRoutes()
    await domain.table('projects').put(PROJECT.id, PROJECT)
    await mkdir(join(workspaceDir, 'paper'), { recursive: true })
    await writeFile(join(workspaceDir, 'paper', 'main.pdf'), '%PDF-1.7')
    const response = new ResponseRecorder()

    await routes.get('/research/pdf')!(request('/research/pdf/p1'), response as unknown as ServerResponse)

    expect(response.statusCode).toBe(200)
    expect(response.headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    })
  })
})
