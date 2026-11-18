/**
 * The panel's HTTP routes (#238), one module so each handler can be driven by a
 * fake request/response pair in Vitest.
 *
 * These handlers were private to `index.ts`, which meant the only way to
 * exercise them was an optional E2E run behind `DSH_E2E_URL` — so a 413, a
 * traversal rejection, or a wrong status code could ship untested. Moving them
 * here does not change a single branch: the `deps` shape, the guards, and the
 * status codes are the ones that were already live. What changed is that the
 * file is now reachable from tests.
 *
 * Every route owns its whole response lifecycle — no thrown error and no
 * unhandled rejection may escape, because the host's HTTP carrier does not
 * serialize our failures for us. That is what `#209` tightened, and it is why
 * each early return ends the response explicitly.
 *
 * @module dsh-mimir/src/routes
 */

import { createReadStream } from 'node:fs'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { ResearchCommandDeps } from './commands/common.ts'
import { isSameOriginWrite, isTrustedRead, projectPaperDir } from './http-write-boundary.ts'
import { realpathConfined, resolvePaperDirReal } from './paper-source.ts'
import { isFigureFile } from './artifacts.ts'
import { streamToResponse } from './http-guard.ts'
import { meetingDeckPath } from './services/meeting.ts'
import { TEMPLATE_DIR_NAME } from './services/venue.ts'

/**
 * Stream the compiled paper PDF for one wiki project. The paper directory
 * resolves per request — a `?dir=` query override, else the project record's
 * `paperDir`, else `paper` — always confined inside the workspace (a
 * violating `dir` is a 400), so the project id only selects WHICH project's
 * panel may read it: an unknown id is a 404. Reads are loopback-panel-only
 * (`isTrustedRead`, #210).
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
export function createPdfHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    // Loopback-panel-only reads (#210): see http-write-boundary for the model.
    if (!isTrustedRead(req.headers, req.socket.remoteAddress)) {
      res.writeHead(403).end('workspace downloads are served to the loopback panel only')
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const pathname = url.pathname
    const prefix = '/research/pdf/'
    if (!pathname.startsWith(prefix) || pathname.length === prefix.length) {
      res.writeHead(404).end('expected /research/pdf/<project id>')
      return
    }
    let projectId: string
    try {
      projectId = decodeURIComponent(pathname.slice(prefix.length))
    } catch {
      res.writeHead(400).end('invalid encoded project id')
      return
    }
    const record = deps.domain.table('projects').get(projectId)
    if (record === undefined) {
      res.writeHead(404).end('unknown research project')
      return
    }
    const requestDir = url.searchParams.get('dir') ?? undefined
    // Realpath-backed (#213): a symlinked request dir must not smuggle the
    // read outside the workspace's realpath.
    const dir = await resolvePaperDirReal(root, requestDir, record.paperDir)
    if (dir === undefined) {
      res.writeHead(400).end('dir must be a relative path inside the research workspace')
      return
    }
    const pdfPath = resolve(dir, 'main.pdf')
    const stats = await stat(pdfPath).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) {
      res.writeHead(404).end('paper pdf not found; compile first')
      return
    }
    // The directory chain is realpath-clean, but the served file ITSELF could
    // still be a symlink pointing outside: re-check its realpath against the
    // directory's realpath before streaming.
    const dirReal = await realpath(dir).catch(() => undefined)
    if (dirReal === undefined || !(await realpathConfined(dirReal, pdfPath))) {
      res.writeHead(400).end('paper pdf escapes the paper directory')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': stats.size,
      // The panel cache-busts with ?v=<pdfUpdatedAt>; a stale cached preview
      // would otherwise survive a recompile under the same URL.
      'Cache-Control': 'no-cache',
      // No Content-Security-Policy (#257): browser-native PDF viewers run in
      // their own isolated plugin/extension origin, so a document CSP buys
      // nothing here — and it breaks them (`sandbox` disables Chrome's
      // PDFium plugin for a black reader; WebKit's viewer needs the inline
      // styles `default-src 'none'` blocks). `nosniff` stays so the browser
      // never re-guesses the type of the workspace-local bytes.
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    streamToResponse(createReadStream(pdfPath), res)
  }
}

/**
 * Stream one remembered paper's fetched PDF (the literature workbench's
 * embedded reader). The arXiv id only selects WHICH paper's file may be read:
 * an unknown id is a 404, as is a paper whose PDF was never fetched. The
 * stored `pdfPath` is workspace-relative; a path escaping the workspace is a
 * 400 (the fetch writer only ever produces `papers/<id>.pdf`, so a violating
 * value means a hand-edited store). Reads are loopback-panel-only
 * (`isTrustedRead`, #210).
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
export function createPaperPdfHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    // Loopback-panel-only reads (#210): see http-write-boundary for the model.
    if (!isTrustedRead(req.headers, req.socket.remoteAddress)) {
      res.writeHead(403).end('workspace downloads are served to the loopback panel only')
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const prefix = '/research/paper-pdf/'
    if (!url.pathname.startsWith(prefix) || url.pathname.length === prefix.length) {
      res.writeHead(404).end('expected /research/paper-pdf/<arxiv id>')
      return
    }
    let arxivId: string
    try {
      arxivId = decodeURIComponent(url.pathname.slice(prefix.length))
    } catch {
      res.writeHead(400).end('invalid encoded arXiv id')
      return
    }
    const record = deps.domain.table('papers').get(arxivId)
    if (record === undefined) {
      res.writeHead(404).end('unknown research paper')
      return
    }
    if (record.pdfPath === undefined) {
      res.writeHead(404).end('paper pdf not fetched yet')
      return
    }
    const pdfPath = resolve(root, record.pdfPath)
    if (!pdfPath.startsWith(root + sep)) {
      res.writeHead(400).end('pdfPath escapes the research workspace')
      return
    }
    const stats = await stat(pdfPath).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) {
      res.writeHead(404).end('paper pdf file is gone; fetch it again')
      return
    }
    // Lexical confinement is not enough: the stored path (or an intermediate
    // directory) could be a symlink pointing outside the workspace — re-check
    // the realpath before streaming.
    const rootReal = await realpath(root).catch(() => undefined)
    if (rootReal === undefined || !(await realpathConfined(rootReal, pdfPath))) {
      res.writeHead(400).end('pdfPath escapes the research workspace')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': stats.size,
      // Same cache-bust rationale as the compiled-paper route: a refetch
      // overwrites the same file, and the panel busts with ?v=<timestamp>.
      'Cache-Control': 'no-cache',
      // No Content-Security-Policy (#257): browser-native PDF viewers run in
      // their own isolated plugin/extension origin, so a document CSP buys
      // nothing here — and it breaks them (`sandbox` disables Chrome's
      // PDFium plugin for a black reader; WebKit's viewer needs the inline
      // styles `default-src 'none'` blocks). `nosniff` stays so the browser
      // never re-guesses the type of the workspace-local bytes.
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    streamToResponse(createReadStream(pdfPath), res)
  }
}
/** Content-Type of one servable figure extension. */
const FIGURE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
}


