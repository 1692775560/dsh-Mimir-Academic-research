/**
 * The servers form's pure helpers: the field state (the port stays text
 * until submit), the blank/edit form constructors, and the fold back into a
 * `ServerInput`. Password semantics (#263): the field starts blank even when
 * a password is stored (the secret never crosses the RPC boundary, so the
 * edit form cannot prefill it); a blank field keeps the stored password on
 * update, and the explicit `clearPassword` checkbox — only offered while one
 * is stored — sends the empty string that clears it.
 * @module dsh-client-ui-mimir/client/server-form
 */

import type { ServerInput, ServerView } from 'dsh-mimir/types'

/** Form field state: the port stays text until submit. */
export interface ServerFormState {
  readonly name: string
  readonly host: string
  readonly port: string
  readonly username: string
  readonly note: string
  readonly tags: readonly string[]
  /** Blank = key auth on add / keep the stored password on edit. */
  readonly password: string
}

/** The blank form the add button opens. */
export const EMPTY_SERVER_FORM: ServerFormState = {
  name: '', host: '', port: '22', username: '', note: '', tags: [], password: '',
}

/** Form state of one existing record (the edit path's refill; the password field starts blank). */
export function serverFormOf(record: ServerView): ServerFormState {
  return {
    name: record.name,
    host: record.host,
    port: String(record.port),
    username: record.username,
    note: record.note,
    tags: [...record.tags],
    password: '',
  }
}

/**
 * Fold the form into one `saveServer` payload. A tag typed but not yet
 * committed with Enter (`pendingTag`) rides along; `editing` is the record
 * id on the update path (`'new'`/null on create); `clearPassword` is the
 * edit form's explicit clear checkbox — it wins over the text field and is
 * only rendered while a password is stored.
 */
export function serverInputOf(
  form: ServerFormState,
  pendingTag: string,
  editing: 'new' | string | null,
  clearPassword: boolean,
): ServerInput {
  const pending = pendingTag.trim()
  const tags = pending === '' || form.tags.includes(pending) ? form.tags : [...form.tags, pending]
  return {
    id: editing === 'new' || editing === null ? undefined : editing,
    name: form.name,
    host: form.host,
    port: Number(form.port),
    username: form.username,
    note: form.note,
    tags: [...tags],
    password: clearPassword ? '' : form.password === '' ? undefined : form.password,
  }
}
