/**
 * Host-side paper-figure extraction for meeting decks. When a selected paper
 * has no `.paper-figures` manifest yet, the deck generator runs the
 * academic-Group-meeting-skills extract pipeline itself — git-cloned on first
 * use, executed through `uv` with a bundled pdftoppm shim — against the
 * cached arXiv PDF, then files the top crops plus a deck manifest under
 * `meetings/.paper-figures/<arxivId>/`. Every failure mode (no uv, no
 * network, no cached PDF, script error) degrades to "no figures": a deck
 * must never fail because extraction did.
 * @module dsh-mimir/src/services/paper-figures
 */

import { execFile } from 'node:child_process'
import { copyFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  DECK_MAX_PAPER_FIGURES,
  MEETINGS_DIR_NAME,
  PAPER_FIGURES_DIR_NAME,
  loadPaperFigures,
  type PaperFigureAsset,
} from './meeting.ts'
import { isValidArxivId, paperPdfFileName } from '../tools/arxiv.ts'

/** Upstream skill repo providing the extract pipeline (cloned on demand). */
export const GROUP_MEETING_SKILLS_REPO = 'https://github.com/mlxbc12138/academic-Group-meeting-skills'

/**
 * Single-file pdftoppm replacement executed via `uv run --script` (PEP 723
 * header pulls pypdfium2 + pillow), for hosts without poppler. Keep in sync
 * with the copy embedded in the research-meeting-deck skill text.
 */
export const PDFTOPPM_SHIM_SOURCE = `#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pypdfium2", "pillow"]
# ///
"""pdftoppm-compatible shim: -r <dpi> -png <input.pdf> <prefix> via pypdfium2."""
import sys
import pypdfium2 as pdfium

args = sys.argv[1:]
dpi = 150
while args and args[0].startswith("-"):
    flag = args.pop(0)
    if flag == "-r":
        dpi = int(args.pop(0))
    elif flag == "-png":
        pass
    else:
        raise SystemExit("shim: unsupported flag " + flag)
doc = pdfium.PdfDocument(args[0])
n = len(doc)
width = max(2, len(str(n)))
for i in range(n):
    doc[i].render(scale=dpi / 72).to_pil().save(args[1] + "-" + str(i + 1).zfill(width) + ".png")
doc.close()
`

/** Injectable process runner; defaults to a timed execFile. */
export type ExtractRunner = (executable: string, args: readonly string[], timeoutMs: number) => Promise<void>

function runProcess(executable: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : error.message
      reject(new Error(detail.slice(-600)))
    })
  })
}

/** Injectable seams of {@link extractPaperFigures}; defaults hit the real machine. */
export interface PaperFigureExtractDeps {
  /** Root holding the cloned skill repo and the shim; defaults to ~/.dsh/skills-external. */
  readonly skillsDir?: string
  /** Process runner; defaults to a timed execFile. */
  readonly run?: ExtractRunner
}

const CLONE_TIMEOUT_MS = 120_000
const EXTRACT_TIMEOUT_MS = 300_000

/**
 * Locate the cached arXiv PDF for a paper: `papers/<paperPdfFileName(arxivId)>`
 * (the same percent-encoded name the write side uses), or a version-suffixed
 * sibling. An id failing {@link isValidArxivId} resolves to nothing rather
 * than escaping the papers directory.
 * @returns the absolute PDF path, or undefined when nothing is cached.
 */
export async function resolvePaperPdf(workspaceDir: string, arxivId: string): Promise<string | undefined> {
  if (!isValidArxivId(arxivId)) return undefined
  const papersDir = join(workspaceDir, 'papers')
  const exact = join(papersDir, paperPdfFileName(arxivId))
  if ((await stat(exact).catch(() => undefined))?.isFile() === true) return exact
  let names: string[]
  try {
    names = await readdir(papersDir)
  } catch {
    return undefined
  }
  const prefix = encodeURIComponent(arxivId)
  const versioned = names
    .filter(name => name.startsWith(`${prefix}v`) && name.endsWith('.pdf'))
    .sort()
  return versioned.length > 0 ? join(papersDir, versioned[0]!) : undefined
}

/**
 * Compress one raw extract caption into a single deck-ready sentence: strip
 * the duplicated "Figure N:" prefix (the label carries it), cut at the first
 * sentence boundary, cap the length. A polished zh_caption wins outright.
 */
