/**
 * #237: an externally cloned skill/tool is reused after the fact, and a
 * half-finished clone or a truncated file is indistinguishable from a healthy
 * one — the extractor then fails deep inside `uv run` with a message about
 * something else. Two things are missing: a recorded provenance (which repo,
 * which commit) and a cheap "can I actually run this" check before use.
 *
 * These tests pin both, and pin the recovery: a failed check must produce an
 * instruction to re-fetch, not a silent empty result.
 * @module dsh-mimir/tests/skill-tool-integrity
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkExternalTool, readToolProvenance, writeToolProvenance } from '../src/services/tool-integrity.ts'
import { GROUP_MEETING_SKILLS_REPO } from '../src/services/paper-figures.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mimir-tool-integrity-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('provenance is recorded next to the clone (#237)', () => {
  it('round-trips the source and the commit it was cloned at', async () => {
    const dir = join(root, 'academic-Group-meeting-skills')
    await mkdir(dir, { recursive: true })
    await writeToolProvenance(dir, { source: GROUP_MEETING_SKILLS_REPO, commit: 'abc1234' })
    const read = await readToolProvenance(dir)
    expect(read).toEqual({ source: GROUP_MEETING_SKILLS_REPO, commit: 'abc1234' })
  })

  it('reads a missing provenance file as unknown rather than throwing', async () => {
    await expect(readToolProvenance(join(root, 'absent'))).resolves.toBeUndefined()
  })

  it('reads a malformed provenance file as unknown rather than throwing', async () => {
    const dir = join(root, 'broken')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'PROVENANCE.json'), '{ not json', 'utf8')
    await expect(readToolProvenance(dir)).resolves.toBeUndefined()
  })
})

describe('the executable check answers "can I use this now" (#237)', () => {
  it('accepts a present, non-empty script', async () => {
    const script = join(root, 'tool.py')
    await writeFile(script, 'print(1)\n', 'utf8')
    await expect(checkExternalTool(script)).resolves.toEqual({ ok: true })
  })

  it('names a missing script and how to re-fetch it', async () => {
    const outcome = await checkExternalTool(join(root, 'absent.py'))
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.failure).toBe('missing')
    expect(outcome.ok === false && outcome.remedy).toContain('re-fetch')
  })

  it('names an empty script as broken — a truncated clone looks present', async () => {
    const script = join(root, 'empty.py')
    await writeFile(script, '', 'utf8')
    const outcome = await checkExternalTool(script)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.failure).toBe('broken')
  })
})
