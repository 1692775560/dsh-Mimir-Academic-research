/**
 * The paper view: the Overleaf-style editing surface — a clickable outline
 * rail, the `main.tex` editor with a synced line-number gutter, a dependency-
 * free LaTeX syntax-highlight overlay (transparent-text textarea over a
 * token-rendered pre, degrading to plain past HIGHLIGHT_MAX_LENGTH). The
 * overlay and the line-number gutter are windowed: only the viewport's lines
 * (plus an overscan) mount as DOM, the rest is fixed-height spacers, so a
 * multi-thousand-line `main.tex` no longer rebuilds thousands of nodes per
 * keystroke. Then the autosave status pill, the compile row with the
 * severity-colored issue list
 * (click jumps the editor to the line), the iframe PDF preview, and the
 * bibliography panel that replaces the preview while open. The three panes
 * are resizable through drag handles (the widths persist to localStorage) and
 * the editor/preview panes can each take the full content area; below the
 * narrow breakpoint they degrade to a one-pane tab layout and the outline
 * rail hides.
 * @module dsh-client-ui-mimir/client/PaperView
 */

import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { BibEntry, OutlineNode, PaperSnapshotView, SectionMove, SectionOutlineTitles, SubsectionMove, VenueView } from 'dsh-mimir/types'
import type {
  ResearchBibView, ResearchCompileView, ResearchFailureView, ResearchImportCounts,
  ResearchOutlineView, ResearchPaperJump, ResearchPapersView, ResearchProjectSlice,
  ResearchSnapshotDetailView, ResearchSourceView, ResearchVenueTemplatesView,
} from './controller.ts'
import { VenuePicker } from './VenuePicker.tsx'
import { wrapIndex } from './focus.ts'
import { buildCompileFixPrompt } from './compile-fix.ts'
import { EDITOR_LINE_HEIGHT_PX, splitTokensByLine, visibleLineRange, widestLine } from './highlight-window.ts'
import { HIGHLIGHT_MAX_LENGTH, tokenizeLatex } from './latex-highlight.ts'
import {
  editorShareFromDrag, loadPaperLayout, PAPER_LAYOUT_DEFAULT, PAPER_LAYOUT_STORAGE_KEY,
  PAPER_NARROW_BREAKPOINT, paperSoloPane, RAIL_COLLAPSED_STRIP, RAIL_MAX_WIDTH, railWidthForContainer,
  railWidthFromDrag, serializePaperLayout,
  type PaperLayout, type PaperSoloPane,
} from './paper-layout.ts'
import type { PaperFullscreen } from './store.ts'
import { failureCopy, lineRangeOf, outlineSectionTitles, SAVE_KEYS, sectionMoveFromDrop, subsectionMoveFromDrop } from './view-common.ts'
import type { ResearchT, SubsectionDrag } from './view-common.ts'
import { BibPanel } from './BibPanel.tsx'
import { SnapshotsPanel } from './SnapshotsPanel.tsx'
import css from './ResearchPanel.module.css'

/** Editor line height in px (re-exported name kept local to the jump math). */
const EDITOR_LINE_HEIGHT = EDITOR_LINE_HEIGHT_PX

/** How long the jumped-to gutter row stays flashed. */
const GUTTER_FLASH_MS = 1200

/** Keyboard-resize step of the outline-rail handle (px per arrow press). */
const RAIL_KEY_STEP = 16
/** Keyboard-resize step of the editor/preview split handle (px per arrow press). */
const SPLIT_KEY_STEP = 24

/** 16×16 pane-fullscreen icons: corner brackets out (enter) / in (exit). */
const EXPAND_ICON: ReactNode = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6.2 2.5H2.5v3.7M9.8 2.5h3.7v3.7M6.2 13.5H2.5V9.8M9.8 13.5h3.7V9.8" />
  </svg>
)
const COMPRESS_ICON: ReactNode = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6.2 2.5v3.7H2.5M9.8 2.5v3.7h3.7M6.2 13.5V9.8H2.5M9.8 13.5V9.8h3.7" />
  </svg>
)

/** 16×16 double chevron for the outline-rail fold toggle (rotated 180° while
 *  collapsed), matching the sidebar's fold control. */
const RAIL_FOLD_ICON: ReactNode = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 3.5 6 8l3.5 4.5" />
    <path d="M12.5 3.5 9 8l3.5 4.5" />
  </svg>
)

/** Track one media query; re-renders when the match flips (e.g. a resize). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = (): void => { setMatches(media.matches) }
    onChange()
    media.addEventListener('change', onChange)
    return () => { media.removeEventListener('change', onChange) }
  }, [query])
  return matches
}

/** 10×14 grip icon: two columns of three dots (the drag affordance). */
const GRIP_ICON: ReactNode = (
  <svg viewBox="0 0 10 14" fill="currentColor" aria-hidden>
    <circle cx="3" cy="2.5" r="1.2" /><circle cx="7" cy="2.5" r="1.2" />
    <circle cx="3" cy="7" r="1.2" /><circle cx="7" cy="7" r="1.2" />
    <circle cx="3" cy="11.5" r="1.2" /><circle cx="7" cy="11.5" r="1.2" />
  </svg>
)

/** What one outline drag gesture carries (a section or a subsection). */
interface OutlineDragNode {
  readonly level: 1 | 2
  /** Parent section title (level-2 drags only). */
  readonly sectionTitle: string | undefined
  readonly title: string
}

