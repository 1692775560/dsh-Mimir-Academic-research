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
  GROUP_MEETING_SKILLS_REPO,
} from '../src/services/paper-figures.ts'
import { checkExternalTool } from '../src/services/tool-integrity.ts'
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

/**
 * Fake runner that emulates the extract script: `git clone` leaves a runnable
 * script behind, `git -C … rev-parse HEAD` answers the provenance probe, and
 * anything else writes the crops and manifest into `--workdir`.
 */
function fakeRunner(cropBytes: Buffer = Buffer.from('png-bytes')) {
  const calls: string[][] = []
  return {
    calls,
    run: async (_executable: string, args: readonly string[], _timeoutMs?: number, _signal?: AbortSignal, sink?: string[]) => {
      calls.push([...args])
      if (args[0] === 'clone') {
        // git clone: pretend the repo landed — including the script the
        // integrity gate checks for (#237).
        const target = args[args.length - 1]!
        await mkdir(join(target, 'academic-Group-meeting-skills', 'scripts'), { recursive: true })
        await writeFile(
          join(target, 'academic-Group-meeting-skills', 'scripts', 'paper_figures_to_ppt.py'),
          'print(1)\n',
        )
        return
      }
      if (args[0] === '-C') {
        // `git -C <dir> rev-parse HEAD`: the provenance probe (#237).
        sink?.push('deadbeefcafe\n')
        return
      }
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

describe('extractPaperFigures', () => {
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

describe('external tool integrity (#237)', () => {
  it('records the clone provenance so a stale tool is tellable from a current one', async () => {
    const dir = await workspace()
    const skillsDir = await workspace()
    await mkdir(join(dir, 'papers'), { recursive: true })
    await writeFile(join(dir, 'papers', '2304.06024.pdf'), '%PDF fake')
    const fake = fakeRunner()

    await extractPaperFigures(dir, '2304.06024', { skillsDir, run: fake.run })

    const repoDir = join(skillsDir, 'academic-Group-meeting-skills')
    const provenance = JSON.parse(await readFile(join(repoDir, 'PROVENANCE.json'), 'utf8')) as {
      source: string
      commit: string
    }
    expect(provenance.source).toBe(GROUP_MEETING_SKILLS_REPO)
    expect(provenance.commit).toBe('deadbeefcafe')
    // The probe ran against the clone it just made.
    expect(fake.calls.some(args => args[0] === '-C' && args[1] === repoDir)).toBe(true)
  })

  it('re-fetches the skill when the script is present but empty', async () => {
    const dir = await workspace()
    const skillsDir = await workspace()
    await mkdir(join(dir, 'papers'), { recursive: true })
    await writeFile(join(dir, 'papers', '2304.06024.pdf'), '%PDF fake')
    // A clone interrupted after creating the file: present, not runnable.
    const repoDir = join(skillsDir, 'academic-Group-meeting-skills')
    const scriptDir = join(repoDir, 'academic-Group-meeting-skills', 'scripts')
    await mkdir(scriptDir, { recursive: true })
    await writeFile(join(scriptDir, 'paper_figures_to_ppt.py'), '')
    const fake = fakeRunner()

    const assets = await extractPaperFigures(dir, '2304.06024', { skillsDir, run: fake.run })

    expect(fake.calls[0]?.[0]).toBe('clone')
    expect(assets).toHaveLength(2)
  })

  it('degrades to no figures when the re-fetch still leaves the script unusable', async () => {
    const dir = await workspace()
    const skillsDir = await workspace()
    await mkdir(join(dir, 'papers'), { recursive: true })
    await writeFile(join(dir, 'papers', '2304.06024.pdf'), '%PDF fake')

    // A clone that reports success but writes nothing: the case the old
    // existence check happily waved through, and the one that used to fail
    // deep inside `uv run` naming the wrong thing. Deck generation must not
    // break over it, so the extraction still degrades to "no figures" — but it
    // never reaches `uv`, which is what the zero extract calls pin.
    const calls: string[][] = []
    const run = async (_executable: string, args: readonly string[]): Promise<void> => {
      calls.push([...args])
    }

    await expect(extractPaperFigures(dir, '2304.06024', { skillsDir, run })).resolves.toEqual([])
    expect(calls[0]?.[0]).toBe('clone')
    expect(calls.some(args => args.includes('extract'))).toBe(false)
    expect(calls.some(args => args.includes('rev-parse'))).toBe(false)
  })

  it('names the remedy in the error the gate raises (#237)', async () => {
    const skillsDir = await workspace()
    const repoDir = join(skillsDir, 'academic-Group-meeting-skills')
    await mkdir(join(repoDir, 'academic-Group-meeting-skills', 'scripts'), { recursive: true })
    const script = join(repoDir, 'academic-Group-meeting-skills', 'scripts', 'paper_figures_to_ppt.py')
    await writeFile(script, '')
    const outcome = await checkExternalTool(script)
    expect(outcome.ok === false && outcome.remedy).toMatch(/re-fetch the skill/)
    expect(outcome.ok === false && outcome.remedy).toContain(script)
  })
})