/**
 * Stream one figure file of a wiki project's paper directory. The paper
 * directory resolves like the PDF route (`?dir=` override, record
 * `paperDir`, default); `?path=` is relative to it — an absolute path, a
 * `..` escape, or a non-figure extension is a 400, a missing file a 404.
 * Reads are loopback-panel-only (`isTrustedRead`, #210).
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
export function createFigureHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    // Loopback-panel-only reads (#210): see http-write-boundary for the model.
    if (!isTrustedRead(req.headers, req.socket.remoteAddress)) {
      res.writeHead(403).end('workspace downloads are served to the loopback panel only')
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const prefix = '/research/figure/'
    if (!url.pathname.startsWith(prefix) || url.pathname.length === prefix.length) {
      res.writeHead(404).end('expected /research/figure/<project id>')
      return
    }
    let projectId: string
    try {
      projectId = decodeURIComponent(url.pathname.slice(prefix.length))
    } catch {
      res.writeHead(400).end('invalid encoded project id')
      return
    }
    const record = deps.domain.table('projects').get(projectId)
    if (record === undefined) {
      res.writeHead(404).end('unknown research project')
      return
    }
    const relPath = url.searchParams.get('path')
    if (relPath === null || relPath.length === 0 || !isFigureFile(relPath)) {
      res.writeHead(400).end('path must name a figure file (.png/.jpg/.jpeg/.svg/.pdf)')
      return
    }
    // Realpath-backed (#213): a symlinked request dir must not smuggle the
    // read outside the workspace's realpath.
    const dir = await resolvePaperDirReal(root, url.searchParams.get('dir') ?? undefined, record.paperDir)
    if (dir === undefined) {
      res.writeHead(400).end('dir must be a relative path inside the research workspace')
      return
    }
    const figurePath = resolve(dir, relPath)
    if (!figurePath.startsWith(dir + sep)) {
      res.writeHead(400).end('path escapes the paper directory')
      return
    }
    const stats = await stat(figurePath).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) {
      res.writeHead(404).end('figure not found')
      return
    }
    // The directory chain is realpath-clean, but the served file ITSELF could
    // still be a symlink pointing outside: re-check its realpath against the
    // directory's realpath before streaming.
    const dirReal = await realpath(dir).catch(() => undefined)
    if (dirReal === undefined || !(await realpathConfined(dirReal, figurePath))) {
      res.writeHead(400).end('figure escapes the paper directory')
      return
    }
    res.writeHead(200, {
      'Content-Type': FIGURE_CONTENT_TYPES[extname(relPath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stats.size,
      // Same cache-bust rationale as the PDF route; figures are immutable per
      // mtime from the panel's point of view.
      'Cache-Control': 'no-cache',
      // Defense-in-depth: a `.svg` is served as `image/svg+xml` from our
      // origin, and SVG can carry scripts. Pin the type (no sniff) and drop
      // all privileges (sandbox + default-src 'none') so a served figure
      // can never act as our page.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    streamToResponse(createReadStream(figurePath), res)
  }
}

/** Raw-body cap of the figure upload route (a security invariant, not a tunable). */
const FIGURE_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024