export function cleanExtractCaption(rawCaption: string, zhCaption: string): string {
  const zh = zhCaption.trim()
  if (zh !== '') return zh
  const body = rawCaption.trim().replace(/^(?:figure|fig\.?|table)\s*\d+[.:]?\s*/i, '')
  const boundary = body.indexOf('. ', 40)
  const sentence = boundary === -1 ? body : body.slice(0, boundary + 1)
  return sentence.length > 240 ? `${sentence.slice(0, 237)}…` : sentence
}

interface ExtractManifestFigure {
  readonly order?: number
  readonly image_path?: string
  readonly raw_label?: string
  readonly raw_caption?: string
  readonly zh_caption?: string
}

/**
 * Ensure one paper's 逐图 assets exist, extracting them on first use.
 * Already-extracted papers return their manifest untouched; papers without a
 * cached PDF, or any pipeline failure, resolve to an empty list.
 * @param workspaceDir - research workspace root.
 * @param arxivId - the paper's bare arXiv id.
 * @param deps - injectable seams (skills root, process runner).
 * @returns the paper's deck-ready figure assets, possibly empty.
 */
export async function extractPaperFigures(
  workspaceDir: string,
  arxivId: string,
  deps: PaperFigureExtractDeps = {},
): Promise<readonly PaperFigureAsset[]> {
  // An unsafe id never reaches a path join; extraction fails open.
  if (!isValidArxivId(arxivId)) return []
  const existing = await loadPaperFigures(workspaceDir, arxivId)
  if (existing.length > 0) return existing

  const pdf = await resolvePaperPdf(workspaceDir, arxivId)
  if (pdf === undefined) return []

  const skillsDir = deps.skillsDir ?? join(homedir(), '.dsh', 'skills-external')
  const run = deps.run ?? runProcess
  const repoDir = join(skillsDir, 'academic-Group-meeting-skills')
  const script = join(repoDir, 'academic-Group-meeting-skills', 'scripts', 'paper_figures_to_ppt.py')
  const shim = join(skillsDir, 'pdftoppm-shim.py')
  const scratch = await mkdtemp(join(tmpdir(), 'mimir-paperfig-'))

  try {
    if ((await stat(script).catch(() => undefined))?.isFile() !== true) {
      await mkdir(skillsDir, { recursive: true })
      await run('git', ['clone', '--depth', '1', GROUP_MEETING_SKILLS_REPO, repoDir], CLONE_TIMEOUT_MS)
    }
    if ((await stat(shim).catch(() => undefined))?.isFile() !== true) {
      await mkdir(skillsDir, { recursive: true })
      await writeFile(shim, PDFTOPPM_SHIM_SOURCE, 'utf8')
    }
    // The extract script invokes the shim as an executable.
    await chmod(shim, 0o755).catch(() => undefined)
    await run('uv', [
      'run', '--with', 'pdfplumber', '--with', 'pillow', '--with', 'python-pptx',
      'python', script, 'extract', '--pdf', pdf, '--workdir', scratch, '--pdftoppm', shim,
    ], EXTRACT_TIMEOUT_MS)

    const manifest = JSON.parse(await readFile(join(scratch, 'manifest.json'), 'utf8')) as {
      figures?: ExtractManifestFigure[]
    }
    const figures = (manifest.figures ?? [])
      .filter(entry => typeof entry.image_path === 'string' && entry.image_path !== '')
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .slice(0, DECK_MAX_PAPER_FIGURES)
    if (figures.length === 0) return []

    const dest = join(workspaceDir, MEETINGS_DIR_NAME, PAPER_FIGURES_DIR_NAME, arxivId)
    await mkdir(dest, { recursive: true })
    const entries: { file: string; label: string; caption: string }[] = []
    for (const [index, figure] of figures.entries()) {
      const file = basename(figure.image_path!)
      if (!file.toLowerCase().endsWith('.png')) continue
      await copyFile(figure.image_path!, join(dest, file))
      entries.push({
        file,
        label: figure.raw_label?.trim() || `Figure ${figure.order ?? index + 1}`,
        caption: cleanExtractCaption(figure.raw_caption ?? '', figure.zh_caption ?? ''),
      })
    }
    if (entries.length === 0) return []
    await writeFile(join(dest, 'manifest.json'), `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    return await loadPaperFigures(workspaceDir, arxivId)
  } catch {
    // Extraction is best-effort: a missing tool, a failed clone, or a broken
    // PDF must never break deck generation.
    return []
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}
