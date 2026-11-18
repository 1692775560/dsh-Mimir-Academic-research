/**
 * #142 item 6: the copy-feedback timers must be cancelled on unmount.
 *
 * There is no DOM environment in this repo's vitest config (every existing
 * render test goes through `renderToString`), so this pins the mechanism the
 * views rely on — an unmount effect returning a cleanup that clears the
 * pending handle — and then proves each of the four views actually contains
 * that effect. A view that drops it fails here rather than in a browser
 * console that nobody reads.
 * @module dsh-client-ui-mimir/tests/unmount-timer-cleanup
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Views that arm a `setTimeout` for copy feedback. */
const COPY_FEEDBACK_VIEWS = ['CognitiveBriefView', 'DigestView', 'LedgerView', 'FiguresView'] as const

/** The view's source text, read straight off disk. */
function sourceOf(view: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/client/${view}.tsx`, import.meta.url)), 'utf8')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('unmount cleanup clears a pending timer (#142 item 6)', () => {
  it('drops the callback when the cleanup runs before the delay elapses', () => {
    vi.useFakeTimers()
    const fired: string[] = []
    let handle: ReturnType<typeof setTimeout> | null = setTimeout(() => { fired.push('fired') }, 60_000)
    // The shape every view uses: `useEffect(() => () => { clearTimeout(ref) }, [])`.
    const cleanup = (): void => {
      if (handle !== null) clearTimeout(handle)
      handle = null
    }
    cleanup()
    vi.advanceTimersByTime(120_000)
    expect(handle).toBeNull()
    expect(fired).toEqual([])
  })

  it('is a no-op when nothing was armed', () => {
    let handle: ReturnType<typeof setTimeout> | null = null
    expect(() => {
      if (handle !== null) clearTimeout(handle)
    }).not.toThrow()
  })
})

describe('every copy-feedback view registers the cleanup (#142 item 6)', () => {
  for (const view of COPY_FEEDBACK_VIEWS) {
    it(`${view} cancels its timer on unmount`, () => {
      const source = sourceOf(view)
      const timerField = /const (\w*Timer\w*) = useRef<ReturnType<typeof setTimeout> \| null>\(null\)/.exec(source)
      expect(timerField, `${view} declares a timer ref`).not.toBeNull()
      const name = (timerField as RegExpExecArray)[1] as string
      expect(source).toContain(`useEffect(() => () => {`)
      expect(source).toContain(`clearTimeout(${name}.current)`)
    })
  }
})
