/**
 * The `latex_compile` tool: compiles `main.tex` inside a project directory
 * with a resolved TeX engine and returns parsed diagnostics instead of a raw
 * log. Two engines are supported — `latexmk`
 * (`-pdf -interaction=nonstopmode -halt-on-error main.tex`) and `tectonic`
 * (`--keep-logs --synctex main.tex`). The configured engine resolves as
 * `auto` (probe `latexmk` then `tectonic` on PATH, cached for the process
 * lifetime), an explicit engine name, or an absolute path whose basename
 * picks the command line. A missing binary rejects with install guidance;
 * the execution's abort signal cancels the run.
 * @module dsh-mimir/src/tools/latex
 */

import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import { open, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { parseLatexErrors } from '../latex-log.ts'
import type { LatexIssue } from '../latex-log.ts'
import type { LatexEngineKind } from '../types.ts'

/** A TeX engine this tool knows how to drive. */
export type { LatexEngineKind } from '../types.ts'

/** Characters of log tail returned to the model; the rest is unrecoverable noise. */
const LOG_EXCERPT_CHARS = 4096

/**
 * Bytes of an on-disk `main.log` worth reading. stdout/stderr already carry a
 * maxBuffer cap; the disk log had none, so a pathological log could be read
 * whole into memory. Diagnostics live at the tail — past the cap, only the
 * last DISK_LOG_MAX_BYTES are read.
 */
const DISK_LOG_MAX_BYTES = 1_048_576

/** The concrete executable and command-line dialect of one resolved engine. */
export interface ResolvedLatexEngine {
  readonly kind: LatexEngineKind
  readonly executable: string
}

/**
 * Whether one command resolves to a runnable executable (PATH lookup for
 * bare names). Injectable so tests never touch the real PATH.
 */
export type LatexEngineProbe = (command: string) => Promise<boolean>

/** Deployment knobs for the compile tool. */
export interface LatexToolOptions {
  /**
   * Engine selection: `'auto'` (default; probe `latexmk` then `tectonic` on
   * PATH), an explicit engine name (`'latexmk'` / `'tectonic'`), or an
   * absolute path to an executable whose basename picks the dialect.
   */
  readonly engine: string
  /** Positive kill timeout in milliseconds. */
  readonly timeoutMs: number
  /** Test hook replacing the real PATH probe; never cached. */
  readonly probe?: LatexEngineProbe
}

/** One tool-visible compile outcome. */
export interface LatexCompileResult {
  readonly success: boolean
  /** The engine that produced this outcome. */
  readonly engine: LatexEngineKind
  readonly errors: LatexIssue[]
  readonly warnings: LatexIssue[]
  readonly log_excerpt: string
}

/** True when the engine executable itself was not found. */
function isMissingEngine(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT'
}

/** Engine command line per dialect; both run inside the project directory. */
function engineArgs(kind: LatexEngineKind, entryFile: string): readonly string[] {
  return kind === 'latexmk'
    ? ['-pdf', '-interaction=nonstopmode', '-halt-on-error', entryFile]
    : ['--keep-logs', '--synctex', entryFile]
}

/**
 * Why one engine candidate is unusable, when it is (#235). The three cases
 * need three different sentences in front of the user, and the old probe
 * collapsed all of them — plus a genuine `--version` failure — into a bare
 * boolean.
 */
export type LatexProbeFailure = 'missing' | 'permission' | 'timeout' | 'broken'

/** One probe outcome: whether the command runs, and why not when it does not. */
export interface LatexProbeOutcome {
  readonly available: boolean
  readonly failure?: LatexProbeFailure | undefined
}

/** Node error code of one probe failure, when it carries one. */
function probeErrorCode(error: ExecFileException): string | number | null {
  return typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null
}

/**
 * Classify one probe failure. `ENOENT` is the command not being on PATH at
 * all; `EACCES` / `EPERM` is a binary that is there but not executable; a
 * `killed` process means `--version` hung past the probe timeout; anything
 * else is a binary that exists but cannot describe itself.
 */
export function classifyProbeFailure(error: ExecFileException): LatexProbeFailure {
  if (isMissingEngine(error)) return 'missing'
  const code = probeErrorCode(error)
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  if (error.killed === true || code === 'ETIMEDOUT') return 'timeout'
  return 'broken'
}

/** The sentence naming why one candidate was rejected. */
function probeFailureCopy(command: string, failure: LatexProbeFailure): string {
  switch (failure) {
    case 'missing':
      return `'${command}' is not on PATH`
    case 'permission':
      return `'${command}' is on PATH but not executable (EACCES)`
    case 'timeout':
      return `'${command} --version' timed out, so the binary looks hung`
    case 'broken':
      return `'${command} --version' failed, so the binary is unusable`
  }
}

/**
 * Real PATH probe: `<command> --version` must run to completion. A binary
 * that exists but exits non-zero, is not executable, or hangs is NOT a usable
 * engine, and each of those fails differently (#235).
 * @param command - the engine candidate to probe.
 * @returns whether it runs, plus the classified reason when it does not.
 */
async function probeOnPathDetailed(command: string): Promise<LatexProbeOutcome> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 10_000 }, (error: ExecFileException | null) => {
      if (error === null) {
        resolve({ available: true })
        return
      }
      resolve({ available: false, failure: classifyProbeFailure(error) })
    })
  })
}