/** The insertion indicator's location: one list plus the index in its CURRENT order. */
interface OutlineInsert {
  readonly listId: string
  readonly index: number
}

/** Mid-gesture state and callbacks the root tree hands down to every list. */
interface OutlineReorderCtx {
  readonly drag: OutlineDragNode | null
  readonly insert: OutlineInsert | null
  readonly startDrag: (node: OutlineDragNode, event: ReactDragEvent) => void
  readonly endDrag: () => void
  readonly overRow: (listId: string, index: number, event: ReactDragEvent) => void
  readonly overZone: (listId: string, event: ReactDragEvent) => void
  readonly drop: (listId: string) => void
}

/** List id of the top-level section list. */
const ROOT_LIST = 'root'
/** List id prefix of one section's subsection list (`sub:<section title>`). */
const SUB_PREFIX = 'sub:'

/**
 * One outline list, recursing through children; click jumps the editor. When
 * `ctx` is given, level-1 and level-2 rows gain a drag grip and the list
 * shows an insertion indicator under the pointer — but only while the dragged
 * node's level matches the list's (sections reorder among sections,
 * subsections among any section's subsections).
 */
function OutlineRows({ nodes, listId, level, parentTitle, onJump, ctx, gripLabel, dropZoneLabel }: {
  readonly nodes: readonly OutlineNode[]
  readonly listId: string
  readonly level: 1 | 2 | 3
  readonly parentTitle: string | undefined
  readonly onJump: (line: number) => void
  readonly ctx: OutlineReorderCtx | undefined
  readonly gripLabel?: string | undefined
  readonly dropZoneLabel?: string | undefined
}) {
  const accepts = ctx !== undefined && ctx.drag !== null && ctx.drag.level === level
  return (
    <ul className={css.outlineTree}>
      {nodes.map((node, index) => (
        <li key={`${node.line}:${node.title}`}>
          {ctx === undefined || level === 3 ? (
            <button type="button" className={css.outlineItem} onClick={() => { onJump(node.line) }}>
              {node.title} <span className={css.outlineLine}>L{node.line}</span>
            </button>
          ) : (
            <div
              className={css.outlineRow}
              onDragOver={(event) => { ctx.overRow(listId, index, event) }}
              onDrop={(event) => {
                event.preventDefault()
                ctx.drop(listId)
              }}
            >
              {accepts && ctx.insert?.listId === listId && ctx.insert.index === index && (
                <div className={css.dropIndicator} aria-hidden />
              )}
              <span
                className={css.outlineGrip}
                draggable
                title={gripLabel}
                aria-label={gripLabel}
                onDragStart={(event) => {
                  ctx.startDrag({ level, sectionTitle: level === 2 ? parentTitle : undefined, title: node.title }, event)
                }}
                onDragEnd={ctx.endDrag}
              >
                {GRIP_ICON}
              </span>
              <button type="button" className={css.outlineItem} onClick={() => { onJump(node.line) }}>
                {node.title} <span className={css.outlineLine}>L{node.line}</span>
              </button>
            </div>
          )}
          {level !== 3 && node.children.length > 0 && (
            <OutlineRows
              nodes={node.children}
              listId={`${SUB_PREFIX}${node.title}`}
              level={level === 1 ? 2 : 3}
              parentTitle={node.title}
              onJump={onJump}
              ctx={ctx}
              gripLabel={gripLabel}
              dropZoneLabel={dropZoneLabel}
            />
          )}
          {level === 1 && node.children.length === 0 && ctx?.drag?.level === 2 && (
            <ul className={css.outlineTree}>
              <li
                className={css.outlineDropZone}
                data-active={ctx.insert?.listId === `${SUB_PREFIX}${node.title}` || undefined}
                onDragOver={(event) => { ctx.overZone(`${SUB_PREFIX}${node.title}`, event) }}
                onDrop={(event) => {
                  event.preventDefault()
                  ctx.drop(`${SUB_PREFIX}${node.title}`)
                }}
              >
                {dropZoneLabel}
              </li>
            </ul>
          )}
        </li>
      ))}
      {accepts && ctx.insert?.listId === listId && ctx.insert.index === nodes.length && (
        <li className={css.dropIndicator} aria-hidden />
      )}
    </ul>
  )
}

/**
 * The outline tree root: owns the mid-gesture drag state and translates a
 * drop into the section or subsection callback of `reorder`.
 */
