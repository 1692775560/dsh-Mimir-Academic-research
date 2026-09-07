/**
 * The `figure_save` tool: copy one generated image (a plot, chart, or diagram
 * the agent produced anywhere on disk) into the addressed project's paper
 * `figures/` directory so it shows up in the workbench's figures view, record
 * its metadata (caption, linked experiment, origin path) in the wiki's
 * `figures` table, and register the file in the project's artifact list.
 * Returns the paper-relative path plus a ready-to-paste LaTeX figure block.
 * @module dsh-mimir/src/tools/figure
 */

import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isFigureFile } from '../artifacts.ts'
import { isNotFound, resolvePaperDir } from '../paper-source.ts'
import { renameFigure, updateFigure } from '../services/experiment.ts'
import { convertSvgFigure, svgConverterNames } from '../svg-convert.ts'
import type { SvgConversionDeps } from '../svg-convert.ts'
import type { ResearchWikiDomain } from '../store.ts'

interface FigureSaveArgs {
  readonly project_id?: string
  readonly path?: string
  readonly name?: string
  readonly caption?: string
  readonly experiment_id?: string
}

/** Require one non-empty string field. */
function requireField(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`figure_save requires a non-empty '${field}'`)
  }
  return value
}

/** A filesystem stat that reads as undefined on a missing path only. */
async function statOrUndefined(path: string) {
  return await stat(path).catch((error: unknown) => {
    if (isNotFound(error)) return undefined
    throw error
  })
}

/** The LaTeX figure block the tool returns for immediate insertion. */
function latexBlock(relPath: string, caption: string): { latex: string; label: string } {
  const label = basename(relPath, extname(relPath)).replace(/[^a-zA-Z0-9:-]+/g, '-')
  return {
    latex: `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${relPath}}\n  \\caption{${caption}}\n  \\label{fig:${label}}\n\\end{figure}`,
    label: `fig:${label}`,
  }
}

/**
 * Build the `figure_save` tool over one opened research-wiki domain.
 * @param workspaceDir - The resolved research workspace root.
 * @param domain - The plugin-owned open domain handle.
 * @returns the registry-ready tool definition.
 */
export function createFigureSaveTool(workspaceDir: string, domain: ResearchWikiDomain, deps: SvgConversionDeps = {}): ToolDefinition {
  return defineTool({
    name: 'figure_save',
    description: 'Save a figure you generated (plot/chart/diagram image) into a research project\'s paper figures/ directory so it appears in the workbench figures view and can be included in the paper. Use this immediately after creating or discovering a paper-worthy image instead of leaving the file in a scratch path. SVG sources are auto-converted to PDF (or PNG as a fallback) when a converter is available on the machine, and the returned LaTeX block references the converted file. Returns the paper-relative path and a ready-to-paste LaTeX figure block.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path of the generated image; absolute, or relative to the current process directory or the research workspace.' },
      project_id: { type: 'string', required: true, description: 'Owning wiki project id (see wiki_note action=list, table=projects).' },
      name: { type: 'string', description: 'Destination file name inside figures/ (defaults to the source basename).' },
      caption: { type: 'string', description: 'Caption for the workbench and the returned LaTeX block.' },
      experiment_id: { type: 'string', description: 'Id of the experiment record (of the same project) that produced the figure (optional).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderOutcome(value as Record<string, JsonValue | undefined>) }],
    },
    execute: async (args: FigureSaveArgs): Promise<JsonValue> => {
      const projectId = requireField(args.project_id, 'project_id')
      const project = domain.table('projects').get(projectId)
      if (project === undefined) throw new Error(`figure_save: no project with id '${projectId}'`)
      if (args.experiment_id !== undefined) {
        const experiment = domain.table('experiments').get(args.experiment_id)
        if (experiment === undefined || experiment.projectId !== projectId) {
          throw new Error(`figure_save: experiment '${args.experiment_id}' does not belong to project '${projectId}'`)
        }
      }
      const paperDir = resolvePaperDir(workspaceDir, undefined, project.paperDir)
      if (paperDir === undefined) {
        throw new Error(`figure_save: project '${projectId}' has an invalid paper directory`)
      }
      const rawPath = requireField(args.path, 'path')
      // Relative paths resolve against the process directory first (where the
      // agent usually just wrote the file), then against the workspace root.
      const source = isAbsolute(rawPath)
        ? rawPath
        : await statOrUndefined(resolve(process.cwd(), rawPath)) !== undefined
          ? resolve(process.cwd(), rawPath)
          : resolve(workspaceDir, rawPath)
      const sourceStats = await statOrUndefined(source)
      if (sourceStats === undefined || !sourceStats.isFile()) {
        throw new Error(`figure_save: source file not found: ${rawPath}`)
      }
      const name = args.name ?? basename(source)
      if (name === '' || name !== basename(name) || !isFigureFile(name)) {
        throw new Error(`figure_save: name must be a plain figure file name (.png/.jpg/.jpeg/.svg/.pdf), got '${name}'`)
      }
      const figuresDir = join(paperDir, 'figures')
      await mkdir(figuresDir, { recursive: true })
      const destination = join(figuresDir, name)
      if (source !== destination) await copyFile(source, destination)
      const relPath = `figures/${name}`
      // An SVG cannot be embedded by LaTeX directly; convert it next to the
      // copy and point the returned block at the product when a converter is
      // available. Without one the save still succeeds — the SVG shows in the
      // figures view and the warning says why the block keeps the .svg path.
      let converted: { relPath: string; converter: string } | null = null
      let warning: string | null = null
      if (name.toLowerCase().endsWith('.svg')) {
        const outcome = await convertSvgFigure(destination, deps)
        if (outcome.ok) {
          converted = { relPath: `figures/${basename(outcome.productPath)}`, converter: outcome.converter }
        } else {
          warning = outcome.code === 'no-converter'
            ? `No SVG converter found (looked for ${svgConverterNames().join(', ')}); the LaTeX block keeps the .svg path and will not compile until the figure is converted.`
            : `SVG conversion failed (${outcome.converter}: ${outcome.message}); the LaTeX block keeps the .svg path.`
        }
      }
      const id = `${projectId}:${relPath}`
      const existing = domain.table('figures').get(id)
      const caption = args.caption?.trim() ?? existing?.caption ?? ''
      const record = {
        id,
        projectId,
        relPath,
        caption,
        ...(args.experiment_id === undefined
          ? (existing?.experimentId === undefined ? {} : { experimentId: existing.experimentId })
          : { experimentId: args.experiment_id }),
        sourcePath: source,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      }
      await domain.table('figures').put(id, record)
      // The artifact list is what the overview shows as the project's output.
      const artifactPath = `${project.paperDir ?? 'paper'}/${relPath}`
      await domain.table('projects').update(project.id, current => ({
        ...current,
        artifacts: [...new Set([...current.artifacts, artifactPath])],
        updatedAt: new Date().toISOString(),
      }))
      const { latex, label } = latexBlock(converted?.relPath ?? relPath, caption)
      return {
        ok: true, id, relPath, caption, latex, label,
        ...(converted === null ? {} : { converted }),
        ...(warning === null ? {} : { warning }),
      } as unknown as JsonValue
    },
  })
}

