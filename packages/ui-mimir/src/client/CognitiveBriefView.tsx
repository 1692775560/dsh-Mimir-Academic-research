/**
 * The cognitive brief (CBE) card of the ledger view: the DDM-lite roadbook
 * of the selected window — rendered as a printed sheet, downloadable as
 * Markdown — its boundary questions as interactive confirmation cards, and
 * the L2 journal box beneath them, the one place the user writes their own
 * words onto the map (read back by the brief, never weighed as evidence).
 * All reads and writes flow through the injected controller verbs; this
 * component owns only the draft state and the copy/download actions.
 * @module dsh-client-ui-mimir/client/CognitiveBriefView
 */

import { useEffect, useRef, useState } from 'react'
import type { ResearchBriefQuestion, ResearchGenerateBriefOptions, ResearchJournalQuestionRef } from 'dsh-mimir/types'
import type { ResearchBriefView, ResearchFailureView } from './controller.ts'
import type { ResearchT } from './view-common.ts'
import { renderMarkdown } from './MarkdownView.tsx'
import type { LedgerWindow } from './ledger-view.ts'
import { briefFileName, briefWindowOptions, journalTextState, JOURNAL_MAX_CHARS } from './brief-view.ts'
import css from './ResearchPanel.module.css'

/**
 * @param props - the brief slice, the shared window/scope, the controller
 * verbs, and copy.
 * @returns the cognitive brief card (brief sheet + journal box).
 */