/** Guidance shown whenever no usable engine can be found. */
const INSTALL_GUIDANCE = 'Install a TeX distribution (TeX Live / MacTeX provides latexmk) or Tectonic (https://tectonic-typesetting.github.io), or set latex.engine in the mimir plugin config (an engine name or an absolute path to a tectonic/latexmk binary).'

/** Engine kind from an absolute path's basename; unknown names fail loud. */
function kindFromBasename(path: string): LatexEngineKind {
  const name = basename(path).toLowerCase()
  if (name.includes('tectonic')) return 'tectonic'
  if (name.includes('latexmk')) return 'latexmk'
  throw new Error(
    `latex.engine '${path}' must point at a tectonic or latexmk executable (judged by basename).`,
  )
}

/** Probe `latexmk` then `tectonic` on PATH; the first hit wins. */
async function detectEngine(probe: LatexEngineProbe): Promise<ResolvedLatexEngine> {
  if (await probe('latexmk')) return { kind: 'latexmk', executable: 'latexmk' }
  if (await probe('tectonic')) return { kind: 'tectonic', executable: 'tectonic' }
  throw new Error(`No LaTeX engine found on PATH (looked for latexmk and tectonic). ${INSTALL_GUIDANCE}`)
}

/**
 * {@link detectEngine} with per-candidate reasons (#235): the same two probes,
 * but a total failure reports WHY each candidate was rejected — a `tectonic`
 * that is installed but not executable and a `tectonic` that is absent need
 * different fixes, and the old message said the same thing for both.
 * @param probe - the detailed probe (classifies the failure).
 * @returns the first usable engine.
 */
async function detectEngineDetailed(
  probe: (command: string) => Promise<LatexProbeOutcome>,
): Promise<ResolvedLatexEngine> {
  const rejections: string[] = []
  for (const kind of ['latexmk', 'tectonic'] as const) {
    const outcome = await probe(kind)
    if (outcome.available) return { kind, executable: kind }
    rejections.push(probeFailureCopy(kind, outcome.failure ?? 'broken'))
  }
  throw new Error(`No usable LaTeX engine on PATH: ${rejections.join('; ')}. ${INSTALL_GUIDANCE}`)
}

/**
 * Build the process-lifetime cached auto resolver: the probe runs once and
 * the settled engine is shared by every later resolve. A FAILED probe is
 * never cached — the rejection clears the slot so the next resolve re-probes
 * (a TeX distribution installed mid-session gets picked up).
 * @param probe - the PATH probe to cache around.
 */
export function createAutoEngineResolver(probe: LatexEngineProbe): () => Promise<ResolvedLatexEngine> {
  let cache: Promise<ResolvedLatexEngine> | undefined
  return async () => {
    cache ??= detectEngine(probe)
    try {
      return await cache
    } catch (error) {
      cache = undefined
      throw error
    }
  }
}

/** The process-lifetime auto resolver, with per-candidate rejection reasons (#235). */
const resolveAutoEngineDetailed = (() => {
  let cache: Promise<ResolvedLatexEngine> | undefined
  return async (): Promise<ResolvedLatexEngine> => {
    cache ??= detectEngineDetailed(probeOnPathDetailed)
    try {
      return await cache
    } catch (error) {
      // A failed probe is never cached: a TeX distribution installed
      // mid-session gets picked up by the next resolve.
      cache = undefined
      throw error
    }
  }
})()

