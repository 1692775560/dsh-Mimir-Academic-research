/**
 * #238: the panel's HTTP routes, driven directly instead of through E2E.
 *
 * Before this, the only thing that exercised a route was an optional E2E run
 * behind `DSH_E2E_URL` — so a 413 limit, a traversal rejection, or a wrong
 * status code could ship with the whole suite green. The handlers now live in
 * `src/routes.ts` and take a `deps` object, which is all a test needs: a fake
 * request, a fake response, and a real temporary workspace.
 *
 * What is asserted is the status code and the effect on disk, not the wording
 * of a message — the messages are for a human reading a failed request.
 */

import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createFigureHandler,
  createFigureUploadHandler,
  createPaperPdfHandler,
  createPdfHandler,
  createTemplateUploadHandler,
} from '../src/routes.ts'
import type { ResearchCommandDeps } from '../src/commands/common.ts'

/** A recording response: captures the status, headers, and body. */
interface Recorded {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

/**
 * Drive one handler with a fake request.
 * @param handler - the route handler under test.
 * @param options - method, url, headers, body chunks, and peer address.
 * @returns the status, headers, and body the handler produced.
 */
async function drive(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  options: {
    method?: string
    url?: string
    headers?: Record<string, string>
    chunks?: readonly string[]
    remoteAddress?: string
  } = {},
): Promise<Recorded> {
  const headers = options.headers ?? {}
  const recorded: { status: number; headers: Record<string, string>; body: string } = {
    status: 0,
    headers: {},
    body: '',
  }
  const res = {
    writeHead(status: number, extra?: Record<string, string>) {
      recorded.status = status
      if (extra !== undefined) Object.assign(recorded.headers, extra)
      return res
    },
    end(chunk?: string) {
      if (chunk !== undefined) recorded.body += chunk
      return res
    },
    write(chunk: string) { recorded.body += chunk; return true },
    on() { return res },
    once() { return res },
    emit() { return true },
    removeListener() { return res },
    destroyed: false,
  } as unknown as ServerResponse

  const chunks = options.chunks ?? []
  const req = {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield Buffer.from(chunk) },
    destroy() {},
  } as unknown as IncomingMessage

  await handler(req, res)
  return recorded
}

/** A minimal deps object: a temp workspace plus a projects table. */
async function harness(projects: readonly { id: string; paperDir?: string }[] = []): Promise<{
  deps: ResearchCommandDeps
  root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'mimir-routes-'))
  const table = new Map(projects.map(p => [p.id, { id: p.id, paperDir: p.paperDir ?? 'paper' }]))
  const deps = {
    workspaceDir: root,
    domain: { table: () => ({ get: (id: string) => table.get(id) }) },
  } as unknown as ResearchCommandDeps
  return { deps, root }
}

/** The loopback headers a panel read carries. */
const LOOPBACK_READ = { host: '127.0.0.1:3080' }
/** The same-origin headers a panel write carries. */
const SAME_ORIGIN_WRITE = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }

const created: string[] = []
afterEach(() => { created.length = 0 })

describe('pdf route (#238)', () => {
  it('streams a compiled paper as application/pdf', async () => {
    const { deps, root } = await harness([{ id: 'proj' }])
    await mkdir(join(root, 'paper'), { recursive: true })
    await writeFile(join(root, 'paper', 'main.pdf'), '%PDF-1.4 fake')
    const recorded = await drive(createPdfHandler(deps), {
      url: '/research/pdf/proj', headers: LOOPBACK_READ,
    })
    expect(recorded.status).toBe(200)
    expect(recorded.headers['Content-Type']).toBe('application/pdf')
    expect(recorded.headers['X-Content-Type-Options']).toBe('nosniff')
  })

  it('answers 404 when the paper was never compiled', async () => {
    const { deps } = await harness([{ id: 'proj' }])
    const recorded = await drive(createPdfHandler(deps), {
      url: '/research/pdf/proj', headers: LOOPBACK_READ,
    })
    expect(recorded.status).toBe(404)
    expect(recorded.body).toMatch(/compile first/)
  })

  it('answers 404 for an unknown project and 400 for a traversal-shaped dir', async () => {
    const { deps } = await harness([{ id: 'proj' }])
    expect((await drive(createPdfHandler(deps), {
      url: '/research/pdf/nope', headers: LOOPBACK_READ,
    })).status).toBe(404)
    expect((await drive(createPdfHandler(deps), {
      url: '/research/pdf/proj?dir=../../etc', headers: LOOPBACK_READ,
    })).status).toBe(400)
  })

  it('answers 405 for a write method and 403 for a non-loopback peer', async () => {
    const { deps } = await harness([{ id: 'proj' }])
    expect((await drive(createPdfHandler(deps), {
      method: 'POST', url: '/research/pdf/proj', headers: LOOPBACK_READ,
    })).status).toBe(405)
    expect((await drive(createPdfHandler(deps), {
      url: '/research/pdf/proj', headers: LOOPBACK_READ, remoteAddress: '10.0.0.5',
    })).status).toBe(403)
  })

  it('refuses a main.pdf that is a symlink out of the paper directory', async () => {
    const { deps, root } = await harness([{ id: 'proj' }])
    await mkdir(join(root, 'paper'), { recursive: true })
    const outside = await mkdtemp(join(tmpdir(), 'mimir-routes-outside-'))
    created.push(outside)
    await writeFile(join(outside, 'secret.pdf'), '%PDF-1.4 secret')
    await symlink(join(outside, 'secret.pdf'), join(root, 'paper', 'main.pdf'))
    const recorded = await drive(createPdfHandler(deps), {
      url: '/research/pdf/proj', headers: LOOPBACK_READ,
    })
    expect(recorded.status).toBe(400)
    expect(recorded.body).toMatch(/escapes/)
  })
})

