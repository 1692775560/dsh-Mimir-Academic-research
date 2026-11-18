/**
 * The route error boundary (#209).
 *
 * Two failure modes, two mechanisms — this file drives both with real objects
 * rather than fakes where it can:
 *
 *   - a stream error is a *real* `ENOENT` from `createReadStream` on a path that
 *     never existed, and a *real* `EACCES`-shaped failure is unnecessary: the
 *     event path is the same and `ENOENT` is the one a route actually races
 *     (`stat` succeeded, then the file went away);
 *   - a rejected handler is a *real* rejected promise.
 *
 * The response is a real `Writable`, because `stream.pipe(res)` requires one —
 * a plain object with `write`/`end` methods would make `.pipe` throw for a
 * reason unrelated to what is under test.
 *
 * @module dsh-mimir/tests/http-guard
 */

import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INTERNAL_FAILURE_COPY,
  failRequest,
  guardRoute,
  streamToResponse,
} from '../src/http-guard.ts'

const scratchDirs: string[] = []

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A response that records what a route told it, as a real Writable. */
class FakeResponse extends Writable {
  status = 0
  readonly headers: Record<string, string> = {}
  readonly chunks: Buffer[] = []
  destroyedByBoundary = false

  // `autoDestroy` would close the stream after `finish` on its own, which would
  // make `destroyedByBoundary` mean "the write finished" instead of "the
  // boundary had to destroy it".
  constructor() {
    super({ autoDestroy: false })
  }

  get headersSent(): boolean {
    return this.status !== 0
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status
    if (headers !== undefined) Object.assign(this.headers, headers)
    return this
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    done()
  }

  override destroy(): this {
    this.destroyedByBoundary = true
    return super.destroy()
  }
}

async function scratchFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mimir-guard-'))
  scratchDirs.push(dir)
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}

describe('a stream error becomes a response (#209)', () => {
  it('answers a fixed 500 when the file is gone before the stream opens', async () => {
    const missing = join(tmpdir(), 'mimir-guard-does-not-exist.pdf')
    const res = new FakeResponse()

    streamToResponse(createReadStream(missing), res as unknown as ServerResponse)
    await once(res, 'finish')

    expect(res.status).toBe(500)
    expect(res.body).toBe(INTERNAL_FAILURE_COPY)
    // The whole point: the browser never learns the path or the errno.
    expect(res.body).not.toContain(missing)
    expect(res.body).not.toContain('ENOENT')
    expect(res.body).not.toContain(tmpdir())
  })

  it('destroys instead of rewriting a status that is already out', async () => {
    const missing = join(tmpdir(), 'mimir-guard-does-not-exist.pdf')
    const res = new FakeResponse()
    res.writeHead(200, { 'Content-Type': 'application/pdf' })

    streamToResponse(createReadStream(missing), res as unknown as ServerResponse)
    await once(res, 'close')

    expect(res.status).toBe(200)
    expect(res.destroyedByBoundary).toBe(true)
    expect(res.body).not.toContain('ENOENT')
  })

  it('streams a readable file through untouched', async () => {
    const path = await scratchFile('deck.pptx', 'pptx-bytes')
    const res = new FakeResponse()
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })

    streamToResponse(createReadStream(path), res as unknown as ServerResponse)
    await once(res, 'finish')

    expect(res.status).toBe(200)
    expect(res.body).toBe('pptx-bytes')
    expect(res.destroyedByBoundary).toBe(false)
  })
})

describe('a rejected handler becomes a response (#209)', () => {
  const req = {} as IncomingMessage

  it('answers a fixed 500 when the handler rejects', async () => {
    const res = new FakeResponse()
    const guarded = guardRoute(async () => {
      throw new Error('EEXIST: mkdir /Users/someone/private/workspace/figures')
    })

    await guarded(req, res as unknown as ServerResponse)

    expect(res.status).toBe(500)
    expect(res.body).toBe(INTERNAL_FAILURE_COPY)
    expect(res.body).not.toContain('EEXIST')
    expect(res.body).not.toContain('/Users/')
  })

  it('leaves a handler that resolved alone', async () => {
    const res = new FakeResponse()
    const guarded = guardRoute((_req, response) => {
      response.writeHead(405).end()
    })

    await guarded(req, res as unknown as ServerResponse)

    expect(res.status).toBe(405)
    expect(res.body).toBe('')
    expect(res.destroyedByBoundary).toBe(false)
  })

  it('destroys rather than rewriting a status the handler already sent', async () => {
    const res = new FakeResponse()
    const guarded = guardRoute((_req, response) => {
      response.writeHead(200, { 'Content-Type': 'application/pdf' })
      throw new Error('write EPIPE')
    })

    await guarded(req, res as unknown as ServerResponse)

    expect(res.status).toBe(200)
    expect(res.destroyedByBoundary).toBe(true)
  })

  it('never rejects, whatever the handler does', async () => {
    const res = new FakeResponse()
    const guarded = guardRoute(() => {
      throw new TypeError('sync throw, not a rejection')
    })
    await expect(guarded(req, res as unknown as ServerResponse)).resolves.toBeUndefined()
    expect(res.status).toBe(500)
  })
})

describe('the boundary keeps its copy fixed (#209)', () => {
  it('answers the same sentence for both failure modes', async () => {
    const fromRejection = new FakeResponse()
    await guardRoute(() => {
      throw new Error('one')
    })({} as IncomingMessage, fromRejection as unknown as ServerResponse)

    const fromStream = new FakeResponse()
    streamToResponse(createReadStream(join(tmpdir(), 'mimir-guard-absent.pdf')), fromStream as unknown as ServerResponse)
    await once(fromStream, 'finish')

    expect(fromRejection.body).toBe(fromStream.body)
    expect(INTERNAL_FAILURE_COPY).toBe('the research route could not complete this request')
  })

  it('is a 500 for a body-less failure too', () => {
    const res = new FakeResponse()
    failRequest(res as unknown as ServerResponse)
    expect(res.status).toBe(500)
    expect(res.body).toBe(INTERNAL_FAILURE_COPY)
  })
})

describe('every route is registered through the boundary (#209)', () => {
  it('wraps every handler and routes every stream through the helper', async () => {
    // The handlers live in `routes.ts` (#238) and the registrations in
    // `index.ts`; the seam spans both, so both are read.
    const registrations = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const handlers = await readFile(new URL('../src/routes.ts', import.meta.url), 'utf8')
    // A new route that forgets the boundary is exactly the bug this exists to
    // prevent, so the seam is counted rather than assumed.
    const wired = registrations.match(/handler: [^,]+?\(/g) ?? []
    expect(wired).toHaveLength(7)
    expect(registrations.match(/handler: guardRoute\(/g) ?? []).toHaveLength(wired.length)
    // No route may pipe a file stream directly: the error event needs an owner.
    expect(handlers).not.toContain('.pipe(res)')
    expect(registrations).not.toContain('.pipe(res)')
    expect(handlers.match(/streamToResponse\(createReadStream\(/g) ?? []).toHaveLength(4)
  })
})