/**
 * Resolve the configured engine selection to a concrete executable.
 * @param engine - `latex.engine` config value (`auto`, a name, or a path).
 * @param probe - PATH probe override; supplying one bypasses the auto cache.
 * @returns the executable plus the command-line dialect to use.
 */
export async function resolveLatexEngine(engine: string, probe?: LatexEngineProbe): Promise<ResolvedLatexEngine> {
  if (engine === 'latexmk' || engine === 'tectonic') {
    return { kind: engine, executable: engine }
  }
  if (isAbsolute(engine)) {
    return { kind: kindFromBasename(engine), executable: engine }
  }
  if (engine !== 'auto') {
    // A bare custom name is treated as a latexmk-dialect executable on PATH.
    return { kind: 'latexmk', executable: engine }
  }
  if (probe !== undefined) return detectEngine(probe)
  return resolveAutoEngineDetailed()
}

/** One tectonic diagnostic line: `error: [file.tex:NN: ]message`. */
const TECTONIC_DIAGNOSTIC_RE = /^(error|warning):\s+(.*)$/
/** Optional `<file>:<line>: ` location prefix inside a tectonic message. */
const TECTONIC_LOCATION_RE = /^(\S+\.tex):(\d+):\s+(.*)$/

/**
 * Parse tectonic's stdout/stderr when no `main.log` is available. Only
 * `error:` / `warning:` lines carry diagnostics; the rest is progress noise.
 * @param log - Merged stdout/stderr of one tectonic run.
 * @returns diagnostics in log order.
 */
export function parseTectonicErrors(log: string): LatexIssue[] {
  const issues: LatexIssue[] = []
  // Tectonic on Windows emits CRLF stdout; a bare \n split would leave a
  // trailing \r on every line and defeat the anchored regexes below (#267).
  for (const line of log.split(/\r?\n/)) {
    const match = TECTONIC_DIAGNOSTIC_RE.exec(line)
    if (match === null) continue
    const severity = match[1] === 'error' ? 'error' as const : 'warning' as const
    const message = (match[2] ?? '').trim()
    const location = TECTONIC_LOCATION_RE.exec(message)
    if (location === null || location[1] === undefined) {
      issues.push({ severity, message })
    } else {
      issues.push({
        severity,
        file: location[1],
        line: Number.parseInt(location[2] ?? '0', 10),
        message: (location[3] ?? '').trim(),
      })
    }
  }
  return issues
}

/**
 * Read `main.log` with a size cap: whole file when small, only the last
 * {@link DISK_LOG_MAX_BYTES} when large (diagnostics cluster at the tail).
 * A tail read drops the first, possibly half-split, line. Missing or
 * unreadable files resolve to undefined — the console output is the fallback.
 */
export async function readLogTail(logPath: string): Promise<string | undefined> {
  const stats = await stat(logPath).catch(() => undefined)
  if (stats?.isFile() !== true) return undefined
  if (stats.size <= DISK_LOG_MAX_BYTES) {
    return readFile(logPath, 'utf8').catch(() => undefined)
  }
  const handle = await open(logPath, 'r').catch(() => undefined)
  if (handle === undefined) return undefined
  try {
    const buffer = Buffer.alloc(DISK_LOG_MAX_BYTES)
    await handle.read(buffer, 0, DISK_LOG_MAX_BYTES, stats.size - DISK_LOG_MAX_BYTES)
    const text = buffer.toString('utf8')
    const firstNewline = text.indexOf('\n')
    return firstNewline === -1 ? text : text.slice(firstNewline + 1)
  } finally {
    await handle.close()
  }
}

/** Run the engine once, resolving with the merged output and the exit status. */
function runEngine(
  engine: ResolvedLatexEngine,
  projectDir: string,
  timeoutMs: number,
  signal: AbortSignal,
  entryFile: string,
): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      engine.executable,
      engineArgs(engine.kind, entryFile),
      { cwd: projectDir, timeout: timeoutMs, signal, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error !== null && signal.aborted) {
          reject(new Error('latex_compile was cancelled', { cause: error }))
          return
        }
        if (error !== null && isMissingEngine(error)) {
          const reason = isAbsolute(engine.executable)
            ? `LaTeX engine '${basename(engine.executable)}' was not found: the configured absolute path does not exist or is not executable.`
            : `LaTeX engine '${basename(engine.executable)}' was not found on PATH.`
          reject(new Error(`${reason} ${INSTALL_GUIDANCE}`, { cause: error }))
          return
        }
        // A timeout kill or a non-zero exit still yields a parseable log.
        resolve({ ok: error === null, log: `${stdout}\n${stderr}` })
      },
    )
  })
}

