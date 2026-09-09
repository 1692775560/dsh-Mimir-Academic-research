/**
 * Behavior tests for host-side paper-figure extraction: PDF resolution
 * (exact and version-suffixed), caption compression, the extract pipeline
 * with an injected runner (manifest + crops land under .paper-figures), the
 * idempotent skip, and silent degradation when the pipeline fails.
 */

import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cleanExtractCaption,
  extractPaperFigures,
  resolvePaperPdf,
} from '../src/services/paper-figures.ts'
import { loadPaperFigures } from '../src/services/meeting.ts'

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mimir-paperfig-'))
}

describe('resolvePaperPdf', () => {
  it('prefers the exact id, then falls back to a version-suffixed sibling', async () => {
    const dir = await workspace()
    await mkdir(join(dir, 'papers'), { recursive: true })
    expect(await resolvePaperPdf(dir, '2304.06024')).toBeUndefined()

    await writeFile(join(dir, 'papers', '2304.06024v2.pdf'), '%PDF fake')
    expect(await resolvePaperPdf(dir, '2304.06024')).toBe(join(dir, 'papers', '2304.06024v2.pdf'))

    await writeFile(join(dir, 'papers', '2304.06024.pdf'), '%PDF fake')
    expect(await resolvePaperPdf(dir, '2304.06024')).toBe(join(dir, 'papers', '2304.06024.pdf'))
  })
})

describe('cleanExtractCaption', () => {
  it('prefers the polished zh caption verbatim', () => {
    expect(cleanExtractCaption('Figure 1: English text. More.', '中文 takeaway')).toBe('中文 takeaway')
  })

  it('strips the duplicated figure prefix and cuts at the first sentence boundary', () => {
    const raw = 'Figure 2: The pipeline renders pages then detects figure regions. Automatic perception of human behaviors follows.'
    expect(cleanExtractCaption(raw, '')).toBe('The pipeline renders pages then detects figure regions.')
  })

  it('caps an over-long caption with an ellipsis', () => {
    const raw = `Fig. 3: ${'x'.repeat(400)}`
    const caption = cleanExtractCaption(raw, '')
    expect(caption.length).toBeLessThanOrEqual(240)
    expect(caption.endsWith('…')).toBe(true)
  })
})

describe('extractPaperFigures', () => {
  /** Fake runner that emulates the extract script: writes manifest + crops into --workdir. */
  function fakeRunner(cropBytes: Buffer = Buffer.from('png-bytes')) {
    const calls: string[][] = []
    return {
      calls,
      run: async (_executable: string, args: readonly string[]) => {
        calls.push([...args])
        if (args[0] === 'clone') return // git clone: pretend the repo landed
        const workdir = args[args.indexOf('--workdir') + 1]!
        await mkdir(join(workdir, 'figures'), { recursive: true })
        await writeFile(join(workdir, 'figures', 'figure_001_p001_i01.png'), cropBytes)
        await writeFile(join(workdir, 'figures', 'figure_002_p003_i01.png'), cropBytes)
        await writeFile(join(workdir, 'manifest.json'), JSON.stringify({
          figures: [
            { order: 2, image_path: join(workdir, 'figures', 'figure_002_p003_i01.png'), raw_label: 'Fig. 2', raw_caption: 'Figure 2: Second figure. Tail.', zh_caption: '' },
            { order: 1, image_path: join(workdir, 'figures', 'figure_001_p001_i01.png'), raw_label: 'Fig. 1', raw_caption: 'Figure 1: First figure. Tail.', zh_caption: '首图要点' },
          ],
        }))
      },
    }
  }

  it('clones the skill repo on first use, extracts, and files the deck manifest', async () => {
    const dir = await workspace()
    const skillsDir = await workspace()
    await mkdir(join(dir, 'papers'), { recursive: true })
    await writeFile(join(dir, 'papers', '2304.06024.pdf'), '%PDF fake')
    const fake = fakeRunner()

    const assets = await extractPaperFigures(dir, '2304.06024', { skillsDir, run: fake.run })

    expect(fake.calls[0]?.[0]).toBe('clone') // repo was missing → cloned
    expect(fake.calls.some(args => args.includes('extract'))).toBe(true)
    expect(assets.map(asset => asset.label)).toEqual(['Fig. 1', 'Fig. 2']) // order-sorted
    expect(assets[0]?.caption).toBe('首图要点')

    const manifest = JSON.parse(await readFile(
      join(dir, 'meetings', '.paper-figures', '2304.06024', 'manifest.json'), 'utf8',
    )) as { file: string }[]
    expect(manifest).toHaveLength(2)
    for (const entry of manifest) {
      expect((await stat(join(dir, 'meetings', '.paper-figures', '2304.06024', entry.file))).isFile()).toBe(true)
    }
  })

  it('returns the existing manifest untouched on a second call (no re-extract)', async () => {
    const dir = await workspace()
    await mkdir(join(dir, 'papers'), { recursive: true })
    await writeFile(join(dir, 'papers', '2304.06024.pdf'), '%PDF fake')
    const first = await extractPaperFigures(dir, '2304.06024', { skillsDir: await workspace(), run: fakeRunner().run })
    expect(first.length).toBe(2)

    const calls: string[][] = []
    const again = await extractPaperFigures(dir, '2304.06024', {
      skillsDir: await workspace(),
      run: async (_e, args) => { calls.push([...args]) },
    })
    expect(again.length).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('degrades to empty when the pipeline fails, leaving no manifest behind', async () => {
    const dir = await workspace()
    await mkdir(join(dir, 'papers'), { recursive: true })
    await writeFile(join(dir, 'papers', '2304.06024.pdf'), '%PDF fake')
    const assets = await extractPaperFigures(dir, '2304.06024', {
      skillsDir: await workspace(),
      run: async () => { throw new Error('uv: command not found') },
    })
    expect(assets).toEqual([])
    expect(await loadPaperFigures(dir, '2304.06024')).toEqual([])
  })

  it('does nothing when the paper has no cached PDF', async () => {
    const dir = await workspace()
    const calls: string[][] = []
    const assets = await extractPaperFigures(dir, '2304.06024', {
      skillsDir: await workspace(),
      run: async (_e, args) => { calls.push([...args]) },
    })
    expect(assets).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('threads the abort signal to the runner and rejects on cancel instead of degrading (#233)', async () => {
    const dir = await workspace()
    await mkdir(join(dir, 'papers'), { recursive: true })
    await writeFile(join(dir, 'papers', '2304.06024.pdf'), '%PDF fake')
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined

    // Before the fix the runner never received a signal and a failure was
    // swallowed into []; an abort must propagate so the deck stops promptly.
    const pending = extractPaperFigures(dir, '2304.06024', {
      skillsDir: await workspace(),
      signal: controller.signal,
      run: async (_e, _args, _timeout, signal) => {
        seenSignal = signal
        controller.abort()
        throw new Error('figure extraction was cancelled')
      },
    })

    await expect(pending).rejects.toThrow('cancelled')
    expect(seenSignal).toBe(controller.signal)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const dir = await workspace()
    await mkdir(join(dir, 'papers'), { recursive: true })
    await writeFile(join(dir, 'papers', '2304.06024.pdf'), '%PDF fake')
    const controller = new AbortController()
    controller.abort()
    const calls: string[][] = []

    await expect(extractPaperFigures(dir, '2304.06024', {
      skillsDir: await workspace(),
      signal: controller.signal,
      run: async (_e, args) => { calls.push([...args]) },
    })).rejects.toThrow()
    expect(calls).toHaveLength(0) // no clone, no extract
  })
})