describe('figure route (#238)', () => {
  it('serves an svg with the pinning headers that stop it acting as our page', async () => {
    const { deps, root } = await harness([{ id: 'proj' }])
    await mkdir(join(root, 'paper', 'figures'), { recursive: true })
    await writeFile(join(root, 'paper', 'figures', 'plot.svg'), '<svg/>')
    const recorded = await drive(createFigureHandler(deps), {
      url: '/research/figure/proj?path=figures/plot.svg', headers: LOOPBACK_READ,
    })
    expect(recorded.status).toBe(200)
    expect(recorded.headers['Content-Type']).toBe('image/svg+xml')
    expect(recorded.headers['Content-Security-Policy']).toBe("default-src 'none'; sandbox")
  })

  it('rejects a path outside the figure whitelist, and one that climbs out', async () => {
    const { deps, root } = await harness([{ id: 'proj' }])
    await mkdir(join(root, 'paper', 'figures'), { recursive: true })
    await writeFile(join(root, 'paper', 'figures', 'notes.txt'), 'x')
    expect((await drive(createFigureHandler(deps), {
      url: '/research/figure/proj?path=figures/notes.txt', headers: LOOPBACK_READ,
    })).status).toBe(400)
    // `isFigureFile` is an extension check, not a shape check, so a traversal
    // that keeps a figure extension gets past it — and is then stopped by the
    // containment guard or, if the file really is absent, reported as missing.
    // Either way it never serves bytes from outside the directory.
    const climbed = await drive(createFigureHandler(deps), {
      url: '/research/figure/proj?path=../paper/main.pdf', headers: LOOPBACK_READ,
    })
    expect([400, 404]).toContain(climbed.status)
  })

  it('answers 404 for a figure that is not there', async () => {
    const { deps } = await harness([{ id: 'proj' }])
    expect((await drive(createFigureHandler(deps), {
      url: '/research/figure/proj?path=figures/missing.png', headers: LOOPBACK_READ,
    })).status).toBe(404)
  })
})

describe('figure upload route (#238)', () => {
  it('writes the body under figures/ and reports the relative path', async () => {
    const { deps, root } = await harness([{ id: 'proj' }])
    const recorded = await drive(createFigureUploadHandler(deps), {
      method: 'POST',
      url: '/research/figure-upload?project=proj&name=plot.png',
      headers: SAME_ORIGIN_WRITE,
      chunks: ['png-bytes'],
    })
    expect(recorded.status).toBe(200)
    expect(JSON.parse(recorded.body)).toEqual({ relPath: 'figures/plot.png' })
    expect(await readFile(join(root, 'paper', 'figures', 'plot.png'), 'utf8')).toBe('png-bytes')
  })

  it('refuses a cross-origin write', async () => {
    const { deps } = await harness([{ id: 'proj' }])
    const recorded = await drive(createFigureUploadHandler(deps), {
      method: 'POST',
      url: '/research/figure-upload?project=proj&name=plot.png',
      headers: { host: '127.0.0.1:3080', origin: 'http://attacker.test' },
      chunks: ['x'],
    })
    expect(recorded.status).toBe(403)
  })

  it('answers 405 for a read method, 400 without a project, 404 for an unknown one', async () => {
    const { deps } = await harness([{ id: 'proj' }])
    expect((await drive(createFigureUploadHandler(deps), {
      url: '/research/figure-upload?project=proj&name=plot.png', headers: LOOPBACK_READ,
    })).status).toBe(405)
    expect((await drive(createFigureUploadHandler(deps), {
      method: 'POST', url: '/research/figure-upload?name=plot.png', headers: SAME_ORIGIN_WRITE,
    })).status).toBe(400)
    expect((await drive(createFigureUploadHandler(deps), {
      method: 'POST', url: '/research/figure-upload?project=nope&name=plot.png', headers: SAME_ORIGIN_WRITE,
    })).status).toBe(404)
  })

  it('rejects a name outside the figure whitelist and reduces a path to its basename', async () => {
    const { deps } = await harness([{ id: 'proj' }])
    expect((await drive(createFigureUploadHandler(deps), {
      method: 'POST', url: '/research/figure-upload?project=proj&name=evil.sh', headers: SAME_ORIGIN_WRITE,
    })).status).toBe(400)
    // `basename` means a traversal in the name cannot choose the directory.
    const recorded = await drive(createFigureUploadHandler(deps), {
      method: 'POST',
      url: '/research/figure-upload?project=proj&name=../../etc/plot.png',
      headers: SAME_ORIGIN_WRITE,
      chunks: ['x'],
    })
    expect(recorded.status).toBe(200)
    expect(JSON.parse(recorded.body)).toEqual({ relPath: 'figures/plot.png' })
  })

  it('answers 413 when the body exceeds the raw-body cap', async () => {
    const { deps } = await harness([{ id: 'proj' }])
    // 51 MB in one chunk: over FIGURE_UPLOAD_LIMIT_BYTES without allocating it twice.
    const oversized = 'x'.repeat(51 * 1024 * 1024)
    const recorded = await drive(createFigureUploadHandler(deps), {
      method: 'POST',
      url: '/research/figure-upload?project=proj&name=plot.png',
      headers: SAME_ORIGIN_WRITE,
      chunks: [oversized],
    })
    expect(recorded.status).toBe(413)
    expect(recorded.body).toMatch(/50MB/)
  })
})

