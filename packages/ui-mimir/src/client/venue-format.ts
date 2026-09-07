/**
 * Prompt assembly for the "re-format to venue" handoff: the panel cannot
 * reach an LLM directly, so it hands one assembled prompt to the current
 * session's agent (the same chat-handoff pattern as compile-fix). Pure
 * functions only, so the prompt shape is unit-testable without a host.
 * @module dsh-client-ui-mimir/client/venue-format
 */

/** Everything the venue-format prompt needs. */
export interface VenueFormatRequest {
  /** Title of the project being re-formatted (for the agent's context). */
  readonly projectTitle: string
  /** Display name of the target venue, e.g. `CVPR (IEEE/CVF)`. */
  readonly venueName: string
  /** The project's paper directory relative to the workspace root. */
  readonly paperDir: string
}

/**
 * Assemble the venue-format handoff prompt: the agent reads the venue brief
 * the apply step wrote at `template/TEMPLATE.md`, re-layouts `main.tex` (and
 * companions) to match, and compiles to prove the swap. Scientific content
 * stays untouched.
 * @param request - project title, venue name, and paper directory.
 * @returns the prompt text handed to the current session's agent.
 */
export function buildVenueFormatPrompt(request: VenueFormatRequest): string {
  return [
    `Re-format the paper of project "${request.projectTitle}" for the venue "${request.venueName}".`,
    ``,
    `1. Read the venue brief at \`${request.paperDir}/template/TEMPLATE.md\` (checklist, official kit URL, and any uploaded kit files under \`${request.paperDir}/template/\`).`,
    `2. If the brief names a kit file that is not on disk yet and the brief gives an official URL, download the current kit into \`${request.paperDir}/template/\` first (the style/class files must sit next to \`main.tex\` or in \`template/\` as the brief instructs).`,
    `3. Re-layout \`${request.paperDir}/main.tex\` (and companion files) to match the venue: documentclass/style swap, front matter (title/authors/abstract) restructure, bibliography style. Do NOT change the scientific content, section order, or citations.`,
    `4. Compile the paper with the latex_compile tool and fix any layout-related errors you introduced.`,
    `5. Reply with a short summary: what changed, and anything that still needs the official kit or manual attention.`,
  ].join('\n')
}