export function CognitiveBriefView({
  brief, briefWindow, scopedProjectId, generateBrief, addJournal, refreshLedger, t,
}: {
  readonly brief: ResearchBriefView
  readonly briefWindow: LedgerWindow
  readonly scopedProjectId: string | null
  readonly generateBrief: (options: ResearchGenerateBriefOptions) => Promise<ResearchFailureView | null>
  readonly addJournal: (
    text: string,
    projectId: string | null,
    refs?: { ideaId?: string | undefined; valence?: number | undefined; arousal?: number | undefined; question?: ResearchJournalQuestionRef | undefined },
  ) => Promise<ResearchFailureView | null>
  readonly refreshLedger: () => void
  readonly t: ResearchT
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cancel a pending copy-state reset on unmount.
  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
  }, [])
  const [draft, setDraft] = useState('')
  const [writing, setWriting] = useState(false)
  const [journalError, setJournalError] = useState<string | null>(null)
  // Self-reported mood ratings (1–5), null = the user chose not to tag one.
  const [valence, setValence] = useState<number | null>(null)
  const [arousal, setArousal] = useState<number | null>(null)
  // The line a boundary-question answer is being written against, or null.
  const [activeIdeaId, setActiveIdeaId] = useState<string | null>(null)
  // The question card being answered (the I4 meta event's source), or null.
  const [activeQuestion, setActiveQuestion] = useState<ResearchJournalQuestionRef | null>(null)

  const state = journalTextState(draft)

  /**
   * Answer one boundary question: prefill the journal box against the
   * question's line (the No/Yes the user prunes the possibility space
   * with), as an editable draft — the ruling lands as an L2 journal event
   * the agent and the next brief can both read.
   */
  const onAnswer = (question: ResearchBriefQuestion): void => {
    setActiveIdeaId(
      question.kind === 'returning-branch' && !question.lineId.startsWith('project:') ? question.lineId : null,
    )
    setActiveQuestion({ kind: question.kind, lineId: question.lineId })
    setDraft(t('journal.ruling.template', { line: question.label }))
    setJournalError(null)
  }

  const onGenerate = async (): Promise<void> => {
    if (brief.status === 'loading') return
    await generateBrief(briefWindowOptions(briefWindow, scopedProjectId, Date.now()))
  }

  const onDownload = (): void => {
    if (brief.status !== 'ready') return
    const blob = new Blob([brief.markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = briefFileName(brief.generatedAt, Date.now())
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
  }

  const onCopy = async (): Promise<void> => {
    if (brief.status !== 'ready') return
    try {
      await navigator.clipboard.writeText(brief.markdown)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => { setCopyState('idle') }, 1600)
  }

  // The L2 write: one journal line lands in the ledger, the timeline
  // refreshes, and a ready brief re-renders so the new words appear in it.
  const onWrite = async (): Promise<void> => {
    if (state !== 'ok' || writing) return
    setWriting(true)
    const failure = await addJournal(draft, scopedProjectId, {
      ...(activeIdeaId === null ? {} : { ideaId: activeIdeaId }),
      ...(valence === null ? {} : { valence }),
      ...(arousal === null ? {} : { arousal }),
      ...(activeQuestion === null ? {} : { question: activeQuestion }),
    })
    setWriting(false)
    if (failure !== null) {
      setJournalError(failure.message)
      return
    }
    setDraft('')
    setValence(null)
    setArousal(null)
    setActiveIdeaId(null)
    setActiveQuestion(null)
    setJournalError(null)
    refreshLedger()
    if (brief.status === 'ready') {
      void generateBrief(briefWindowOptions(briefWindow, scopedProjectId, Date.now()))
    }
  }

  const generatedAt = brief.generatedAt ?? new Date().toISOString()

  return (
    <section className={css.reportCard}>
      <div className={css.reportCardHead}>
        <h3 className={css.reportCardTitle}>{t('brief.title')}</h3>
        <div className={css.viewActions}>
          <button
            type="button"
            className={css.btn}
            onClick={() => { void onCopy() }}
            disabled={brief.status !== 'ready'}
          >
            {copyState === 'copied' ? t('brief.copied') : t('brief.copy')}
          </button>
          <button
            type="button"
            className={css.btn}
            onClick={onDownload}
            disabled={brief.status !== 'ready'}
          >
            {t('brief.download')}
          </button>
          <button
            type="button"
            className={css.btnPrimary}
            onClick={() => { void onGenerate() }}
            disabled={brief.status === 'loading'}
          >
            {brief.status === 'loading' ? t('brief.generating') : t('brief.generate')}
          </button>
        </div>
      </div>
      {brief.status === 'error' && (
        <p className={css.failure} role="status">
          {brief.failure?.message ?? t('brief.failed')}
          <button type="button" className={css.retry} onClick={() => { void onGenerate() }}>
            {t('error.retry')}
          </button>
        </p>
      )}
      {brief.status === 'ready' && (
        <div className={css.reportSheet}>
          <p className={css.reportMeta}>
            <span>{t('brief.generatedAt')} {new Date(generatedAt).toLocaleString()}</span>
            <span>{brief.eventCount} {t('brief.events')}</span>
            <span>{t('brief.derivation')} v{String(brief.derivationVersion ?? '?')}</span>
          </p>
          {brief.recalibrated && (
            <p className={css.hint} role="status">{t('brief.recalibrated')}</p>
          )}
          {renderMarkdown(brief.markdown)}
        </div>
      )}

      {/* The boundary confirmation cards: the agent's questions, the user's
          No/Yes rulings — each answer lands as an L2 journal line. */}
      {brief.status === 'ready' && brief.questions.length > 0 && (
        <div className={css.questionList}>
          {brief.questions.map(question => (
            <div key={`${question.kind}:${question.lineId}`} className={css.questionCard}>
              <span className={css.questionKind}>{t(`brief.question.${question.kind}`)}</span>
              <span className={css.questionLine}>{question.label}</span>
              <button type="button" className={css.btn} onClick={() => { onAnswer(question) }}>
                {t('journal.answer')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* The L2 write box: the map's only pen belongs to the user. */}
      <div className={css.journalBox}>
        <div className={css.journalHead}>
          <label className={css.reportCardTitle} htmlFor="mimir-journal-text">{t('journal.title')}</label>
          <span className={css.journalScope}>
            {activeIdeaId !== null
              ? `${t('journal.scope.line')} ${activeIdeaId}`
              : scopedProjectId !== null ? t('journal.scope.project') : t('journal.scope.all')}
          </span>
        </div>
        <textarea
          id="mimir-journal-text"
          className={css.journalInput}
          rows={2}
          placeholder={t('journal.placeholder')}
          value={draft}
          onChange={event => { setDraft(event.target.value) }}
        />
        <div className={css.journalFoot}>
          <span className={css.journalCount} data-over={state === 'too-long' || undefined}>
            {draft.length}/{JOURNAL_MAX_CHARS}
          </span>
          <span className={css.journalMood}>
            <label className={css.journalMoodLabel} htmlFor="mimir-journal-valence">{t('journal.valence')}</label>
            <select
              id="mimir-journal-valence"
              className={css.journalSelect}
              value={valence === null ? '' : String(valence)}
              onChange={event => { setValence(event.target.value === '' ? null : Number(event.target.value)) }}
            >
              <option value="">—</option>
              {[1, 2, 3, 4, 5].map(rating => <option key={rating} value={rating}>{rating}</option>)}
            </select>
            <label className={css.journalMoodLabel} htmlFor="mimir-journal-arousal">{t('journal.arousal')}</label>
            <select
              id="mimir-journal-arousal"
              className={css.journalSelect}
              value={arousal === null ? '' : String(arousal)}
              onChange={event => { setArousal(event.target.value === '' ? null : Number(event.target.value)) }}
            >
              <option value="">—</option>
              {[1, 2, 3, 4, 5].map(rating => <option key={rating} value={rating}>{rating}</option>)}
            </select>
          </span>
          {state === 'too-long' && (
            <span className={css.journalOver}>{t('journal.tooLong', { count: String(JOURNAL_MAX_CHARS) })}</span>
          )}
          <button
            type="button"
            className={css.btnPrimary}
            onClick={() => { void onWrite() }}
            disabled={state !== 'ok' || writing}
          >
            {writing ? t('journal.writing') : t('journal.submit')}
          </button>
        </div>
        {journalError !== null && (
          <p className={css.failure} role="status">{journalError}</p>
        )}
      </div>
    </section>
  )
}