/**
 * Receive one uploaded figure for a wiki project's paper directory. The query
 * carries `?project=` (an unknown id is a 404), `?name=` (reduced to its
 * basename, so no traversal is expressible; a non-figure extension is a 400).
 * The route requires an exact same-origin `Origin` header and always resolves
 * the destination from the project record's `paperDir`; callers cannot select
 * a different workspace directory. The raw body lands at `figures/<name>` under the paper directory (created on demand,
 * same-name overwrite); a body over {@link FIGURE_UPLOAD_LIMIT_BYTES} is a
 * 413, any method but POST a 405.
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
export function createFigureUploadHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    if (!isSameOriginWrite(req.headers)) {
      res.writeHead(403).end('cross-origin uploads are not allowed')
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const projectId = url.searchParams.get('project')
    if (projectId === null || projectId.length === 0) {
      res.writeHead(400).end('expected ?project=<project id>')
      return
    }
    const record = deps.domain.table('projects').get(projectId)
    if (record === undefined) {
      res.writeHead(404).end('unknown research project')
      return
    }
    const name = basename(url.searchParams.get('name') ?? '')
    if (name === '' || !isFigureFile(name)) {
      res.writeHead(400).end('name must name a figure file (.png/.jpg/.jpeg/.svg/.pdf)')
      return
    }
    const dir = await projectPaperDir(root, record.paperDir)
    if (dir === undefined) {
      res.writeHead(400).end('dir must be a relative path inside the research workspace')
      return
    }
    const rootReal = await realpath(root).catch(() => undefined)
    if (rootReal === undefined) {
      res.writeHead(400).end('dir must be a relative path inside the research workspace')
      return
    }
    const chunks: Buffer[] = []
    let sizeBytes = 0
    for await (const chunk of req) {
      sizeBytes += (chunk as Buffer).length
      if (sizeBytes > FIGURE_UPLOAD_LIMIT_BYTES) {
        res.writeHead(413).end('figure exceeds the 50MB limit')
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }
    const figuresDir = join(dir, 'figures')
    await mkdir(figuresDir, { recursive: true })
    // A pre-existing `figures/` symlink (or a symlinked same-name target)
    // must not smuggle the write outside the workspace: re-check realpaths.
    const target = join(figuresDir, name)
    if (!(await realpathConfined(rootReal, figuresDir)) || !(await realpathConfined(rootReal, target))) {
      res.writeHead(400).end('figure destination escapes the research workspace')
      return
    }
    await writeFile(target, Buffer.concat(chunks))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ relPath: `figures/${name}` }))
  }
}

/** Raw-body cap of the template upload route (a security invariant, not a tunable). */
const TEMPLATE_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024

/** Extensions a venue-kit upload accepts (plain LaTeX kit files; no archives). */
const TEMPLATE_UPLOAD_EXTENSIONS = new Set(['.cls', '.sty', '.tex', '.bst', '.bbx', '.cbx', '.clo', '.def', '.cfg', '.md', '.txt', '.pdf'])

