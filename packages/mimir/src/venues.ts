/**
 * Built-in venue template registry. Each entry names a conference/journal
 * format an agent can re-layout a paper for: the official kit page, the
 * documentclass/style entry point, and a formatting checklist. The registry
 * is data only — applying one writes a `template/TEMPLATE.md` brief into the
 * paper directory; custom kits (user-uploaded `.cls`/`.sty`/...) live in the
 * same `template/` directory next to it.
 * @module dsh-mimir/src/venues
 */

/** One built-in venue format entry. */
export interface VenueTemplate {
  /** Stable machine id, e.g. `cvpr`. */
  readonly id: string
  /** Display name, e.g. `CVPR (IEEE/CVF Computer Vision and Pattern Recognition)`. */
  readonly name: string
  /** Grouping series for the picker (CV / ML / NLP / general). */
  readonly series: string
  /** Official formatting/instructions page (agent fetches the current kit from here). */
  readonly url: string
  /** Formatting brief baked into `template/TEMPLATE.md`. */
  readonly checklist: string
}

/** Built-in venue templates, grouped by `series` in the picker. */
export const VENUE_TEMPLATES: readonly VenueTemplate[] = Object.freeze([
  {
    id: 'cvpr',
    name: 'CVPR (IEEE/CVF)',
    series: 'CV',
    url: 'https://cvpr.thecvf.com/Conferences/2026/AuthorGuidelines',
    checklist: [
      'Use the current-year CVPR kit (`cvpr.sty`); download it from the official author guidelines page and place `cvpr.sty` next to `main.tex`.',
      '`\\documentclass[10pt,twocolumn,letterpaper]{article}` with `\\usepackage[review]{cvpr}` while under review (line numbers, anonymized); drop the `review` option for camera-ready.',
      'Main text is limited to 8 pages (references unlimited, on extra pages).',
      'Remove all author identities while under review (`\\author` left as the kit\'s anonymous placeholder).',
      'Bibliography via the kit\'s `ieee_fullname`/`ieeenat_fullname` style as instructed by the kit.',
    ].join('\n'),
  },
  {
    id: 'iccv',
    name: 'ICCV (IEEE/CVF)',
    series: 'CV',
    url: 'https://iccv.thecvf.com/',
    checklist: [
      'Use the current-year ICCV kit (`iccv.sty`) from the official site, placed next to `main.tex`.',
      '`\\documentclass[10pt,twocolumn,letterpaper]{article}` with `\\usepackage[review]{iccv}` under review.',
      'Main text limited to 8 pages; references on additional pages.',
      'Anonymous submission: no author names or acknowledgements.',
    ].join('\n'),
  },
  {
    id: 'eccv',
    name: 'ECCV',
    series: 'CV',
    url: 'https://eccv.ecva.net/',
    checklist: [
      'Use the current-year ECCV Springer LNCS-based kit (`eccv.sty` / `llncs.cls`) from the official site.',
      'Follow the kit\'s documentclass options exactly (review vs camera-ready differ).',
      'Respect the official page limit stated in the kit (LNCS format, typically 14 pages + references; verify against the current call).',
      'Anonymous submission while under review.',
    ].join('\n'),
  },
  {
    id: 'neurips',
    name: 'NeurIPS',
    series: 'ML',
    url: 'https://neurips.cc/Conferences/2025/CallForPapers',
    checklist: [
      'Use the current-year `neurips_<year>.sty` from the official call, placed next to `main.tex`.',
      '`\\documentclass{article}` + `\\usepackage{neurips_<year>}` (`[preprint]` for preprints, `final` for camera-ready; plain option = anonymous submission).',
      '10pt fonts, letterpaper, single column; main text page limit per the current call (recent years: 10 pages + unlimited references/appendix).',
      'Add the checklist section if the current call requires it.',
    ].join('\n'),
  },
  {
    id: 'icml',
    name: 'ICML',
    series: 'ML',
    url: 'https://icml.cc/Conferences/2026/CallForPapers',
    checklist: [
      'Use the current-year `icml<year>.sty` from the official call.',
      '`\\documentclass{article}` + `\\usepackage{icml<year>}` with the kit\'s options for submission vs camera-ready.',
      'Two-column proceedings format; respect the page limit in the current call.',
      'Anonymous submission: use the kit\'s `\\icmlauthor` placeholders only after acceptance.',
    ].join('\n'),
  },
  {
    id: 'iclr',
    name: 'ICLR',
    series: 'ML',
    url: 'https://iclr.cc/Conferences/2026/CallForPapers',
    checklist: [
      'Use the current-year `iclr<year>.sty` from the official call / OpenReview kit.',
      '`\\documentclass{article}` + `\\usepackage{iclr<year>}`; options distinguish submission (anonymous) from camera-ready.',
      'Single column; page limit per the current call (recent years: 10 content pages).',
    ].join('\n'),
  },
  {
    id: 'acl',
    name: 'ACL / *CL (ARR)',
    series: 'NLP',
    url: 'https://acl-org.github.io/ACLPUB/formatting.html',
    checklist: [
      'Use the current `acl.sty` + `acl_natbib.bst` from the ACLPUB kit.',
      '`\\documentclass[11pt]{article}` + `\\usepackage[review]{acl}` under review; remove `review` for camera-ready.',
      'Two-column; long papers 8 pages, short papers 4 pages (references unlimited on extra pages).',
      'Citations through `acl_natbib` commands (`\\citep`, `\\citet`).',
      'Include the required Limitations section (and Ethics where applicable).',
    ].join('\n'),
  },
  {
    id: 'aaai',
    name: 'AAAI',
    series: 'ML',
    url: 'https://aaai.org/authorkit/',
    checklist: [
      'Use the current-year AAAI author kit (`aaai<year>.sty`).',
      'Follow the kit\'s documentclass/options; two-column format.',
      'Anonymous submission while under review.',
      'Page limit per the current call (recent years: 7 pages + 2 reference pages).',
    ].join('\n'),
  },
  {
    id: 'ieee-conf',
    name: 'IEEE Conference (IEEEtran)',
    series: 'general',
    url: 'https://www.ctan.org/pkg/ieeetran',
    checklist: [
      '`\\documentclass[conference]{IEEEtran}` — IEEEtran ships with TeX distributions and CTAN, so no local `.cls` is needed.',
      'Two-column, 10pt; use `\\IEEEauthorblockN`/`\\IEEEauthorblockA` for the author block.',
      'Bibliography style `IEEEtran` (`\\bibliographystyle{IEEEtran}`).',
      'Respect the specific conference\'s page limit (commonly 6–10 pages).',
    ].join('\n'),
  },
  {
    id: 'ieee-journal',
    name: 'IEEE Transactions/Journal (IEEEtran)',
    series: 'general',
    url: 'https://www.ctan.org/pkg/ieeetran',
    checklist: [
      '`\\documentclass[journal]{IEEEtran}` for Transactions submissions.',
      'Single-column review vs two-column final per the journal\'s instructions; IEEE biography blocks for camera-ready.',
      'Bibliography style `IEEEtran`.',
    ].join('\n'),
  },
  {
    id: 'acm',
    name: 'ACM (acmart, e.g. SIGGRAPH/CHI/KDD)',
    series: 'general',
    url: 'https://www.ctan.org/pkg/acmart',
    checklist: [
      '`\\documentclass[sigconf,review,anonymous]{acmart}` under review (drop `review,anonymous` for camera-ready); choose the template variant matching the venue (`sigconf`, `sigplan`, `manuscript`, ...).',
      'acmart ships with TeX distributions and CTAN, so no local `.cls` is needed.',
      'Fill `\\acmConference`, `\\acmYear`, CCS concepts, and keywords as the template requires.',
      'Bibliography style `ACM-Reference-Format`.',
    ].join('\n'),
  },
])

