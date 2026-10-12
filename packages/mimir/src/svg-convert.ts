/**
 * SVG → paper-figure conversion. LaTeX's `\includegraphics` cannot embed SVG
 * and the paper scaffold carries no SVG convention, so an SVG figure is
 * converted on the host before it is referenced: vector PDF is preferred
 * (`rsvg-convert`, then `inkscape`, then `magick`, whichever is found on
 * PATH first); on macOS the Quick Look thumbnailer (`qlmanage`) is the
 * zero-dependency raster fallback (PNG at 2048px). Everything is probed and
 * run through injectable dependencies so the rules are unit-testable on
 * machines (CI) that carry no converter at all.
 * @module dsh-mimir/src/svg-convert
 */

import { execFile } from 'node:child_process'
import { access, rename, stat, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { isNotFound } from './paper-source.ts'

/** One known SVG converter. */
export type SvgConverterKind = 'rsvg-convert' | 'inkscape' | 'magick' | 'qlmanage'

/** One converter's probe/run contract. */
export interface SvgConverterSpec {
  readonly kind: SvgConverterKind
  /** Binary looked up on PATH. */
  readonly command: string
  /** Product extension (`pdf` keeps the figure vector; `png` is the raster fallback). */
  readonly product: 'pdf' | 'png'
  /** Only platform the converter is expected on, when restricted. */
  readonly platform?: NodeJS.Platform
}

/**
 * Probe order: vector PDF producers first, the macOS Quick Look rasterizer
 * last — a high-resolution PNG beats a broken compile, but loses to any real
 * PDF pipeline.
 */
export const SVG_CONVERTERS: readonly SvgConverterSpec[] = Object.freeze([
  { kind: 'rsvg-convert', command: 'rsvg-convert', product: 'pdf' },
  { kind: 'inkscape', command: 'inkscape', product: 'pdf' },
  { kind: 'magick', command: 'magick', product: 'pdf' },
  { kind: 'qlmanage', command: 'qlmanage', product: 'png', platform: 'darwin' },
])

/** Longest one converter run may take (inkscape's cold start is slow). */
export const SVG_CONVERT_TIMEOUT_MS = 60_000

/** Pixel size bound handed to the qlmanage raster fallback. */
const QLMANAGE_THUMBNAIL_SIZE = 2048

/** Characters of one failed converter's stderr tail kept for the failure message. */
const CONVERT_ERROR_TAIL_CHARS = 400

/**
 * The product file name one converter writes for `foo.svg`, in the same
 * directory: `foo.pdf` for the vector pipeline, `foo.png` for qlmanage.
 */
export function svgProductName(svgName: string, kind: SvgConverterKind): string {
  const stem = svgName.replace(/\.svg$/i, '')
  const spec = SVG_CONVERTERS.find(candidate => candidate.kind === kind)
  return `${stem}.${spec?.product ?? 'pdf'}`
}

/**
 * Resolve one command against a PATH-like string, returning the executable's
 * full path or null. Injectable (`envPath`/`platform`) so the probe order is
 * testable without touching the real PATH.
 */
export async function whichOnPath(
  command: string,
  envPath: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of envPath.split(delimiter)) {
    if (dir === '') continue
    for (const ext of exts) {
      const candidate = join(dir, command + ext)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here — keep scanning.
      }
    }
  }
  return null
}

/** Outcome of one converter process run. */
export interface SvgRunOutcome {
  readonly ok: boolean
  /** stderr tail (or the spawn error's message) when the run failed. */
  readonly message: string
}

/** Injectable process runner: one converter invocation. */
export type SvgRunner = (executable: string, args: readonly string[]) => Promise<SvgRunOutcome>

/** Real runner: execFile with a timeout and a bounded buffer. */
function runConverter(executable: string, args: readonly string[]): Promise<SvgRunOutcome> {
  return new Promise((resolve) => {
    execFile(executable, [...args], { timeout: SVG_CONVERT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve({ ok: true, message: '' })
        return
      }
      const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : error.message
      resolve({ ok: false, message: detail.slice(-CONVERT_ERROR_TAIL_CHARS) })
    })
  })
}

