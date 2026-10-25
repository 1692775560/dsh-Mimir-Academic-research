/**
 * Build-contract guard for the generated Typert faces (#276): dsh ≥ 0.2.0
 * retired the `schema:` codec shape in favour of a lazy `create()` factory and
 * validates the whole manifest atomically, so one stale face silently takes
 * the entire `research` Remote namespace down — every workspace then reads as
 * empty. Assert both emitted faces carry a factory on every strict codec.
 *
 * The faces are build output (`lib/`, gitignored), so run `pnpm run build`
 * before `pnpm test`.
 */

import { describe, expect, it } from 'vitest'
import { TYPERT as HOST_TYPERT } from '../lib/typert.host.js'
import { TYPERT_REMOTE } from '../lib/typert.remote-client.js'

interface Codec {
  mode: string
  create?: unknown
}

interface Face {
  package: string
  invocations?: { id: string; parameters?: { codec: Codec }[]; result?: Codec }[]
  descriptors?: { id: string; parameters?: { codec: Codec }[]; result?: Codec }[]
}

/** Every codec one face declares, tagged with its declaring invocation. */
function codecsOf(face: Face): { id: string; codec: Codec }[] {
  return (face.invocations ?? face.descriptors ?? []).flatMap((invocation) => [
    ...(invocation.parameters ?? []).map((parameter) => ({ id: invocation.id, codec: parameter.codec })),
    ...(invocation.result ? [{ id: invocation.id, codec: invocation.result }] : []),
  ])
}

describe('generated Typert faces', () => {
  const faces = [
    ['host', HOST_TYPERT as Face],
    ['remote', TYPERT_REMOTE as Face],
  ] as const

  it.each(faces)('%s face declares strict codecs with create() factories', (_name, face) => {
    const codecs = codecsOf(face)
    expect(codecs.length).toBeGreaterThan(0)

    const offenders = codecs.filter(({ codec }) => codec.mode === 'strict' && typeof codec.create !== 'function')
    expect(offenders.map(({ id }) => id)).toEqual([])
  })
})
