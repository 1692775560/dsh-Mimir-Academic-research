/**
 * Behavior tests for importProject: copy-not-reference into
 * `<workspace>/imported/<slug>/` (excluding `.git`/`node_modules`), entry-tex
 * detection, the title priority chain, slug collision suffixes, figure
 * counting, warnings, the ledger trail, and the rejection paths. Real
 * memory-backed domain and real temp directories — no mocks.
 */

import { mkdtemp, mkdir, readdir, readFile, rm, lstat, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import type { ResearchWikiDomain } from '../src/store.ts'
import { expandHome, extractTexTitle, importProject, slugify } from '../src/services/import-project.ts'
import type { ResearchImportedProject } from '../src/types.ts'

/** Boot a memory-backed wiki domain plus a fresh temp workspace. */
async function harness(): Promise<{ ctx: Context; domain: ResearchWikiDomain; workspaceDir: string }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(researchWikiDomainSpec)
  const workspaceDir = await mkdtemp(join(tmpdir(), 'mimir-import-ws-'))
  return { ctx, domain, workspaceDir }
}

/** Scaffold one fake LaTeX project under a fresh temp parent. */
async function fakeLatexProject(name: string, mainTex: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'mimir-import-src-'))
  const dir = join(parent, name)
  await mkdir(join(dir, 'figures'), { recursive: true })
  await mkdir(join(dir, '.git', 'objects'), { recursive: true })
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(dir, 'main.tex'), mainTex)
  await writeFile(join(dir, 'references.bib'), '@book{knuth, title={TeXbook}}\n')
  await writeFile(join(dir, 'figures', 'a.png'), Buffer.from([0x89, 0x50]))
  await writeFile(join(dir, 'figures', 'b.png'), Buffer.from([0x89, 0x50]))
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  return dir
}

const MAIN_TEX = [
  '\\documentclass{article}',
  '\\title{',
  '  A Study of {Nested} Titles',
  '}',
  '\\begin{document}',
  '\\maketitle',
  '\\end{document}',
].join('\n')