/**
 * Compile the entry .tex inside one project directory and parse the log.
 * Tectonic's `--keep-logs` leaves a standard TeX `<entry>.log`; when present
 * it is parsed with the latexmk log parser, otherwise the run's `error:` /
 * `warning:` lines are parsed instead.
 * @param projectDir - Directory containing the entry file; must exist.
 * @param options - Resolved engine selection and timeout.
 * @param signal - Caller cancellation; kills the engine process.
 * @param entryFile - the entry .tex basename (`main.tex` for the agent-facing
 * tool; the panel passes the project record's persisted entry — #249).
 * @returns parsed diagnostics, the engine used, success flag, and log tail.
 */
export async function compileLatex(projectDir: string, options: LatexToolOptions, signal: AbortSignal, entryFile = 'main.tex'): Promise<LatexCompileResult> {
  const stats = await stat(projectDir).catch(() => undefined)
  if (stats === undefined || !stats.isDirectory()) {
    throw new Error(`latex_compile: project_dir is not an existing directory containing ${entryFile}`)
  }
  const engine = await resolveLatexEngine(options.engine, options.probe)
  const { ok, log } = await runEngine(engine, projectDir, options.timeoutMs, signal, entryFile)
  // Prefer the on-disk TeX log tectonic leaves behind (--keep-logs): it is
  // far richer than tectonic's terse console lines. Capped at the tail — an
  // unbounded readFile let a pathological log into memory whole (#234).
  const entryBase = entryFile.endsWith('.tex') ? entryFile.slice(0, -'.tex'.length) : entryFile
  const diskLog = engine.kind === 'tectonic'
    ? await readLogTail(join(projectDir, `${entryBase}.log`))
    : undefined
  const source = diskLog ?? log
  const issues = diskLog !== undefined
    ? parseLatexErrors(diskLog)
    : engine.kind === 'tectonic'
      ? parseTectonicErrors(log)
      : parseLatexErrors(log)
  return {
    success: ok && !issues.some(issue => issue.severity === 'error'),
    engine: engine.kind,
    errors: issues.filter(issue => issue.severity === 'error'),
    warnings: issues.filter(issue => issue.severity === 'warning'),
    log_excerpt: source.slice(-LOG_EXCERPT_CHARS),
  }
}

/** Render one compile outcome as plain text for tools and commands alike. */
export function renderLatexResult(result: LatexCompileResult): string {
  const lines: string[] = [
    result.success
      ? `Compilation succeeded (engine: ${result.engine}).`
      : `Compilation failed (engine: ${result.engine}).`,
  ]
  const format = (issue: LatexIssue): string => {
    const where = `${issue.file ?? '?'}${issue.line === undefined ? '' : `:${issue.line}`}`
    return `  [${issue.severity}] ${where} ${issue.message}`
  }
  for (const issue of result.errors) lines.push(format(issue))
  for (const issue of result.warnings) lines.push(format(issue))
  if (result.log_excerpt.length > 0) lines.push(`Log tail:\n${result.log_excerpt}`)
  return lines.join('\n')
}

/** JSON-schema properties of one {@link LatexIssue} in tool output. */
const ISSUE_PROPERTIES = {
  severity: { type: 'string', enum: ['error', 'warning'], required: true },
  file: { type: 'string' },
  line: { type: 'integer' },
  message: { type: 'string', required: true },
} as const

/**
 * Build the `latex_compile` tool.
 * @param options - Resolved engine selection and timeout from the plugin config.
 * @returns the registry-ready tool definition.
 */
export function createLatexCompileTool(options: LatexToolOptions): ToolDefinition {
  return defineTool({
    name: 'latex_compile',
    description: 'Compile main.tex in a project directory with the resolved TeX engine (latexmk or tectonic). Returns parsed errors and warnings (file, line, message) plus the log tail. Fix errors and re-run until success is true.',
    parameters: {
      project_dir: { type: 'string', required: true, description: 'Directory containing main.tex.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          engine: { type: 'string', enum: ['latexmk', 'tectonic'], required: true },
          errors: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: ISSUE_PROPERTIES } },
          warnings: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: ISSUE_PROPERTIES } },
          log_excerpt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderLatexResult(value) }],
    },
    timeoutMs: options.timeoutMs + 5000,
    execute: (args, exec) => compileLatex(args.project_dir, options, exec.signal),
  })
}