/** Injectable seams of {@link convertSvgFigure}; defaults hit the real machine. */
export interface SvgConversionDeps {
  /** PATH lookup; defaults to {@link whichOnPath} on the real environment. */
  readonly probe?: (command: string) => Promise<string | null>
  /** Process runner; defaults to a timed execFile. */
  readonly run?: SvgRunner
  /** Platform override for the platform-restricted converters (qlmanage). */
  readonly platform?: NodeJS.Platform
}

/** Settled outcome of one SVG conversion attempt. */
export type SvgConversion =
  | { readonly ok: true; readonly productPath: string; readonly converter: SvgConverterKind }
  | { readonly ok: false; readonly code: 'no-converter' }
  | { readonly ok: false; readonly code: 'convert-failed'; readonly converter: SvgConverterKind; readonly message: string }

/** A stat that reads as undefined on a missing path only. */
async function statOrUndefined(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/**
 * Convert one SVG file into the LaTeX-embeddable product of the first usable
 * converter: the converters run in {@link SVG_CONVERTERS} order, a converter
 * whose run fails (or produces no file) falls through to the next one, and
 * only a full sweep with no converter on PATH settles as `no-converter`.
 * The product lands next to the source (`figures/foo.svg` →
 * `figures/foo.pdf`); qlmanage's `<name>.svg.png` thumbnail is renamed to
 * the plain `<stem>.png`.
 * @param svgPath - absolute path of the SVG source.
 * @param deps - probe/run/platform overrides for tests.
 * @returns the product path plus the converter used, or the failure.
 */
export async function convertSvgFigure(svgPath: string, deps: SvgConversionDeps = {}): Promise<SvgConversion> {
  const probe = deps.probe ?? ((command: string) => whichOnPath(command))
  const run = deps.run ?? runConverter
  const platform = deps.platform ?? process.platform
  const dir = dirname(svgPath)
  const name = basename(svgPath)
  let lastFailure: { readonly converter: SvgConverterKind; readonly message: string } | null = null
  for (const spec of SVG_CONVERTERS) {
    if (spec.platform !== undefined && spec.platform !== platform) continue
    const executable = await probe(spec.command)
    if (executable === null) continue
    const productPath = join(dir, svgProductName(name, spec.kind))
    if (spec.kind === 'qlmanage') {
      // qlmanage writes `<file>.svg.png` into the -o directory; rename it.
      // A stale thumbnail from an earlier run would read as a false success,
      // so it is removed first.
      const thumbnail = join(dir, `${name}.png`)
      await unlink(thumbnail).catch(() => {})
      const outcome = await run(executable, ['-t', '-s', String(QLMANAGE_THUMBNAIL_SIZE), '-o', dir, svgPath])
      const produced = await statOrUndefined(thumbnail)
      if (outcome.ok && produced !== undefined) {
        await rename(thumbnail, productPath)
        return { ok: true, productPath, converter: spec.kind }
      }
      lastFailure = { converter: spec.kind, message: outcome.ok ? 'qlmanage produced no thumbnail' : outcome.message }
      continue
    }
    const args: readonly string[] = spec.kind === 'rsvg-convert'
      ? ['-f', 'pdf', '-o', productPath, svgPath]
      : spec.kind === 'inkscape'
        ? [svgPath, '--export-type=pdf', `--export-filename=${productPath}`]
        : [svgPath, productPath]
    const outcome = await run(executable, args)
    const produced = await statOrUndefined(productPath)
    if (outcome.ok && produced !== undefined && produced.size > 0) {
      return { ok: true, productPath, converter: spec.kind }
    }
    lastFailure = {
      converter: spec.kind,
      message: outcome.ok ? `${spec.command} produced no output` : outcome.message,
    }
  }
  if (lastFailure !== null) {
    return { ok: false, code: 'convert-failed', converter: lastFailure.converter, message: lastFailure.message }
  }
  return { ok: false, code: 'no-converter' }
}

/** The converters {@link convertSvgFigure} would probe on one platform (for error copy). */
export function svgConverterNames(platform: NodeJS.Platform = process.platform): readonly string[] {
  return SVG_CONVERTERS
    .filter(spec => spec.platform === undefined || spec.platform === platform)
    .map(spec => spec.command)
}
