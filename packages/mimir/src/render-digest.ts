/**
 * CBE digest renderer (S8d): the assembled report model (report-tier.ts)
 * laid out as **MMS** — the Mimir Markdown Subset. MMS is a controlled,
 * self-degrading slice: Core constructs (headings, bold, tables, lists,
 * task lists, blockquotes, inline code) render everywhere; Enhanced
 * constructs (`<details>` folds, `> [!NOTE]` callouts, Mermaid diagrams)
 * degrade to their Core equivalent when the renderer does not support them,
 * so the file is always readable in a bare editor.
 *
 * What MMS deliberately EXCLUDES (security and portability): inline `style`,
 * `<script>`, `<iframe>`, external fonts. The design comes from STRUCTURE —
 * hierarchy, whitespace, tables, callouts, folds — never from styling.
 *
 * The renderer is the export path. The panel (DigestView) renders the same
 * model directly; this string is what the researcher copies into a wiki,
 * an Obsidian vault, or a GitHub issue, where Mermaid and `<details>` come
 * alive.
 * @module dsh-mimir/src/render-digest
 */

import { formatCapsule, type CapsuleLang } from './report-capsules.ts'
import type { CbeDigestReport } from './report-tier.ts'
import { CBE_EUREKA_WINDOW_DAYS } from './eureka.ts'
import { MS_PER_DAY, tsToMs } from './time.ts'

/** Round to 3 decimals for stable EWS numbers in the table. */
function r3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Format one nullable EWS number, or an em dash when the sample was too small. */
function num(value: number | null): string {
  return value === null ? '—' : String(r3(value))
}

/** The report's title, by tier and language. */
function tierTitle(tier: CbeDigestReport['tier'], lang: CapsuleLang): string {
  if (tier === 'weekly') return lang === 'zh' ? '周报' : 'Weekly digest'
  if (tier === 'monthly') return lang === 'zh' ? '月报' : 'Monthly digest'
  return lang === 'zh' ? '项目总结' : 'Project summary'
}

/** Format one window as a human day-span. */
function daySpan(since: string, until: string): string {
  const from = tsToMs(since)
  const to = tsToMs(until)
  if (from === null || to === null) return '—'
  return `${Math.max(0, Math.round((to - from) / MS_PER_DAY))}`
}

/**
 * Render the report model as MMS markdown.
 * @param report - the assembled model.
 * @param lang - 'zh' or 'en'.
 * @returns the markdown string (always a Core-readable document).
 */
export function renderDigest(report: CbeDigestReport, lang: CapsuleLang): string {
  const L = lang === 'zh'
  const lines: string[] = []

  lines.push(`# ${tierTitle(report.tier, lang)} · ${report.window.since.slice(0, 10)} → ${report.window.until.slice(0, 10)}`)
  lines.push('')

  // PRISMA-style retrieval declaration (always the first block).
  const silences = report.retrieval.silences.length === 0
    ? (L ? '无' : 'none')
    : report.retrieval.silences.join(L ? '；' : '; ')
  lines.push(`> ${L ? '检索声明' : 'Retrieval'}: ${report.retrieval.source} · ${report.window.since.slice(0, 10)} → ${report.window.until.slice(0, 10)}（${daySpan(report.window.since, report.window.until)}${L ? ' 天' : 'd'}）· ${L ? '命中' : 'hit'} ${report.retrieval.eventsHit} / ${report.retrieval.eventsTotal} · CBE v${report.retrieval.derivationVersion}`)
  lines.push(`> ${L ? '沉默' : 'Silent'}: ${silences}`)
  lines.push(`> ${L ? '本报告为描述，不含建议。' : 'This report describes; it offers no advice.'}`)
  lines.push('')

  // Front-matter big-number table (key/value, the most portable shape).
  if (report.overview.length > 0) {
    lines.push(`## ${L ? '一览' : 'At a glance'}`)
    lines.push('')
    lines.push(`| ${L ? '指标' : 'metric'} | ${L ? '值' : 'value'} |`)
    lines.push('| --- | --- |')
    for (const stat of report.overview) {
      lines.push(`| ${stat.label[lang]} | ${stat.value} |`)
    }
    lines.push('')
  }

  // The six perspectives, each a foldable block (Enhanced → Core quote).
  for (const block of report.perspectives) {
    const count = block.capsules.reduce((sum, capsule) => sum + capsule.evidence.length, 0)
    lines.push(`<details open><summary>${block.label[lang]}（${L ? '证据' : 'evidence'} ${count}）</summary>`)
    lines.push('')
    for (const capsule of block.capsules) {
      const oneLiner = formatCapsule(capsule, lang)
      const evidence = capsule.evidence.length === 0
        ? ''
        : ` · ${L ? '证据' : 'evidence'} ${capsule.evidence.map(id => id.replace(/^ev-/, '')).join(' · ')}`
      lines.push(`- ${oneLiner}${evidence}`)
    }
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  // Eureka EWS table — project tier only, descriptive, with a small-sample warning.
  if (report.eurekaTable.length > 0) {
    lines.push(`## ${L ? 'Eureka 里程碑与它的前奏' : 'Eureka milestones and their lead-ins'}`)
    lines.push('')
    // The window length comes from the engine, not from this string: a copy
    // typed here keeps describing a fortnight after the parameter moves.
    lines.push(`| # | ${L ? '日期' : 'date'} | ${L ? '里程碑' : 'milestone'} | ${L ? `前 ${CBE_EUREKA_WINDOW_DAYS} 天熵率` : `${CBE_EUREKA_WINDOW_DAYS}-day lead entropy rate`} | ${L ? '对照窗' : 'control'} | lift |`)
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const row of report.eurekaTable) {
      const lift = row.leadMeanSurprisal !== null && row.controlMeanSurprisal !== null
        ? r3(row.leadMeanSurprisal - row.controlMeanSurprisal)
        : '—'
      lines.push(`| ${row.index} | ${row.at.slice(0, 10)} | ${row.title} | ${num(row.leadEntropyRate)} | ${num(row.controlEntropyRate)} | ${lift} |`)
    }
    lines.push('')
    lines.push(`> [!WARNING] ${L ? `样本 ${report.eurekaTable.length} 次，低于稳健阈值 —— 这是趋势描述，不是定律。` : `Sample ${report.eurekaTable.length}: below the robust threshold — a trend description, not a law.`}`)
    lines.push('')
  }

  // The worktree shape — project tier only, a Mermaid fold.
  if (report.mermaid !== null) {
    lines.push(`## ${L ? '这一路的形状' : 'The shape of the road'}`)
    lines.push('')
    lines.push('<details><summary>' + (L ? '完整工作树（Mermaid）' : 'Full worktree (Mermaid)') + '</summary>')
    lines.push('')
    lines.push('```mermaid')
    lines.push(report.mermaid)
    lines.push('```')
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  // The one slot the researcher fills in themselves.
  lines.push(`## ${L ? '我自己的话' : 'In my own words'}`)
  lines.push('')
  lines.push('- [ ] ')
  lines.push('')

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