/** Directories this suite created under the real home directory (the `~` case). */
const homeDirs: string[] = []
afterEach(async () => {
  while (homeDirs.length > 0) {
    const dir = homeDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** Unwrap the success branch or fail the test. */
function imported(result: Awaited<ReturnType<typeof importProject>>): ResearchImportedProject {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`)
  return result.value
}

describe('importProject', () => {
  it('copies the tree into imported/<slug>/, excluding .git and node_modules, and registers the project', async () => {
    const { domain, workspaceDir } = await harness()
    const source = await fakeLatexProject('My ICLR Paper', MAIN_TEX)

    const value = imported(await importProject({ workspaceDir, domain }, { path: source }))

    expect(value.title).toBe('A Study of {Nested} Titles')
    expect(value.paperDir).toBe('imported/my-iclr-paper')
    expect(value.entryTex).toBe('main.tex')
    expect(value.figureCount).toBe(2)
    expect(value.warnings).toEqual([])
    // The copy is real and self-contained: excluded directories stay behind.
    await stat(join(workspaceDir, 'imported', 'my-iclr-paper', 'main.tex'))
    await expect(stat(join(workspaceDir, 'imported', 'my-iclr-paper', '.git'))).rejects.toThrow()
    await expect(stat(join(workspaceDir, 'imported', 'my-iclr-paper', 'node_modules'))).rejects.toThrow()
    // The source tree is untouched.
    await stat(join(source, '.git', 'HEAD'))
    // The wiki record points at the copy at the writing stage.
    const record = domain.table('projects').get(value.projectId)
    expect(record).toMatchObject({
      title: 'A Study of {Nested} Titles',
      stage: 'writing',
      paperDir: 'imported/my-iclr-paper',
      artifacts: [],
      reviewRounds: 0,
    })
    // The ledger saw the import.
    const events = [...domain.table('events').entries()].map(([, event]) => event)
    const event = events.find(item => item.action === 'project.imported')
    expect(event?.refs.projectId).toBe(value.projectId)
    expect(event?.payload.sourcePath).toBe(source)
  })

  it('suffixes the slug on a second import of the same name', async () => {
    const { domain, workspaceDir } = await harness()
    const source = await fakeLatexProject('dup', MAIN_TEX)

    const first = imported(await importProject({ workspaceDir, domain }, { path: source }))
    const second = imported(await importProject({ workspaceDir, domain }, { path: source }))

    expect(first.paperDir).toBe('imported/dup')
    expect(second.paperDir).toBe('imported/dup-2')
    await stat(join(workspaceDir, 'imported', 'dup-2', 'main.tex'))
    expect(domain.table('projects').get(second.projectId)?.id).toBe(second.projectId)
  })

  it('prefers an explicit title over the tex title, and the directory name over nothing', async () => {
    const { domain, workspaceDir } = await harness()
    const explicit = await fakeLatexProject('one', MAIN_TEX)
    const value = imported(await importProject({ workspaceDir, domain }, { path: explicit, title: '  Custom Title  ' }))
    expect(value.title).toBe('Custom Title')

    const untitled = await fakeLatexProject('two', '\\documentclass{article}\n\\begin{document}Hi\\end{document}\n')
    const fallback = imported(await importProject({ workspaceDir, domain }, { path: untitled }))
    expect(fallback.title).toBe('two')
  })

  it('accepts a non-main entry tex and warns about it; warns about missing figures dir and bib', async () => {
    const { domain, workspaceDir } = await harness()
    const parent = await mkdtemp(join(tmpdir(), 'mimir-import-src-'))
    const dir = join(parent, 'loose')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'paper.tex'), '\\documentclass{llncs}\n\\begin{document}Hi\\end{document}\n')
    await writeFile(join(dir, 'plot.svg'), '<svg/>')

    const value = imported(await importProject({ workspaceDir, domain }, { path: dir }))

    expect(value.entryTex).toBe('paper.tex')
    expect(value.figureCount).toBe(1)
    expect(value.warnings).toHaveLength(3)
    expect(value.warnings[0]).toContain('figures/')
    expect(value.warnings[1]).toContain('paper.tex')
    expect(value.warnings[2]).toContain('.bib')
  })

  it('rejects a missing path, a file, a relative path, and a directory without an entry tex', async () => {
    const { domain, workspaceDir } = await harness()
    const deps = { workspaceDir, domain }

    const missing = await importProject(deps, { path: join(workspaceDir, 'nope') })
    expect(missing).toMatchObject({ ok: false, error: { code: 'invalid-path' } })

    const file = await fakeLatexProject('with-main', MAIN_TEX)
    const asFile = await importProject(deps, { path: join(file, 'main.tex') })
    expect(asFile).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(asFile.ok === false && asFile.error.message.includes('not a directory')).toBe(true)

    const relative = await importProject(deps, { path: 'papers/foo' })
    expect(relative).toMatchObject({ ok: false, error: { code: 'invalid-path' } })

    const empty = await mkdtemp(join(tmpdir(), 'mimir-import-empty-'))
    const noTex = await importProject(deps, { path: empty })
    expect(noTex).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(noTex.ok === false && noTex.error.message.includes('documentclass')).toBe(true)

    // A rejected import records nothing and copies nothing.
    expect([...domain.table('projects').entries()]).toEqual([])
    await expect(stat(join(workspaceDir, 'imported'))).rejects.toThrow()
  })

  it('expands a leading ~ against the home directory', async () => {
    const { domain, workspaceDir } = await harness()
    const home = await mkdtemp(join(homedir(), 'mimir-import-home-'))
    homeDirs.push(home)
    const dir = join(home, 'tilde-project')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'main.tex'), '\\documentclass{article}\n\\begin{document}Hi\\end{document}\n')

    const value = imported(await importProject({ workspaceDir, domain }, { path: `~/${home.split('/').pop()}/tilde-project` }))

    expect(value.paperDir).toBe('imported/tilde-project')
    await stat(join(workspaceDir, 'imported', 'tilde-project', 'main.tex'))
  })

  it('rejects a source tree whose symlink escapes the tree or dangles (#213)', async () => {
    const { domain, workspaceDir } = await harness()
    const deps = { workspaceDir, domain }

    const outside = await mkdtemp(join(tmpdir(), 'mimir-import-outside-'))
    await writeFile(join(outside, 'secret.tex'), 'outside content\n')
    const escaping = await fakeLatexProject('escaping-link', MAIN_TEX)
    await symlink(join(outside, 'secret.tex'), join(escaping, 'figures', 'leaked.tex'))
    const escaped = await importProject(deps, { path: escaping })
    expect(escaped).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(escaped.ok === false && escaped.error.message.includes('symlink')).toBe(true)

    const danglingProject = await fakeLatexProject('dangling-link', MAIN_TEX)
    await symlink(join(danglingProject, 'no-such-target'), join(danglingProject, 'figures', 'ghost.png'))
    const dangling = await importProject(deps, { path: danglingProject })
    expect(dangling).toMatchObject({ ok: false, error: { code: 'invalid-input' } })

    // Rejected imports record nothing and copy nothing.
    expect([...domain.table('projects').entries()]).toEqual([])
    await expect(stat(join(workspaceDir, 'imported'))).rejects.toThrow()
  })

  it('dereferences an in-tree symlink into a plain copied file (#213)', async () => {
    const { domain, workspaceDir } = await harness()
    const source = await fakeLatexProject('internal-link', MAIN_TEX)
    await writeFile(join(source, 'macros.tex'), '\\newcommand{\\x}{1}\n')
    await symlink(join(source, 'macros.tex'), join(source, 'figures', 'macros-link.tex'))

    const value = imported(await importProject({ workspaceDir, domain }, { path: source }))

    const copied = join(workspaceDir, value.paperDir, 'figures', 'macros-link.tex')
    // The copy holds a REAL file with the target's content — no symlink
    // survives into the workspace to defeat paperDir confinement later.
    expect((await lstat(copied)).isSymbolicLink()).toBe(false)
    expect(await readFile(copied, 'utf8')).toBe('\\newcommand{\\x}{1}\n')
  })
})

describe('importProject helpers', () => {
  it('expandHome expands ~ and ~/…, leaving absolute and relative input untouched', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/papers/x')).toBe(join(homedir(), 'papers', 'x'))
    expect(expandHome('/abs/path')).toBe('/abs/path')
    expect(expandHome('relative/path')).toBe('relative/path')
  })

  it('slugify lowercases, dashes separators, trims edges, and falls back for all-CJK names', () => {
    expect(slugify('My ICLR Paper!')).toBe('my-iclr-paper')
    expect(slugify('  --weird__name-- ')).toBe('weird-name')
    expect(slugify('可信人工智能')).toBe('project')
  })

  it('extractTexTitle reads multi-line and brace-nested titles', () => {
    expect(extractTexTitle(MAIN_TEX)).toBe('A Study of {Nested} Titles')
    expect(extractTexTitle('\\title{Simple}\n')).toBe('Simple')
    expect(extractTexTitle('\\documentclass{article}')).toBeUndefined()
    expect(extractTexTitle('\\title{')).toBeUndefined()
  })

  it('a tex copied into the workspace stays byte-identical (copy, not reference)', async () => {
    const { domain, workspaceDir } = await harness()
    const source = await fakeLatexProject('stable', MAIN_TEX)
    const value = imported(await importProject({ workspaceDir, domain }, { path: source }))
    const copied = await readFile(join(workspaceDir, value.paperDir, 'main.tex'), 'utf8')
    expect(copied).toBe(MAIN_TEX)
    // Mutating the source after the import does not leak into the workspace copy.
    await writeFile(join(source, 'main.tex'), 'changed')
    expect(await readFile(join(workspaceDir, value.paperDir, 'main.tex'), 'utf8')).toBe(MAIN_TEX)
    expect((await readdir(join(workspaceDir, value.paperDir))).sort()).toContain('references.bib')
  })
})
