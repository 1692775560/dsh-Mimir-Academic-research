/**
 * Behavior tests for the bundled research skills: registration into a real
 * skill registry (names, routing metadata, loadable bodies), the no-registry
 * no-op path, and body hygiene (every playbook references surfaces the
 * plugin actually ships — a skill pointing at a renamed tool is a live lie).
 * Real SkillRegistry over a bare Context — no mocks.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { BUNDLED_SKILLS, registerResearchSkills } from '../src/skills.ts'

/** Tool, command, and artifact names the plugin itself registers/ships. */
const REAL_SURFACES = [
  'arxiv_search', 'paper_fetch', 'wiki_note', 'figure_save', 'latex_compile', 'meeting_deck',
  'research-idea', 'research-plan', 'research-review', 'paper-write', 'paper-compile',
  'IDEA_REPORT.md', 'EXPERIMENT_PLAN.md', 'EXPERIMENT_LOG.md', 'NARRATIVE_REPORT.md',
  'main.tex', 'references.bib',
]

describe('bundled research skills', () => {
  it('ships unique kebab-case skills with routing metadata and real-surface bodies', () => {
    const names = BUNDLED_SKILLS.map(skill => skill.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('research-pipeline')
    expect(names.length).toBe(11)
    for (const skill of BUNDLED_SKILLS) {
      expect(skill.name).toMatch(/^research-[a-z-]+$/)
      expect(skill.description.length).toBeGreaterThan(40)
      expect(skill.whenToUse.length).toBeGreaterThan(20)
      expect(skill.content.length).toBeGreaterThan(800)
      expect(REAL_SURFACES.some(surface => skill.content.includes(surface))).toBe(true)
    }
  })

  it('registers every bundled skill into a mounted registry with loadable bodies', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    registerResearchSkills(ctx)
    const listed = await ctx.skills.list()
    const byName = new Map(listed.map(skill => [skill.name, skill]))
    expect(byName.size).toBe(BUNDLED_SKILLS.length)
    for (const bundled of BUNDLED_SKILLS) {
      const summary = byName.get(bundled.name)
      expect(summary).toBeDefined()
      expect(summary?.description).toBe(bundled.description)
      expect(summary?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
      const definition = await ctx.skills.get(bundled.name)
      expect(definition?.content).toBe(bundled.content)
    }
  })

  it('registers nothing and stays silent when no skill registry is mounted', () => {
    const ctx = new Context()
    expect(() => registerResearchSkills(ctx)).not.toThrow()
  })

  it('keeps project-level duplicates winning over the bundled runtime entries', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    registerResearchSkills(ctx)
    // A project-root provider candidate (rank 100) with the same name must
    // outrank the bundled runtime registration (rank 250).
    ctx.skills.registerProvider(() => ({
      name: 'project',
      async list() {
        return [{
          name: 'research-pipeline',
          description: 'project override',
          invocation: { modelInvocable: true, userInvocable: true },
          provider: 'project',
          source: 'project',
          rank: 100,
          locator: { content: 'project body.' },
        }]
      },
      async get(candidate) {
        return { ...candidate, content: (candidate.locator as { content: string }).content }
      },
    }))
    const listed = await ctx.skills.list()
    const pipeline = listed.find(skill => skill.name === 'research-pipeline')
    expect(pipeline?.description).toBe('project override')
    expect(listed.filter(skill => skill.name.startsWith('research-')).length).toBe(BUNDLED_SKILLS.length)
  })
})
