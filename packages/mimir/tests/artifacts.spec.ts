/**
 * Behavior tests for the workbench artifact/figure helpers: the artifact
 * whitelist (traversal is inexpressible), whitelisted reads with mtime, and
 * the figure scan's depth (top level plus the whole `figures/` subtree),
 * confinement (symlinked directories never followed), and degradation
 * (unreadable entries skipped, never fatal).
 */

import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isArtifactName, isFigureFile, listPaperFigures, readWorkspaceArtifact,
} from '../src/artifacts.ts'

describe('isArtifactName / isFigureFile', () => {
  it('accepts exactly the four whitelisted artifacts', () => {
    expect(isArtifactName('EXPERIMENT_LOG.md')).toBe(true)
    expect(isArtifactName('IDEA_REPORT.md')).toBe(true)
    expect(isArtifactName('main.tex')).toBe(false)
    expect(isArtifactName('../secret.md')).toBe(false)
    expect(isArtifactName('figures/../IDEA_REPORT.md')).toBe(false)
  })

  it('accepts the servable figure extensions case-insensitively', () => {
    expect(isFigureFile('loss.png')).toBe(true)
    expect(isFigureFile('arch.SVG')).toBe(true)
    expect(isFigureFile('plot.pdf')).toBe(true)
    expect(isFigureFile('notes.md')).toBe(false)
    expect(isFigureFile('main.tex')).toBe(false)
    // The compiled paper is a PDF but never a figure.
    expect(isFigureFile('main.pdf')).toBe(false)
  })
})

describe('artifact and figure file operations', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'research-artifacts-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads a whitelisted artifact with its mtime', async () => {
    await writeFile(join(dir, 'EXPERIMENT_LOG.md'), '# Log\n', 'utf8')
    const artifact = await readWorkspaceArtifact(dir, 'EXPERIMENT_LOG.md')
    expect(artifact?.content).toBe('# Log\n')
    expect(artifact?.mtimeMs).toBe((await stat(join(dir, 'EXPERIMENT_LOG.md'))).mtimeMs)
  })

  it('returns undefined for a whitelisted-but-absent artifact', async () => {
    expect(await readWorkspaceArtifact(dir, 'NARRATIVE_REPORT.md')).toBeUndefined()
  })

  it('scans the paper directory top level and the whole figures/ subtree', async () => {
    await mkdir(join(dir, 'figures', 'nested', 'ch3'), { recursive: true })
    await mkdir(join(dir, 'sections'), { recursive: true })
    await writeFile(join(dir, 'teaser.png'), 'png', 'utf8')
    await writeFile(join(dir, 'main.tex'), 'tex', 'utf8')
    await writeFile(join(dir, 'figures', 'loss.svg'), 'svg', 'utf8')
    await writeFile(join(dir, 'figures', 'table.pdf'), 'pdf', 'utf8')
    await writeFile(join(dir, 'figures', 'draft.txt'), 'txt', 'utf8')
    await writeFile(join(dir, 'figures', 'nested', 'deep.png'), 'png', 'utf8')
    await writeFile(join(dir, 'figures', 'nested', 'ch3', 'ablation.png'), 'png', 'utf8')
    // Sections are a LaTeX convention, not a figure location.
    await writeFile(join(dir, 'sections', 'diagram.png'), 'png', 'utf8')
    const figures = await listPaperFigures(dir)
    expect(figures.map(figure => figure.relPath)).toEqual([
      'teaser.png',
      'figures/loss.svg',
      'figures/table.pdf',
      'figures/nested/deep.png',
      'figures/nested/ch3/ablation.png',
    ])
    expect(figures[0]).toMatchObject({ name: 'teaser.png', sizeBytes: 3 })
  })

  it('never follows a symlinked figures/ subdirectory (#255 scan boundary)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'research-figures-outside-'))
    try {
      await writeFile(join(outside, 'escaped.png'), 'png', 'utf8')
      await mkdir(join(dir, 'figures'), { recursive: true })
      await writeFile(join(dir, 'figures', 'real.png'), 'png', 'utf8')
      await symlink(outside, join(dir, 'figures', 'linked'))
      const figures = await listPaperFigures(dir)
      expect(figures.map(figure => figure.relPath)).toEqual(['figures/real.png'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('skips an unreadable figure file instead of failing the listing (#255)', async () => {
    // stat needs the search bit on the containing directory: a listable but
    // non-searchable subdir makes its files un-stat-able (EACCES).
    const blocked = join(dir, 'figures', 'noexec')
    await mkdir(blocked, { recursive: true })
    await writeFile(join(dir, 'figures', 'ok.png'), 'png', 'utf8')
    await writeFile(join(blocked, 'locked.png'), 'png', 'utf8')
    await chmod(blocked, 0o444)
    try {
      const figures = await listPaperFigures(dir)
      expect(figures.map(figure => figure.relPath)).toEqual(['figures/ok.png'])
    } finally {
      await chmod(blocked, 0o755).catch(() => {})
    }
  })

  it('yields an empty list when the paper directory does not exist', async () => {
    expect(await listPaperFigures(join(dir, 'missing'))).toEqual([])
  })
})
