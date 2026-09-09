/**
 * Pure helpers behind the papers view's reading-notes side panel. Reading
 * notes live inside the paper record's free-form `notes` string (no extra
 * storage): each entry the panel appends is one block headed by a
 * `[YYYY-MM-DD HH:mm]` timestamp, blocks separated by a blank line — the
 * same blank-line convention the agent's note appends already use. Blocks
 * not carrying the header are never dropped by the parse: one following an
 * entry is that entry's next paragraph (a multi-paragraph note keeps its
 * blank lines), and one before any entry is a legacy or agent-written note
 * shown without a stamp.
 * @module dsh-client-ui-mimir/client/paper-notes
 */

/** One parsed reading-note entry: the header timestamp and the body text. */
export interface ReadingNote {
  /** The `[YYYY-MM-DD HH:mm]` stamp, or '' for a legacy/agent-written block. */
  readonly at: string
  readonly text: string
}

/** Matches one entry block's `[YYYY-MM-DD HH:mm]` header line. */
const NOTE_HEADER = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\n/

/**
 * Format one moment as the entry header timestamp, in local time — the
 * reader thinks in "this afternoon while reading", not UTC.
 * @param date - the moment the note is taken.
 * @returns the `YYYY-MM-DD HH:mm` stamp.
 */
export function formatNoteStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Append one timestamped entry to a notes string. Existing content (entries
 * and free-form blocks alike) is kept untouched; an empty body is a no-op.
 * @param notes - the paper record's current notes, possibly empty.
 * @param text - the new entry's body; surrounding whitespace is trimmed.
 * @param now - the moment the note is taken.
 * @returns the notes string with the entry appended.
 */
export function appendReadingNote(notes: string, text: string, now: Date): string {
  const body = text.trim()
  if (body === '') return notes
  const entry = `[${formatNoteStamp(now)}]\n${body}`
  return notes.trimEnd() === '' ? entry : `${notes.trimEnd()}\n\n${entry}`
}

/**
 * Parse the reading notes out of a notes string, in stored order. Every
 * non-blank block stays visible: a block with the `[YYYY-MM-DD HH:mm]`
 * header starts a new entry; a headerless block continues the entry above
 * it (multi-paragraph notes survive the blank-line split) or, before any
 * entry, stands alone as a legacy/agent-written note with an empty stamp.
 * @param notes - the paper record's notes.
 * @returns the entries, oldest first.
 */
export function parseReadingNotes(notes: string): ReadingNote[] {
  const entries: ReadingNote[] = []
  for (const block of notes.split(/\n{2,}/)) {
    if (block.trim() === '') continue
    const match = NOTE_HEADER.exec(block)
    if (match !== null && match[1] !== undefined) {
      entries.push({ at: match[1], text: block.slice(match[0].length) })
      continue
    }
    const last = entries[entries.length - 1]
    if (last === undefined) {
      entries.push({ at: '', text: block })
    } else {
      entries[entries.length - 1] = { at: last.at, text: `${last.text}\n\n${block}` }
    }
  }
  return entries
}
