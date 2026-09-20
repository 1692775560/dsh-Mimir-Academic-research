/**
 * Pure helpers behind the meetings view's paper-picking: the project-scoped
 * relevance-sorted list, the default pre-picks (top N by the project's AI
 * relevance verdicts), and the free-text filter of the pick list.
 * @module dsh-client-ui-mimir/client/meeting-picks
 */

import type { PaperRecord } from 'dsh-mimir/types'

/** How many papers a fresh deck form pre-picks (the relevance-sorted top). */
export const MEETING_DEFAULT_PAPER_PICKS = 5

/** The paper relevance score the deck's ordering uses (unscored = -1, last). */
export function meetingScoreOf(paper: PaperRecord, projectId: string): number {
  return paper.relevance?.[projectId]?.score ?? -1
}

/**
 * The project's associated papers, best relevance first (stable: ties keep
 * the library order). This is exactly the order the deck's auto-selection
 * applies, so the pick list and the host default agree.
 */
export function sortMeetingPapers(papers: readonly PaperRecord[], projectId: string): PaperRecord[] {
  return papers
    .filter(paper => paper.projectIds.includes(projectId))
    .sort((left, right) => meetingScoreOf(right, projectId) - meetingScoreOf(left, projectId))
}

/**
 * The default pre-picks of a fresh deck form: the relevance-sorted top `count`
 * arXiv ids of {@link sortMeetingPapers}.
 */
export function defaultMeetingPicks(
  papers: readonly PaperRecord[],
  projectId: string,
  count = MEETING_DEFAULT_PAPER_PICKS,
): string[] {
  return sortMeetingPapers(papers, projectId).slice(0, count).map(paper => paper.arxivId)
}

/**
 * Free-text narrow of the pick list: a case-insensitive substring over the
 * title, the author list, and the tags. A blank query passes everything.
 */
export function filterMeetingPapers(papers: readonly PaperRecord[], query: string): PaperRecord[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...papers]
  return papers.filter(paper =>
    paper.title.toLowerCase().includes(needle)
    || paper.authors.some(author => author.toLowerCase().includes(needle))
    || paper.tags.some(tag => tag.toLowerCase().includes(needle)))
}