function OutlineTree({ nodes, onJump, reorder, gripLabel, dropZoneLabel }: {
  readonly nodes: readonly OutlineNode[]
  readonly onJump: (line: number) => void
  readonly reorder?: {
    onDropSection: (title: string, insertAt: number) => void
    onDropSubsection: (drag: SubsectionDrag, targetSectionTitle: string, insertAt: number) => void
  } | undefined
  readonly gripLabel?: string | undefined
  readonly dropZoneLabel?: string | undefined
}) {
  const [drag, setDrag] = useState<OutlineDragNode | null>(null)
  const [insert, setInsert] = useState<OutlineInsert | null>(null)
  const endDrag = (): void => {
    setDrag(null)
    setInsert(null)
  }
  const ctx: OutlineReorderCtx | undefined = reorder === undefined ? undefined : {
    drag,
    insert,
    startDrag: (node, event) => {
      setDrag(node)
      event.dataTransfer.setData('text/plain', node.title)
      event.dataTransfer.effectAllowed = 'move'
    },
    endDrag,
    overRow: (listId, index, event) => {
      // Only the lists matching the dragged level accept the gesture.
      if (drag === null || (drag.level === 1) !== (listId === ROOT_LIST)) return
      event.preventDefault()
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      const after = event.clientY > rect.top + rect.height / 2
      setInsert({ listId, index: after ? index + 1 : index })
    },
    overZone: (listId, event) => {
      if (drag === null || drag.level !== 2) return
      event.preventDefault()
      setInsert({ listId, index: 0 })
    },
    drop: (listId) => {
      const node = drag
      const target = insert
      endDrag()
      if (node === null || target === null || target.listId !== listId) return
      if (node.level === 1) {
        if (listId === ROOT_LIST) reorder.onDropSection(node.title, target.index)
        return
      }
      if (node.sectionTitle !== undefined && listId.startsWith(SUB_PREFIX)) {
        reorder.onDropSubsection(
          { sectionTitle: node.sectionTitle, title: node.title },
          listId.slice(SUB_PREFIX.length),
          target.index,
        )
      }
    },
  }
  return (
    <OutlineRows
      nodes={nodes}
      listId={ROOT_LIST}
      level={1}
      parentTitle={undefined}
      onJump={onJump}
      ctx={ctx}
      gripLabel={gripLabel}
      dropZoneLabel={dropZoneLabel}
    />
  )
}

/**
 * @param props - the paper slice views, the selected project and its paperDir,
 * the inject verbs, and copy.
 * @returns the editing surface.
 */
