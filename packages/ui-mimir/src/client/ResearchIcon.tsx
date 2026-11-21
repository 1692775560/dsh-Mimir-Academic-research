/**
 * The sidebar's global panel-row icon. The shell owns the row button, its
 * label, its active state and its click (the row id addresses the `main` panel
 * of the same name), so this component is the glyph alone — no store, no
 * actions, no copy.
 * @module dsh-client-ui-mimir/client/ResearchIcon
 */

import type { ReactElement } from 'react'
import type { ResearchPanelIconProps } from './slots.ts'
import { ResearchMark } from './mark.tsx'

/**
 * @param props - the row's owner state: requested icon size and active flag.
 * @returns the glyph at the requested size.
 */
export function ResearchIcon({ size }: ResearchPanelIconProps): ReactElement {
  return <ResearchMark size={size ?? 16} />
}
