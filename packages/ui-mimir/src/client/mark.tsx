/**
 * The plugin's mark: a page with a node graph on it, drawn in `currentColor` so
 * every seat (sidebar panel row, right-pane tab, empty states) inherits the
 * surrounding colour instead of hard-coding one.
 * @module dsh-client-ui-mimir/client/mark
 */

import type { ReactElement } from 'react'

/**
 * @param props - the requested box size in px, defaulting to 16.
 * @returns the inline SVG glyph.
 */
export function ResearchMark({ size = 16 }: { readonly size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
      <path d="M3.5 2.2h5.2L12 5.5v8.3H3.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8.5 2.4v3.2h3.3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="6.2" cy="10.4" r="1" fill="currentColor" />
      <circle cx="9.6" cy="8.9" r="1" fill="currentColor" />
      <path d="M6.9 9.9 9 9.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}