export function PaperView({
  outline, compileView, source, projectId, projectTitle, dir, editSource, reloadSource, compile, requestCompileFix,
  bib, papers, ensureBibliography, reloadBibliography, deleteBibEntry, updateBibEntry, importPapersToBib,
  ensurePapers, reorderPaperSections, reorderPaperSubsections, paperJump, consumePaperJump, fullscreen, setFullscreen,
  snapshots, snapshotDetail, loadSnapshots, loadSnapshotDetail, closeSnapshotDetail, revertSnapshot,
  venue, venueTemplates, ensureVenueTemplates, applyVenueTemplate, clearVenueTemplate, uploadTemplateFiles, requestVenueFormat,
  t,
}: {
  readonly outline: ResearchOutlineView | null
  readonly compileView: ResearchCompileView
  readonly source: ResearchSourceView | null
  readonly projectId: string | null
  /** Title of the selected project, shown as a strip on top of the panes. */
  readonly projectTitle: string | undefined
  readonly dir: string | undefined
  /** The selected project's target venue; undefined until one is applied. */
  readonly venue: VenueView | undefined
  /** The venue picker's built-in template registry slice. */
  readonly venueTemplates: ResearchVenueTemplatesView
  readonly ensureVenueTemplates: () => void
  readonly applyVenueTemplate: (
    projectId: string,
    options: { templateId?: string | undefined; customName?: string | undefined },
  ) => Promise<ResearchFailureView | null>
  readonly clearVenueTemplate: (projectId: string) => Promise<ResearchFailureView | null>
  readonly uploadTemplateFiles: (projectId: string, dir: string | undefined, files: readonly File[]) => Promise<void>
  /** Send one assembled venue-format prompt to the current session's agent. */
  readonly requestVenueFormat: (prompt: string) => Promise<void>
  readonly editSource: (content: string) => void
  readonly reloadSource: () => void
  readonly compile: (projectId: string) => void
  /** Send one issue's assembled fix prompt to the current session's agent. */
  readonly requestCompileFix: (prompt: string) => Promise<void>
  readonly bib: ResearchBibView | null
  readonly papers: ResearchPapersView
  readonly ensureBibliography: (projectId: string) => void
  readonly reloadBibliography: () => void
  readonly deleteBibEntry: (key: string) => Promise<ResearchFailureView | null>
  readonly updateBibEntry: (originalKey: string, entry: BibEntry) => Promise<ResearchFailureView | null>
  readonly importPapersToBib: (
    projectId: string,
    arxivIds: string[],
  ) => Promise<ResearchFailureView | ResearchImportCounts>
  readonly ensurePapers: () => void
  readonly reorderPaperSections: (
    projectId: string,
    moves: readonly SectionMove[],
    baseOutline: readonly string[],
  ) => Promise<ResearchFailureView | null>
  readonly reorderPaperSubsections: (
    projectId: string,
    moves: readonly SubsectionMove[],
    baseOutline: readonly SectionOutlineTitles[],
  ) => Promise<ResearchFailureView | null>
  /** The pending figure-insert jump ticket, or null. */
  readonly paperJump: ResearchPaperJump | null
  /** Clear the jump ticket once the caret has moved. */
  readonly consumePaperJump: () => void
  /** The pane holding fullscreen (from the shared store so Esc can exit it), or null. */
  readonly fullscreen: PaperFullscreen | null
  readonly setFullscreen: (pane: PaperFullscreen | null) => void
  /** The selected project's snapshot list; null until the snapshots panel first opens. */
  readonly snapshots: ResearchProjectSlice<readonly PaperSnapshotView[]> | null
  /** The snapshot expanded for diffing; null when closed. */
  readonly snapshotDetail: ResearchSnapshotDetailView | null
  readonly loadSnapshots: (projectId: string, force?: boolean) => void
  readonly loadSnapshotDetail: (projectId: string, id: string) => void
  readonly closeSnapshotDetail: () => void
  readonly revertSnapshot: (projectId: string, id: string) => Promise<ResearchFailureView | null>
  readonly t: ResearchT
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorPaneRef = useRef<HTMLElement>(null)
  const previewPaneRef = useRef<HTMLElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Gutter row flashed after a jump (issue list or outline click).
  const [flashLine, setFlashLine] = useState<number | null>(null)
  // The bibliography panel replaces the PDF preview while open.
  const [bibOpen, setBibOpen] = useState(false)
  // The snapshots panel replaces the PDF preview while open (mutually
  // exclusive with the bib panel).
  const [snapOpen, setSnapOpen] = useState(false)
  // The last rejected section reorder, surfaced in the rail.
  const [reorderError, setReorderError] = useState<ResearchFailureView | null>(null)
  // The issue row whose fix prompt is in flight (one send at a time).
  const [fixingIndex, setFixingIndex] = useState<number | null>(null)
  // The textarea's viewport in lines/px: drives the windowed gutter and
  // highlight overlay. Coarsened to whole lines so mid-line scrolls don't
  // re-render.
  const [viewport, setViewport] = useState({ firstLine: 0, height: 0 })
  // Pane widths; restored from localStorage, written back on every settle.
  // The outline rail's collapsed flag persists inside the same record.
  const [layout, setLayout] = useState<PaperLayout>(() => loadPaperLayout(key => localStorage.getItem(key)))
  // Which drag handle is mid-gesture (drives the container's data-dragging).
  const [dragging, setDragging] = useState<'rail' | 'split' | null>(null)
  // The container's content-box width, feeding the rail's squeeze-first
  // clamping (the rail yields before the editor/preview minimums do).
  const [containerW, setContainerW] = useState(0)
  // Under the narrow breakpoint the editor/preview degrade to a one-pane tab
  // layout (the fullscreen CSS hides the other pane, the rail, and the
  // handles); `solo` is the pane that currently owns the content area.
  const narrow = useMediaQuery(`(max-width: ${PAPER_NARROW_BREAKPOINT}px)`)
  const [paperTab, setPaperTab] = useState<PaperSoloPane>('editor')
  const solo = paperSoloPane(narrow, paperTab, fullscreen)

  // A project switch closes the bib panel and exits fullscreen; both reload
  // for the new project on the next open.
  useEffect(() => {
    setBibOpen(false)
    setSnapOpen(false)
    setFullscreen(null)
    setReorderError(null)
  }, [projectId, setFullscreen])

  // Persist the pane widths so a reopen restores them.
  useEffect(() => {
    try {
      localStorage.setItem(PAPER_LAYOUT_STORAGE_KEY, serializePaperLayout(layout))
    } catch {
      // A full/blocked localStorage drops persistence; the layout still works.
    }
  }, [layout])

  // Track the container width so the outline rail can yield first when the
  // window squeezes (see railWidthForContainer).
  useEffect(() => {
    const container = containerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      setContainerW(Math.round(entries[0]?.contentRect.width ?? 0))
    })
    observer.observe(container)
    return () => { observer.disconnect() }
  }, [])

  /**
   * Start one drag on the rail handle: pointer-captured move events resize
   * the rail until pointerup/pointercancel.
   */
  const onRailHandleDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startRail = layout.collapsed || layout.rail === 0 ? 0 : layout.rail
    if (startRail === 0) setLayout(prev => ({ ...prev, collapsed: false }))
    setDragging('rail')
    const onMove = (move: PointerEvent): void => {
      setLayout(prev => ({ ...prev, rail: railWidthFromDrag(startRail, move.clientX - startX) }))
    }
    const onUp = (): void => {
      setDragging(null)
      handle.removeEventListener('pointermove', onMove)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp, { once: true })
    handle.addEventListener('pointercancel', onUp, { once: true })
  }

  /**
   * Start one drag on the editor/preview split handle: the measured pane
   * widths at drag start pin the px↔share conversion for the whole gesture.
   */
  const onSplitHandleDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startEditor = editorPaneRef.current?.getBoundingClientRect().width ?? 0
    const available = startEditor + (previewPaneRef.current?.getBoundingClientRect().width ?? 0)
    if (available <= 0) return
    setDragging('split')
    const onMove = (move: PointerEvent): void => {
      setLayout(prev => ({
        ...prev,
        editor: editorShareFromDrag(startEditor + move.clientX - startX, available),
      }))
    }
    const onUp = (): void => {
      setDragging(null)
      handle.removeEventListener('pointermove', onMove)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp, { once: true })
    handle.addEventListener('pointercancel', onUp, { once: true })
  }

  /** Sync the gutter and the highlight overlay to the textarea's viewport. */
  const syncEditorScroll = (): void => {
    const editor = editorRef.current
    if (editor === null) return
    if (gutterRef.current !== null) gutterRef.current.scrollTop = editor.scrollTop
    if (highlightRef.current !== null) {
      highlightRef.current.scrollTop = editor.scrollTop
      highlightRef.current.scrollLeft = editor.scrollLeft
    }
    // Feed the windowed gutter/overlay; state only moves when the first
    // visible line or the viewport height changes.
    const firstLine = Math.floor(editor.scrollTop / EDITOR_LINE_HEIGHT)
    const height = editor.clientHeight
    setViewport(prev => (prev.firstLine === firstLine && prev.height === height ? prev : { firstLine, height }))
  }

  // Pane drags and fullscreen flips resize the textarea without firing a
  // scroll event; the window must still follow the new viewport height.
  useEffect(() => {
    const editor = editorRef.current
    if (editor === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => { syncEditorScroll() })
    observer.observe(editor)
    return () => { observer.disconnect() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Keyboard twin of the rail-handle drag: ArrowLeft/ArrowRight resize the
   * outline rail in {@link RAIL_KEY_STEP} steps through the same clamping the
   * pointer drag uses. A rightward press on a collapsed rail re-expands it to
   * the default width first (the drag's snap-to-0 would eat a small step).
   */
  const onRailHandleKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? RAIL_KEY_STEP : -RAIL_KEY_STEP
    setLayout(prev => ({
      ...prev,
      collapsed: delta > 0 ? false : prev.collapsed,
      rail: prev.rail === 0 && delta > 0 ? PAPER_LAYOUT_DEFAULT.rail : railWidthFromDrag(prev.rail, delta),
    }))
  }

  /**
   * Keyboard twin of the split-handle drag: ArrowLeft/ArrowRight shift the
   * editor/preview share in {@link SPLIT_KEY_STEP} steps, measured against the
   * live pane widths exactly like the pointer gesture does.
   */
  const onSplitHandleKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const editorWidth = editorPaneRef.current?.getBoundingClientRect().width ?? 0
    const available = editorWidth + (previewPaneRef.current?.getBoundingClientRect().width ?? 0)
    if (available <= 0) return
    const delta = event.key === 'ArrowRight' ? SPLIT_KEY_STEP : -SPLIT_KEY_STEP
    setLayout(prev => ({ ...prev, editor: editorShareFromDrag(editorWidth + delta, available) }))
  }

  /**
   * Arrow-key navigation for the outline rail: ArrowUp/ArrowDown move focus
   * between the visible outline entries (cycling past both ends); Enter still
   * activates the focused entry's click-to-jump, and drag reordering stays
   * pointer-only. Keys aimed elsewhere in the rail pass through.
   */
  const onOutlineKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(`.${css.outlineItem}`)]
    const current = items.indexOf(document.activeElement as HTMLElement)
    if (current < 0) return
    event.preventDefault()
    items[wrapIndex(current, event.key === 'ArrowDown' ? 1 : -1, items.length)]?.focus()
  }

  // Cancel a pending gutter flash on unmount.
  useEffect(() => () => {
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
  }, [])

  /**
   * Move the editor caret and viewport to one 1-based source line (the
   * outline's and the error list's click target, or the figure insert's
   * landing line), select the line's text, and
   * briefly flash its gutter row. Character offsets count newlines; the
   * scroll position estimates from the fixed line height.
   */
  const jumpToLine = (line: number): void => {
    const editor = editorRef.current
    if (editor === null) return
    const range = lineRangeOf(editor.value, line)
    if (range === null) return
    editor.focus()
    editor.setSelectionRange(range.start, range.end)
    editor.scrollTop = Math.max(0, (line - 3) * EDITOR_LINE_HEIGHT)
    syncEditorScroll()
    setFlashLine(line)
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => { setFlashLine(null) }, GUTTER_FLASH_MS)
  }

  const currentSource = source !== null && source.projectId === projectId ? source : null

  // A figure insert from the figures view (or its duplicate jump) carries a
  // ticket addressed to one project: once the editor shows that project's
  // ready draft — which already contains the new block — move the caret to
  // the block's first line and consume the ticket. A ticket for another
  // project (or a draft still loading) waits.
  useEffect(() => {
    if (paperJump === null || paperJump.projectId !== projectId) return
    if (currentSource === null || currentSource.status !== 'ready') return
    jumpToLine(paperJump.line)
    consumePaperJump()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fire only on a new ticket or a fresh draft
  }, [paperJump, projectId, currentSource])

  const compiling = compileView.state === 'running'
  const stateCopy = compiling
    ? t('compile.running')
    : compileView.state === 'ok'
      ? t('compile.ok')
      : compileView.state === 'error'
        ? t('compile.error')
        : t('compile.idle')
  // Show which engine produced the last settled compile ("编译成功 · tectonic").
  const compileStatusCopy = compileView.engine === null || compiling
    ? stateCopy
    : `${stateCopy} · ${compileView.engine}`
  const pdfUrl = projectId !== null
    && compileView.state === 'ok'
    && compileView.pdfUpdatedAt !== null
    && compileView.projectId === projectId
    ? `/research/pdf/${encodeURIComponent(projectId)}?v=${compileView.pdfUpdatedAt}`
      + (dir === undefined ? '' : `&dir=${encodeURIComponent(dir)}`)
    : null
  // Logical lines of the draft; everything line-based derives from this one
  // split so the gutter, the overlay, and the window never disagree.
  const sourceLines = useMemo(() => (currentSource?.content ?? '').split('\n'), [currentSource?.content])
  const lineCount = sourceLines.length
  // The highlight overlay's tokens; oversized sources degrade to plain text.
  const highlightTokens = useMemo(() => {
    const content = currentSource?.content ?? ''
    return content.length > 0 && content.length <= HIGHLIGHT_MAX_LENGTH ? tokenizeLatex(content) : null
  }, [currentSource?.content])
  // Per-line tokens for the windowed overlay (the split consumes newlines).
  const lineTokens = useMemo(
    () => (highlightTokens === null ? null : splitTokensByLine(highlightTokens)),
    [highlightTokens],
  )
  // Only the viewport ± overscan mounts as DOM; spacers keep the scrollable
  // geometry identical to the full render.
  const lineWindow = visibleLineRange(
    viewport.firstLine * EDITOR_LINE_HEIGHT, viewport.height, lineCount,
  )
  // Hidden sizer keeping the overlay's horizontal scroll extent in step with
  // the textarea even when the widest line is outside the window.
  const sizerLine = useMemo(() => widestLine(sourceLines), [sourceLines])

  // One "fix with AI" click: assemble the prompt from the issue and the
  // current draft window, then queue it into the current session. Toasts
  // carry the outcome; the agent's edits re-enter through reload/compile.
  const onFixIssue = (index: number, issue: ResearchCompileView['issues'][number]): void => {
    if (fixingIndex !== null) return
    setFixingIndex(index)
    const prompt = buildCompileFixPrompt({
      issue,
      source: currentSource !== null && currentSource.status === 'ready' ? currentSource.content : null,
      dir,
    })
    void requestCompileFix(prompt).finally(() => { setFixingIndex(null) })
  }

  // The overlay remounts when highlighting toggles; re-sync its scroll after
  // every token recompute so it never lags the textarea.
  useEffect(() => { syncEditorScroll() }, [highlightTokens])

  // The rail's rendered width: the persisted preference squeezed to what the
  // container can spare (the rail yields before the editor/preview minimums;
  // the 24px accounts for the two inter-pane gaps).
  const railWidth = railWidthForContainer(layout.rail, Math.max(0, containerW - 24))
  // The rail renders collapsed by its toggle, by a drag to 0, or by the
  // container squeezing it below the collapse threshold.
  const railGone = layout.collapsed || layout.rail === 0 || (containerW > 0 && railWidth === 0)
  /** Expand the collapsed rail, restoring the default width after a drag-to-0. */
  const expandRail = (): void => {
    setLayout(prev => ({
      ...prev,
      collapsed: false,
      rail: prev.rail === 0 ? PAPER_LAYOUT_DEFAULT.rail : prev.rail,
    }))
  }

  // The outline accepts drops only while the editor is clean: a successful
  // reorder reloads the source, discarding any unsaved draft.
  const reorderable = projectId !== null
    && outline !== null
    && outline.projectId === projectId
    && outline.status === 'ready'
    && currentSource !== null
    && currentSource.status === 'ready'
    && (currentSource.saveState === 'clean' || currentSource.saveState === 'saved')

  /**
   * Apply one drop: translate it into a section move against the current
   * top-level titles and commit it; a rejection stays visible in the rail.
   */
  const onDropSection = (title: string, insertAt: number): void => {
    if (projectId === null || outline === null || !reorderable) return
    const titles = outline.nodes.map(node => node.title)
    const move = sectionMoveFromDrop(titles, title, insertAt)
    if (move === null) return
    setReorderError(null)
    void reorderPaperSections(projectId, [move], titles).then((failure) => {
      setReorderError(failure)
    })
  }

  /**
   * Apply one subsection drop: translate it into a subsection move against the
   * current outline and commit it; a rejection stays visible in the rail.
   */
  const onDropSubsection = (drag: SubsectionDrag, targetSectionTitle: string, insertAt: number): void => {
    if (projectId === null || outline === null || !reorderable) return
    const move = subsectionMoveFromDrop(outline.nodes, drag, targetSectionTitle, insertAt)
    if (move === null) return
    setReorderError(null)
    void reorderPaperSubsections(projectId, [move], outlineSectionTitles(outline.nodes)).then((failure) => {
      setReorderError(failure)
    })
  }

  // The narrow-width editor/preview tab bar (CSS-hidden at full width); both
  // pane heads render it so the switch is reachable from whichever pane shows.
  const paneTabs = (
    <div className={css.paperTabs} role="tablist" aria-label={t('pane.tabs')}>
      {(['editor', 'preview'] as const).map(pane => (
        <button
          key={pane}
          type="button"
          role="tab"
          aria-selected={paperTab === pane}
          className={css.paperTab}
          data-active={paperTab === pane || undefined}
          onClick={() => { setPaperTab(pane) }}
        >
          {t(pane === 'editor' ? 'editor.title' : 'preview.title')}
        </button>
      ))}
    </div>
  )

  return (
    <div
      ref={containerRef}
      className={css.paperLayout}
      data-fullscreen={solo ?? undefined}
      data-dragging={dragging ?? undefined}
    >
      <aside
        className={css.outlineRail}
        data-collapsed={railGone || undefined}
        style={{ flexBasis: railGone ? RAIL_COLLAPSED_STRIP : railWidth }}
        aria-label={t('outline.title')}
        onKeyDown={onOutlineKeyDown}
      >
        {railGone ? (
          <button
            type="button"
            className={css.railToggle}
            aria-label={t('outline.expand')}
            aria-expanded={false}
            title={t('outline.expand')}
            onClick={expandRail}
          >
            {RAIL_FOLD_ICON}
          </button>
        ) : (
          <>
            <div className={css.railHead}>
              <h3 className={css.sectionTitle}>{t('outline.title')}</h3>
              <button
                type="button"
                className={css.railToggle}
                aria-label={t('outline.collapse')}
                aria-expanded
                title={t('outline.collapse')}
                onClick={() => { setLayout(prev => ({ ...prev, collapsed: true })) }}
              >
                {RAIL_FOLD_ICON}
              </button>
            </div>
            {projectId === null && <p className={css.hint}>{t('outline.hint')}</p>}
            {projectId !== null && (outline === null
              || outline.projectId !== projectId
              || outline.status === 'loading') && (
              <p className={css.hint}>{t('projects.loading')}</p>
            )}
            {projectId !== null && outline !== null
              && outline.projectId === projectId && outline.status === 'error' && (
              <p className={css.failure} role="status">
                {outline.failure?.code === 'paper-not-found'
                  ? t('outline.noPaper')
                  : `${t('error.outline')}：${failureCopy(t, outline.failure)}`}
              </p>
            )}
            {projectId !== null && outline !== null
              && outline.projectId === projectId && outline.status === 'ready'
              && (outline.nodes.length === 0
                ? <p className={css.hint}>{t('outline.empty')}</p>
                : (
                  <OutlineTree
                    nodes={outline.nodes}
                    onJump={jumpToLine}
                    reorder={reorderable ? { onDropSection, onDropSubsection } : undefined}
                    gripLabel={t('outline.drag')}
                    dropZoneLabel={t('outline.dropInto')}
                  />
                ))}
            {reorderError !== null && (
              <p className={css.failure} role="status">
                {reorderError.code === 'conflict'
                  ? t('outline.reorderConflict')
                  : `${t('outline.reorderFailed')}：${failureCopy(t, reorderError)}`}
              </p>
            )}
          </>
        )}
      </aside>
      <div
        className={css.splitHandle}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('pane.resize')}
        aria-valuenow={railGone ? 0 : Math.round(railWidth)}
        aria-valuemin={0}
        aria-valuemax={RAIL_MAX_WIDTH}
        tabIndex={0}
        data-active={dragging === 'rail' || undefined}
        onPointerDown={onRailHandleDown}
        onKeyDown={onRailHandleKey}
      />
      <section
        ref={editorPaneRef}
        className={css.editorPane}
        style={solo === null ? { flexGrow: layout.editor, flexBasis: 0 } : undefined}
      >
        <div className={css.editorHead}>
          <h3 className={css.sectionTitle}>{t('editor.title')}</h3>
          {projectTitle !== undefined && (
            <span className={css.paperProject} title={`${t('paper.project')}：${projectTitle}`}>
              {projectTitle}
            </span>
          )}
          {projectId !== null && projectTitle !== undefined && (
            <VenuePicker
              projectId={projectId}
              projectTitle={projectTitle}
              dir={dir}
              venue={venue}
              venueTemplates={venueTemplates}
              ensureVenueTemplates={ensureVenueTemplates}
              applyVenueTemplate={applyVenueTemplate}
              clearVenueTemplate={clearVenueTemplate}
              uploadTemplateFiles={uploadTemplateFiles}
              requestVenueFormat={requestVenueFormat}
              t={t}
            />
          )}
          {paneTabs}
          <div className={css.paneHeadActions}>
            {currentSource !== null && currentSource.status === 'ready' && (
              <span className={css.savePill} data-state={currentSource.saveState} role="status">
                {t(SAVE_KEYS[currentSource.saveState])}
              </span>
            )}
            {!narrow && (
              <button
                type="button"
                className={css.iconButton}
                title={fullscreen === 'editor' ? t('pane.exitFullscreen') : t('pane.fullscreen')}
                aria-label={fullscreen === 'editor' ? t('pane.exitFullscreen') : t('pane.fullscreen')}
                aria-pressed={fullscreen === 'editor'}
                onClick={() => { setFullscreen(fullscreen === 'editor' ? null : 'editor') }}
              >
                {fullscreen === 'editor' ? COMPRESS_ICON : EXPAND_ICON}
              </button>
            )}
          </div>
        </div>
        {currentSource !== null && currentSource.saveState === 'conflict' && (
          <p className={css.conflictBanner} role="alert">
            {t('save.conflict')}
            <button type="button" className={css.retry} onClick={reloadSource}>
              {t('save.reload')}
            </button>
          </p>
        )}
        {currentSource !== null && currentSource.status === 'error' && (
          <p className={css.failure} role="status">
            {currentSource.failure?.code === 'paper-not-found'
              ? t('outline.noPaper')
              : failureCopy(t, currentSource.failure)}
          </p>
        )}
        <div className={css.editorWrap}>
          <div ref={gutterRef} className={css.gutter} aria-hidden>
            {/* Windowed like the overlay: spacers above/below the mounted
                rows keep the gutter's scrollable height at lineCount lines. */}
            <div className={css.gutterSpacer} style={{ height: lineWindow.start * EDITOR_LINE_HEIGHT }} />
            {Array.from({ length: lineWindow.end - lineWindow.start }, (_, offset) => {
              const line = lineWindow.start + offset + 1
              return <div key={line} data-flash={line === flashLine || undefined}>{line}</div>
            })}
            <div className={css.gutterSpacer} style={{ height: (lineCount - lineWindow.end) * EDITOR_LINE_HEIGHT }} />
          </div>
          <div className={css.editorStack}>
            {lineTokens !== null && (
              <pre ref={highlightRef} className={css.editorHighlight} aria-hidden>
                <div style={{ height: lineWindow.start * EDITOR_LINE_HEIGHT }} />
                {lineTokens.slice(lineWindow.start, lineWindow.end).map((tokens, offset) => (
                  <div key={lineWindow.start + offset} className={css.editorHighlightLine}>
                    {tokens.map((token, index) => token.type === 'plain'
                      ? <Fragment key={index}>{token.text}</Fragment>
                      : <span key={index} data-tok={token.type}>{token.text}</span>)}
                  </div>
                ))}
                <div style={{ height: (lineCount - lineWindow.end) * EDITOR_LINE_HEIGHT }} />
                {/* Zero-height sizer: the doc's widest line keeps the pre's
                    scrollable width in step with the textarea's while only a
                    window of lines is mounted. Per-line divs already give the
                    pre the textarea's exact height, trailing newline included. */}
                <div className={css.editorHighlightSizer}>{sizerLine}</div>
              </pre>
            )}
            <textarea
              ref={editorRef}
              className={css.editor}
              data-highlighted={lineTokens !== null || undefined}
              spellCheck={false}
              value={currentSource?.content ?? ''}
              disabled={projectId === null || currentSource === null
                || currentSource.status !== 'ready' || currentSource.saveState === 'conflict'}
              onChange={(event) => { editSource(event.target.value) }}
              onScroll={syncEditorScroll}
            />
          </div>
        </div>
      </section>
      <div
        className={css.splitHandle}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('pane.resize')}
        aria-valuenow={Math.round(layout.editor * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        data-active={dragging === 'split' || undefined}
        onPointerDown={onSplitHandleDown}
        onKeyDown={onSplitHandleKey}
      />
      <section
        ref={previewPaneRef}
        className={css.previewPane}
        style={solo === null ? { flexGrow: 1 - layout.editor, flexBasis: 0 } : undefined}
      >
        <div className={css.compileRow}>
          {paneTabs}
          <button
            type="button"
            className={css.compileButton}
            disabled={projectId === null || compiling}
            onClick={() => { if (projectId !== null) compile(projectId) }}
          >
            {compiling ? t('compile.running') : t('compile.run')}
          </button>
          <span className={css.compileStatus} data-state={compileView.state} role="status">
            {compileStatusCopy}
          </span>
          <button
            type="button"
            className={css.bibToggle}
            disabled={projectId === null}
            data-active={bibOpen || undefined}
            aria-pressed={bibOpen}
            onClick={() => {
              setBibOpen(prev => !prev)
              setSnapOpen(false)
            }}
          >
            {bibOpen ? t('bib.close') : t('bib.open')}
          </button>
          <button
            type="button"
            className={css.snapToggle}
            disabled={projectId === null}
            data-active={snapOpen || undefined}
            aria-pressed={snapOpen}
            onClick={() => {
              setSnapOpen(prev => !prev)
              setBibOpen(false)
              if (snapOpen) closeSnapshotDetail()
            }}
          >
            {snapOpen ? t('snapshots.close') : t('snapshots.open')}
          </button>
          {!narrow && (
            <button
              type="button"
              className={css.iconButton}
              title={fullscreen === 'preview' ? t('pane.exitFullscreen') : t('pane.fullscreen')}
              aria-label={fullscreen === 'preview' ? t('pane.exitFullscreen') : t('pane.fullscreen')}
              aria-pressed={fullscreen === 'preview'}
              onClick={() => { setFullscreen(fullscreen === 'preview' ? null : 'preview') }}
            >
              {fullscreen === 'preview' ? COMPRESS_ICON : EXPAND_ICON}
            </button>
          )}
        </div>
        {compileView.issues.length > 0 && (
          <ul className={css.issueList} aria-label={t('issues.title')}>
            {compileView.issues.map((issue, index) => (
              <li key={`${index}:${issue.message}`} className={css.issueRow}>
                <button
                  type="button"
                  className={css.issue}
                  data-severity={issue.severity}
                  disabled={issue.line === undefined}
                  title={issue.line === undefined ? undefined : t('issues.jump')}
                  onClick={() => { if (issue.line !== undefined) jumpToLine(issue.line) }}
                >
                  <span className={css.issueDot} aria-hidden />
                  <span className={css.issueBody}>
                    {issue.line !== undefined && (
                      <span className={css.issueLine}>L{issue.line}</span>
                    )}
                    <span className={css.issueMessage}>{issue.message}</span>
                    {issue.file !== undefined && (
                      <span className={css.issueWhere}>{issue.file}</span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className={css.issueFix}
                  disabled={fixingIndex !== null}
                  title={t('issues.fixWithAi')}
                  aria-label={t('issues.fixWithAi')}
                  onClick={() => { onFixIssue(index, issue) }}
                >
                  {fixingIndex === index ? t('issues.fixingWithAi') : t('issues.fixWithAi')}
                </button>
              </li>
            ))}
          </ul>
        )}
        {bibOpen && projectId !== null
          ? (
            <BibPanel
              bib={bib}
              papers={papers}
              projectId={projectId}
              ensureBibliography={ensureBibliography}
              reloadBibliography={reloadBibliography}
              deleteBibEntry={deleteBibEntry}
              updateBibEntry={updateBibEntry}
              importPapersToBib={importPapersToBib}
              ensurePapers={ensurePapers}
              onClose={() => { setBibOpen(false) }}
              t={t}
            />
          )
          : snapOpen && projectId !== null
            ? (
              <SnapshotsPanel
                snapshots={snapshots}
                snapshotDetail={snapshotDetail}
                source={source}
                projectId={projectId}
                loadSnapshots={loadSnapshots}
                loadSnapshotDetail={loadSnapshotDetail}
                closeSnapshotDetail={closeSnapshotDetail}
                revertSnapshot={revertSnapshot}
                onClose={() => {
                  setSnapOpen(false)
                  closeSnapshotDetail()
                }}
                t={t}
              />
            )
            : pdfUrl === null
            ? (
              <div className={css.previewEmpty}>
                <span className={css.emptyGlyph} aria-hidden>📄</span>
                <span>{t('preview.empty')}</span>
              </div>
            )
            : <iframe className={css.previewFrame} title={t('preview.title')} src={pdfUrl} />}
      </section>
    </div>
  )
}