/** Look up one built-in venue template by id. */
export function venueTemplateOf(id: string): VenueTemplate | undefined {
  return VENUE_TEMPLATES.find(template => template.id === id)
}

/**
 * Render the `template/TEMPLATE.md` brief the agent reads before re-layout.
 * @param heading - display name of the venue (built-in or custom).
 * @param url - official kit page, or null for a custom upload.
 * @param checklist - formatting bullet list (one item per line).
 * @param localFiles - files already present in `template/` (custom kits).
 * @returns the markdown brief.
 */
export function templateBriefOf(heading: string, url: string | null, checklist: string, localFiles: readonly string[]): string {
  const lines = [
    `# Target Venue: ${heading}`,
    '',
    ...(url === null ? [] : [`Official kit / instructions: ${url}`, '']),
    '## Formatting checklist',
    ...checklist.split('\n').map(item => `- ${item}`),
    ...(localFiles.length === 0 ? [] : [
      '',
      '## Local template files (already in this directory)',
      ...localFiles.map(file => `- \`template/${file}\``),
    ]),
    '',
    '## Task for the agent',
    'Re-layout `main.tex` (and companions) to match this venue: swap the documentclass/style, restructure the front matter (title/authors/abstract), set the bibliography style, and flag anything that needs the official kit downloaded. Do NOT change scientific content.',
    '',
  ]
  return lines.join('\n')
}
