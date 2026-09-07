/**
 * The `meeting_deck` tool: render one project's group-meeting pptx from the
 * wiki (progress, experiments, paper-directory figures, library papers with
 * extracted 逐图 crops) into `meetings/<projectId>/`, so the deck lists in the
 * workbench's 组会 / Meetings tab immediately. This is the deterministic
 * render path — the agent curates the material (paper notes, figure captions,
 * extraction manifests) and calls this tool; no manual UI step is needed.
 * @module dsh-mimir/src/tools/meeting
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { generateMeetingDeck } from '../services/meeting.ts'
import type { ResearchWikiDomain } from '../store.ts'

interface MeetingDeckArgs {
  readonly project_id?: string
  readonly title?: string
  readonly presenter?: string
  readonly date?: string
  readonly paper_ids?: readonly string[]
  readonly include_progress?: boolean
  readonly include_experiments?: boolean
  readonly include_figures?: boolean
  readonly include_papers?: boolean
}

/**
 * Build the `meeting_deck` tool over one opened research-wiki domain.
 * @param workspaceDir - the resolved research workspace root.
 * @param domain - the plugin-owned open domain handle.
 * @returns the registry-ready tool definition.
 */
export function createMeetingDeckTool(workspaceDir: string, domain: ResearchWikiDomain): ToolDefinition {
  return defineTool({
    name: 'meeting_deck',
    description: 'Generate a group-meeting (组会) pptx for a research project from the wiki: progress, experiments, paper figures, and the selected library papers (with extracted per-figure slides when an extraction manifest exists). The deck lands in meetings/<projectId>/ and lists in the workbench\'s Meetings tab with download. Call this AFTER curating the material — paper notes, figure captions, honest project stage — because the slides render exactly what the wiki holds.',
    parameters: {
      project_id: { type: 'string', required: true, description: 'Wiki project id (see wiki_note action=list, table=projects).' },
      title: { type: 'string', description: 'Deck title (defaults to "<project> · 组会汇报").' },
      presenter: { type: 'string', description: 'Presenter name shown on the title slide (optional).' },
      date: { type: 'string', description: 'Meeting date YYYY-MM-DD (defaults to today).' },
      paper_ids: { type: 'array', items: { type: 'string' }, description: 'arXiv ids to feature, in slide order (omit for the project\'s papers, relevance-sorted, top 12).' },
      include_progress: { type: 'boolean', description: 'Include the project-progress slide (default true).' },
      include_experiments: { type: 'boolean', description: 'Include the experiments slide (default true).' },
      include_figures: { type: 'boolean', description: 'Include paper-directory figure slides (default true).' },
      include_papers: { type: 'boolean', description: 'Include the paper-sharing slides (default true).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: MeetingDeckArgs): Promise<JsonValue> => {
      if (args.project_id === undefined || args.project_id.trim().length === 0) {
        throw new Error('meeting_deck requires a non-empty \'project_id\'')
      }
      const result = await generateMeetingDeck({ workspaceDir, domain }, {
        projectId: args.project_id,
        title: args.title,
        presenter: args.presenter,
        date: args.date,
        paperIds: args.paper_ids,
        include: {
          progress: args.include_progress ?? true,
          experiments: args.include_experiments ?? true,
          figures: args.include_figures ?? true,
          papers: args.include_papers ?? true,
        },
      })
      if (!result.ok) {
        const detail = 'message' in result.error ? ` — ${result.error.message}` : ` (${JSON.stringify(result.error)})`
        throw new Error(`meeting_deck: ${result.error.code}${detail}`)
      }
      return {
        file: result.value.file,
        slides: result.value.slides,
        path: `meetings/${args.project_id}/${result.value.file}`,
      }
    },
  })
}