/**
 * Receive one uploaded venue-kit file for a wiki project's paper directory.
 * The query carries `?project=` (an unknown id is a 404) and `?name=`
 * (reduced to its basename; an extension outside
 * {@link TEMPLATE_UPLOAD_EXTENSIONS} is a 400). The route requires an exact
 * same-origin `Origin` header and always resolves the destination from the
 * project record's `paperDir`; callers cannot select a different workspace
 * directory. The raw body lands at
 * `template/<name>` under the paper directory (created on demand, same-name
 * overwrite); a body over {@link TEMPLATE_UPLOAD_LIMIT_BYTES} is a 413, any
 * method but POST a 405.
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
export function createTemplateUploadHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    if (!isSameOriginWrite(req.headers)) {
      res.writeHead(403).end('cross-origin uploads are not allowed')
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const projectId = url.searchParams.get('project')
    if (projectId === null || projectId.length === 0) {
      res.writeHead(400).end('expected ?project=<project id>')
      return
    }
    const record = deps.domain.table('projects').get(projectId)
    if (record === undefined) {
      res.writeHead(404).end('unknown research project')
      return
    }
    const name = basename(url.searchParams.get('name') ?? '')
    if (name === '' || !TEMPLATE_UPLOAD_EXTENSIONS.has(extname(name).toLowerCase())) {
      res.writeHead(400).end('name must name a LaTeX kit file (.cls/.sty/.tex/.bst/...)')
      return
    }
    const dir = await projectPaperDir(root, record.paperDir)
    if (dir === undefined) {
      res.writeHead(400).end('dir must be a relative path inside the research workspace')
      return
    }
    const rootReal = await realpath(root).catch(() => undefined)
    if (rootReal === undefined) {
      res.writeHead(400).end('dir must be a relative path inside the research workspace')
      return
    }
    const chunks: Buffer[] = []
    let sizeBytes = 0
    for await (const chunk of req) {
      sizeBytes += (chunk as Buffer).length
      if (sizeBytes > TEMPLATE_UPLOAD_LIMIT_BYTES) {
        res.writeHead(413).end('template file exceeds the 50MB limit')
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }
    const templateDir = join(dir, TEMPLATE_DIR_NAME)
    await mkdir(templateDir, { recursive: true })
    // A pre-existing `template/` symlink (or a symlinked same-name target)
    // must not smuggle the write outside the workspace: re-check realpaths.
    const target = join(templateDir, name)
    if (!(await realpathConfined(rootReal, templateDir)) || !(await realpathConfined(rootReal, target))) {
      res.writeHead(400).end('template destination escapes the research workspace')
      return
    }
    await writeFile(target, Buffer.concat(chunks))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ relPath: `${TEMPLATE_DIR_NAME}/${name}` }))
  }
}

/**
 * Download one generated group-meeting deck. The query carries `?project=`
 * (an unknown id is a 404) and `?file=` (reduced to its basename and confined
 * to `meetings/<projectId>/` by {@link meetingDeckPath}, so no traversal is
 * expressible; a non-.pptx name is a 400). Streams the pptx as an attachment,
 * so the panel's `<a href>` forces a download. Reads are loopback-panel-only
 * (`isTrustedRead`, #210).
 * @param deps - Shared command dependencies (workspace root and open domain).
 * @returns the route handler owning the full response lifecycle.
 */
export function createMeetingDeckHandler(
  deps: ResearchCommandDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = resolve(deps.workspaceDir)
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    // Loopback-panel-only reads (#210): see http-write-boundary for the model.
    if (!isTrustedRead(req.headers, req.socket.remoteAddress)) {
      res.writeHead(403).end('workspace downloads are served to the loopback panel only')
      return
    }
    const url = new URL(req.url ?? '/', 'http://research.local')
    const projectId = url.searchParams.get('project')
    const file = url.searchParams.get('file')
    if (projectId === null || file === null) {
      res.writeHead(400).end('expected ?project=<project id>&file=<deck file>')
      return
    }
    if (deps.domain.table('projects').get(projectId) === undefined) {
      res.writeHead(404).end('unknown research project')
      return
    }
    const deckPath = meetingDeckPath(root, projectId, file)
    if (deckPath === undefined) {
      res.writeHead(400).end('file must name a .pptx deck')
      return
    }
    const stats = await stat(deckPath).catch(() => undefined)
    if (stats === undefined || !stats.isFile()) {
      res.writeHead(404).end('meeting deck not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Length': stats.size,
      'Content-Disposition': `attachment; filename="${basename(deckPath)}"`,
      'Cache-Control': 'no-cache',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    streamToResponse(createReadStream(deckPath), res)
  }
}