describe('template upload route (#238)', () => {
  it('writes a venue-kit file under template/ and reports the relative path', async () => {
    const { deps, root } = await harness([{ id: 'proj' }])
    const recorded = await drive(createTemplateUploadHandler(deps), {
      method: 'POST',
      url: '/research/template-upload?project=proj&name=custom.cls',
      headers: SAME_ORIGIN_WRITE,
      chunks: ['\\NeedsTeXFormat{LaTeX2e}'],
    })
    expect(recorded.status).toBe(200)
    expect(JSON.parse(recorded.body)).toEqual({ relPath: 'template/custom.cls' })
    expect(await readFile(join(root, 'paper', 'template', 'custom.cls'), 'utf8'))
      .toBe('\\NeedsTeXFormat{LaTeX2e}')
  })

  it('rejects an extension that is not a plain kit file', async () => {
    const { deps } = await harness([{ id: 'proj' }])
    for (const name of ['payload.exe', 'archive.zip', 'run.sh']) {
      expect((await drive(createTemplateUploadHandler(deps), {
        method: 'POST',
        url: `/research/template-upload?project=proj&name=${name}`,
        headers: SAME_ORIGIN_WRITE,
        chunks: ['x'],
      })).status).toBe(400)
    }
  })

  it('refuses a cross-origin write and answers 405 for a read method', async () => {
    const { deps } = await harness([{ id: 'proj' }])
    expect((await drive(createTemplateUploadHandler(deps), {
      method: 'POST',
      url: '/research/template-upload?project=proj&name=custom.cls',
      headers: { host: '127.0.0.1:3080', origin: 'http://attacker.test' },
      chunks: ['x'],
    })).status).toBe(403)
    expect((await drive(createTemplateUploadHandler(deps), {
      url: '/research/template-upload?project=proj&name=custom.cls', headers: LOOPBACK_READ,
    })).status).toBe(405)
  })
})

describe('paper pdf route (#238)', () => {
  it('serves a fetched paper by its arXiv id and 404s an unknown one', async () => {
    const { deps, root } = await harness()
    await mkdir(join(root, 'papers'), { recursive: true })
    await writeFile(join(root, 'papers', '2103.00020.pdf'), '%PDF-1.4 paper')
    const table = new Map([
      ['2103.00020', { id: '2103.00020', pdfPath: 'papers/2103.00020.pdf' }],
    ])
    ;(deps as unknown as { domain: { table: (name: string) => { get: (id: string) => unknown } } }).domain = {
      table: (name: string) => (name === 'papers'
        ? { get: (id: string) => table.get(id) }
        : { get: () => undefined }),
    }
    const ok = await drive(createPaperPdfHandler(deps), {
      url: '/research/paper-pdf/2103.00020', headers: LOOPBACK_READ,
    })
    expect(ok.status).toBe(200)
    expect(ok.headers['Content-Type']).toBe('application/pdf')
    expect((await drive(createPaperPdfHandler(deps), {
      url: '/research/paper-pdf/9999.99999', headers: LOOPBACK_READ,
    })).status).toBe(404)
  })

  it('refuses a stored pdfPath that escapes the workspace', async () => {
    const { deps, root } = await harness()
    const table = new Map([['2103.00020', { id: '2103.00020', pdfPath: '../outside.pdf' }]])
    ;(deps as unknown as { domain: { table: (name: string) => { get: (id: string) => unknown } } }).domain = {
      table: (name: string) => (name === 'papers'
        ? { get: (id: string) => table.get(id) }
        : { get: () => undefined }),
    }
    await writeFile(join(root, '..', 'outside.pdf'), '%PDF-1.4 outside').catch(() => undefined)
    const recorded = await drive(createPaperPdfHandler(deps), {
      url: '/research/paper-pdf/2103.00020', headers: LOOPBACK_READ,
    })
    expect(recorded.status).toBe(400)
  })
})
