/**
 * Behavior tests for the servers form's pure helpers (#263): the blank/edit
 * form constructors, the pending-tag merge, and the password fold — blank
 * keeps the stored password on update (the field submits `undefined`), the
 * explicit clear checkbox sends the empty string, and a typed value is sent
 * verbatim.
 */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_SERVER_FORM, serverFormOf, serverInputOf,
} from '../src/client/server-form.ts'
import type { ServerView } from 'dsh-mimir/types'

const RECORD: ServerView = {
  id: 'srv-1',
  name: 'gpu01',
  host: '192.168.1.10',
  port: 22,
  username: 'ops',
  note: 'rack 4',
  tags: ['dev'],
  hasPassword: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

describe('serverFormOf', () => {
  it('refills every field but the password, which always starts blank', () => {
    expect(serverFormOf(RECORD)).toEqual({
      name: 'gpu01',
      host: '192.168.1.10',
      port: '22',
      username: 'ops',
      note: 'rack 4',
      tags: ['dev'],
      password: '',
    })
  })
})

describe('serverInputOf', () => {
  const form = { ...EMPTY_SERVER_FORM, name: 'gpu01', host: '192.168.1.10', port: '2222' }

  it('carries no id on the create path and the record id on update', () => {
    expect(serverInputOf(form, '', 'new', false).id).toBeUndefined()
    expect(serverInputOf(form, '', null, false).id).toBeUndefined()
    expect(serverInputOf(form, '', 'srv-1', false).id).toBe('srv-1')
    expect(serverInputOf(form, '', 'srv-1', false).port).toBe(2222)
  })

  it('merges a typed-but-uncommitted tag into the payload', () => {
    expect(serverInputOf(form, '  rack-b ', 'new', false).tags).toEqual(['rack-b'])
    expect(serverInputOf({ ...form, tags: ['a'] }, 'a', 'new', false).tags).toEqual(['a'])
    expect(serverInputOf(form, '   ', 'new', false).tags).toEqual([])
  })

  it('folds the password: blank submits undefined (keep), typed sends verbatim, clear sends empty', () => {
    // Create: blank means key auth.
    expect(serverInputOf(form, '', 'new', false).password).toBeUndefined()
    // Update: blank keeps the stored password.
    expect(serverInputOf(form, '', 'srv-1', false).password).toBeUndefined()
    // A typed password goes verbatim (spaces and punctuation are legitimate).
    expect(serverInputOf({ ...form, password: 'S3cret! $x' }, '', 'srv-1', false).password).toBe('S3cret! $x')
    // The clear checkbox wins over the text field.
    expect(serverInputOf({ ...form, password: 'ignored' }, '', 'srv-1', true).password).toBe('')
    expect(serverInputOf(form, '', 'srv-1', true).password).toBe('')
  })
})
