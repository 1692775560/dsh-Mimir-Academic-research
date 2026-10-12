/**
 * Venue-template domain service: the built-in registry listing plus applying
 * (or clearing) a target venue on a project. Applying writes a
 * `template/TEMPLATE.md` brief into the paper directory — the file the
 * agent reads when it re-layouts the paper — and records the venue on the
 * project record so the panel can show it. Custom kits are plain files the
 * user uploaded into the same `template/` directory via the upload route.
 * @module dsh-mimir/src/services/venue
 */

import { readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolvePaperDir } from '../paper-source.ts'
import type {
  ResearchApplyVenueResult,
  ResearchClearVenueResult,
  ResearchVenueTemplatesResult,
  VenueView,
} from '../types.ts'
import { VENUE_TEMPLATES, templateBriefOf, venueTemplateOf } from '../venues.ts'
import { success, rejected } from './common.ts'
import type { WikiAdminDeps } from './wiki-admin.ts'

/** Subdirectory of the paper directory holding the venue kit + brief. */
export const TEMPLATE_DIR_NAME = 'template'
/** The brief file the agent reads before re-layout. */
export const TEMPLATE_BRIEF_NAME = 'TEMPLATE.md'

/**
 * List the built-in venue template registry for the picker.
 * @returns the registry rows in declaration order.
 */
export function listVenueTemplates(): Promise<ResearchVenueTemplatesResult> {
  return Promise.resolve(success({
    templates: Object.freeze(VENUE_TEMPLATES.map(template => Object.freeze({
      id: template.id,
      name: template.name,
      series: template.series,
      url: template.url,
      checklist: template.checklist,
    }))),
  }))
}

/** File names inside one paper directory's `template/` folder (brief excluded). */
async function templateFilesOf(templateDir: string): Promise<string[]> {
  try {
    const entries = await readdir(templateDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && entry.name !== TEMPLATE_BRIEF_NAME)
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Apply a venue to one project: write the formatting brief and record the
 * venue on the project. `templateId` selects a built-in registry entry;
 * otherwise `customName` names an uploaded kit (at least one file must sit
 * in `template/` already, `invalid-input` otherwise). An unknown template
 * id or a custom name with no uploaded files is `invalid-input`; an unknown
 * project is `project-not-found`; a bad `dir` override is `invalid-dir`.
 * @param deps - workspace root and open domain.
 * @param request - the addressed project, optional dir override, and either
 * a built-in `templateId` or a `customName`.
 * @returns the recorded venue.
 */
export async function applyVenueTemplate(
  deps: WikiAdminDeps & { readonly workspaceDir: string },
  request: {
    readonly projectId: string
    readonly dir?: string | undefined
    readonly templateId?: string | undefined
    readonly customName?: string | undefined
  },
): Promise<ResearchApplyVenueResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) return rejected({ code: 'project-not-found', projectId: request.projectId })
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })

  const templateDir = join(dir, TEMPLATE_DIR_NAME)
  let heading: string
  let url: string | null
  let checklist: string
  let venueId: string
  let custom: boolean
  if (request.templateId !== undefined) {
    const template = venueTemplateOf(request.templateId)
    if (template === undefined) {
      return rejected({ code: 'invalid-input', message: `unknown venue template id: ${request.templateId}` })
    }
    heading = template.name
    url = template.url
    checklist = template.checklist
    venueId = template.id
    custom = false
  } else {
    const name = request.customName?.trim() ?? ''
    if (name === '') {
      return rejected({ code: 'invalid-input', message: 'customName must be non-empty when templateId is absent' })
    }
    const localFiles = await templateFilesOf(templateDir)
    if (localFiles.length === 0) {
      return rejected({ code: 'invalid-input', message: 'upload the venue kit (.cls/.sty/...) into the template directory first' })
    }
    heading = name
    url = null
    checklist = 'Match the uploaded kit in `template/`: switch `main.tex` to its documentclass/style entry point and follow the kit\'s own instructions file (README/example `.tex`) for options and front matter.'
    venueId = 'custom'
    custom = true
  }

  const localFiles = await templateFilesOf(templateDir)
  await mkdir(templateDir, { recursive: true })
  // Atomic like every other write path: a crash mid-write must not leave a
  // truncated brief behind for the next apply to trip over.
  await writeFileAtomic(join(templateDir, TEMPLATE_BRIEF_NAME), templateBriefOf(heading, url, checklist, localFiles), { mode: 0o644 })

  const venue: VenueView = Object.freeze({
    id: venueId,
    name: heading,
    custom,
    appliedAt: new Date().toISOString(),
  })
  await deps.domain.table('projects').update(record.id, current => ({
    ...current,
    venue,
    updatedAt: new Date().toISOString(),
  }))
  return success({ venue })
}

/**
 * Clear one project's target venue (the `template/` files stay on disk).
 * An unknown project is `project-not-found`.
 * @param deps - workspace root and open domain.
 * @param request - the addressed project.
 * @returns the cleared project id.
 */
export async function clearVenueTemplate(
  deps: WikiAdminDeps & { readonly workspaceDir: string },
  request: { readonly projectId: string },
): Promise<ResearchClearVenueResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) return rejected({ code: 'project-not-found', projectId: request.projectId })
  await deps.domain.table('projects').update(record.id, (current) => {
    const { venue: _dropped, ...rest } = current
    return { ...rest, updatedAt: new Date().toISOString() }
  })
  return success({ projectId: record.id })
}