/** Render one save outcome as model-facing text. */
function renderOutcome(value: Record<string, JsonValue | undefined>): string {
  if (value['ok'] !== true) return JSON.stringify(value)
  const lines = [`Figure saved to ${String(value['relPath'])} (workbench figures view updated).`]
  const converted = value['converted'] as { relPath?: string; converter?: string } | undefined
  if (converted !== undefined) {
    lines.push(`SVG auto-converted to ${String(converted.relPath ?? '')} via ${String(converted.converter ?? '')}.`)
  }
  if (typeof value['warning'] === 'string') lines.push(`Warning: ${value['warning']}`)
  lines.push(`LaTeX:\n${String(value['latex'])}`)
  return lines.join('\n')
}

interface FigureOrganizeArgs {
  readonly project_id?: string
  readonly path?: string
  readonly new_name?: string
  readonly caption?: string
}

/**
 * Build the `figure_organize` tool over one opened research-wiki domain: the
 * agent-side counterpart of the workbench's rename/caption edits. One call
 * renames the file (same directory, same extension — `.tex` references are
 * rewritten by the underlying service) and/or replaces its wiki-recorded
 * caption. Business failures of the underlying services throw with their
 * message.
 * @param workspaceDir - The resolved research workspace root.
 * @param domain - The plugin-owned open domain handle.
 * @returns the registry-ready tool definition.
 */
export function createFigureOrganizeTool(workspaceDir: string, domain: ResearchWikiDomain): ToolDefinition {
  return defineTool({
    name: 'figure_organize',
    description: 'Rename a figure file of a research project\'s paper directory and/or set its workbench caption — the organization counterpart of figure_save for files already inside the paper directory (including uploaded ones figure_save never saw). Renaming keeps the directory and the extension, rewrites \\includegraphics references in the paper\'s .tex files, and carries the recorded caption along. Use it to give an opaque upload a descriptive kebab-case name and a one-sentence caption.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Owning wiki project id (see wiki_note action=list, table=projects).' },
      path: { type: 'string', required: true, description: 'Figure path relative to the project\'s paper directory (e.g. figures/foo.png).' },
      new_name: { type: 'string', description: 'New bare file name (same extension as the current name); omitted keeps the name.' },
      caption: { type: 'string', description: 'Replacement caption shown in the workbench and used by future LaTeX blocks; omitted keeps the caption.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderOrganizeOutcome(value as Record<string, JsonValue | undefined>) }],
    },
    execute: async (args: FigureOrganizeArgs): Promise<JsonValue> => {
      const projectId = requireField(args.project_id, 'project_id')
      const relPath = requireField(args.path, 'path')
      if (args.new_name === undefined && args.caption === undefined) {
        throw new Error('figure_organize requires at least one of new_name or caption')
      }
      const deps = { workspaceDir, domain }
      if (args.caption !== undefined) {
        const outcome = await updateFigure(deps, { projectId, relPath, caption: args.caption })
        if (!outcome.ok) throw new Error('message' in outcome.error ? outcome.error.message : outcome.error.code)
      }
      let renamed: { relPath: string; references: number } | null = null
      if (args.new_name !== undefined) {
        const outcome = await renameFigure(deps, { projectId, relPath, newName: args.new_name })
        if (!outcome.ok) throw new Error('message' in outcome.error ? outcome.error.message : outcome.error.code)
        renamed = outcome.value
      }
      return {
        ok: true,
        projectId,
        relPath: renamed?.relPath ?? relPath,
        ...(args.caption === undefined ? {} : { caption: args.caption.trim() }),
        ...(renamed === null ? {} : { renamedFrom: relPath, references: renamed.references }),
      } as unknown as JsonValue
    },
  })
}

/** Render one organize outcome as model-facing text. */
function renderOrganizeOutcome(value: Record<string, JsonValue | undefined>): string {
  if (value['ok'] !== true) return JSON.stringify(value)
  const lines = [`Figure organized: ${String(value['relPath'])}.`]
  if (typeof value['renamedFrom'] === 'string') {
    lines.push(`Renamed from ${value['renamedFrom']} (${String(value['references'] ?? 0)} .tex file(s) updated).`)
  }
  if (typeof value['caption'] === 'string') lines.push(`Caption: ${value['caption']}`)
  return lines.join('\n')
}
