/**
 * The experimental surface (#244), on its own subpath: `dsh-mimir/experimental`.
 *
 * These helpers — the fold primitives, the cognitive-map derivations, the
 * evidence graph, the moment index, the rendered reports — are real and
 * tested, but they are also the layer that moves fastest: shapes here have
 * changed between minor releases and will change again. Re-exporting them from
 * the package root quietly promised otherwise, so every import from
 * `dsh-mimir` was implicitly part of the compatibility contract.
 *
 * The root now carries what a third party is meant to build on: the plugin
 * entry, `Config`, and the types the client and the Remote surface speak.
 * Everything left here is available and documented, and explicitly outside the
 * compatibility promise — the import path says so.
 *
 * Rules that keep the split from rotting:
 *  - a module moves here while its shape is still being discovered;
 *  - a module moves back to the root only when something outside this package
 *    depends on it;
 *  - nothing in this file is re-exported from `index.ts`.
 *
 * @module dsh-mimir/src/experimental
 * @experimental
 */

/**
 * The L0 primitives. These are the锅底 every fold is written against, and they
 * are exported so a consumer — or a twelfth fold — never has to re-declare
 * the canonical ordering, the window slice, the session cut, or the day and
 * minute units. A re-declared primitive is how two folds come to disagree.
 */
export { MS_PER_DAY, MS_PER_MINUTE, orderedEvents, sessionize, sliceEvents, tsToMs } from './time.ts'
/**
 * The two vocabulary names that are not already re-exported through
 * `./cognitive-map.ts` above. The constants themselves (`LINE_WEIGHTS`,
 * `TERMINAL_ACTIONS`, `CREATION_ACTIONS`, `CBE_SESSION_GAP_MINUTES`) and
 * `signedWeight` keep their original export path, so no existing import
 * breaks.
 */
export { isDecisionEvent, lineOf } from './vocabulary.ts'
export {
  appendEvent,
  buildProgressReport,
  emitEvent,
  listEvents,
  newEvent,
  truncatePayload,
  PANEL_ACTOR,
  REVIEWER_ACTOR,
  SERVICE_ACTOR,
  WIKI_AGENT_ACTOR,
  EVENT_PAYLOAD_MAX_CHARS,
  JOURNAL_TEXT_MAX_CHARS,
  LIST_EVENTS_DEFAULT_LIMIT,
  LIST_EVENTS_MAX_LIMIT,
} from './ledger.ts'
export type { LedgerEventInput } from './ledger.ts'
export {
  deriveLines,
  detectMoments,
  deriveTransitions,
  deriveOpenLoops,
  deriveQuestions,
  deriveBrief,
  deriveNarrative,
  lineInferenceCard,
  renderBriefMarkdown,
  signedWeight,
  claimsOf,
  LINE_WEIGHTS,
  TERMINAL_ACTIONS,
  CREATION_ACTIONS,
  JOURNAL_ACTION,
  QUESTION_SHOWED_ACTION,
  QUESTION_ANSWERED_ACTION,
  CBE_HALF_LIFE_DAYS,
  CBE_SESSION_GAP_MINUTES,
  CBE_DOMINANT_DRIFT,
  CBE_STALLED_DRIFT,
  CBE_EXPLORE_EVENTS,
  CBE_RETURN_SESSIONS,
  CBE_FOCUS_DISPERSION,
  CBE_LINE_EVIDENCE_CAP,
  CBE_QUESTION_CAP,
  CBE_DERIVATION_VERSION,
  CBE_TIER_SILENT_LINE_EVENTS,
  CBE_TIER_E1_LINE_EVENTS,
  CBE_TIER_E1_USER_EVENTS,
} from './cognitive-map.ts'
export type {
  CbeBrief,
  CbeBriefWindow,
  CbeBoundaryQuestion,
  CbeEvidenceTier,
  CbeLine,
  CbeLineState,
  CbeMoment,
  CbeNarrative,
  CbeOpenLoop,
  CbeOpenLoopKind,
  CbeQuestionKind,
  CbeTransition,
  CbeWikiSnapshot,
  InferenceCard,
} from './cognitive-map.ts'
export { PARAMETER_REGISTRY } from './registry.ts'
export type { CbeParameterEntry, CbeParameterTrack } from './registry.ts'
export {
  deriveWorktree,
  ideaParentEdges,
  MAINLINE_ACTION,
  IDEA_PARENT_ACTION,
  IDEA_CLOSE_REASON_MAX_CHARS,
} from './worktree.ts'
export type {
  CbeWorktree,
  CbeWorktreeLane,
  CbeWorktreeLaneStatus,
  CbeMainlineDeclaration,
} from './worktree.ts'
export {
  evidenceModelAt,
  evidenceProfileOf,
  effectiveValue,
  initialModel,
  terminalOutcome,
  isTerminalOutcome,
  updateOnTerminal,
  CBE_ENGINE_ALPHA,
  CBE_ENGINE_KAPPA,
  CBE_ENGINE_N_FLIP,
  CBE_ENGINE_FOLD_WINDOW_DAYS,
} from './cbe-engine.ts'
export type {
  CbeEvidenceModel,
  CbeActionValue,
  CbeEvidenceActionRow,
} from './cbe-engine.ts'
export {
  deriveForaging,
  deriveTerritories,
  deriveGutBaseline,
  CBE_GUT_BASELINE_MIN_DEPARTURES,
} from './foraging.ts'
export type {
  CbeForaging,
  CbeTerritory,
  CbeGutBaseline,
  CbeGutCard,
} from './foraging.ts'
export {
  deriveLibraryThemes,
  countThemes,
  tagThemesOf,
  themeTokens,
  CBE_THEME_MIN_PAPERS,
  CBE_THEME_KEYWORD_MIN_DOCS,
  CBE_THEME_TOP_N,
  CBE_THEME_FLAT_BAND,
} from './library-themes.ts'
export type {
  CbeLibraryThemes,
  CbeThemeCount,
  CbeThemeDirection,
  CbeThemeDriftRow,
  CbeThemeSource,
  CbeThemeWindow,
} from './library-themes.ts'
export {
  deriveHabits,
  deriveSessions,
  CBE_HABIT_MIN_SESSIONS,
  CBE_HABIT_MIN_EVENTS,
} from './habits.ts'
export type {
  CbeHabitProfile,
  CbeSession,
  CbeHourBucket,
  CbeWeekdayBucket,
} from './habits.ts'
export {
  eurekaDeclarations,
  eurekaFeatures,
  eurekaModelAt,
  eurekaProfileOf,
  eurekaContextAt,
  eurekaWindowBounds,
  EUREKA_ACTION,
  EUREKA_FEATURE_KEYS,
  CBE_EUREKA_WINDOW_DAYS,
  CBE_EUREKA_MIN_DECLARATIONS,
} from './eureka.ts'
export {
  eurekaCriticalStateData,
} from './eureka.ts'
export type {
  CbeEurekaDeclaration,
  CbeEurekaFeatureKey,
  CbeEurekaFeatureRow,
  CbeEurekaFeatures,
  CbeEurekaModel,
  CbeEurekaProfile,
  CbeCriticalStateSample,
  CbeEurekaContextView,
  EurekaWindowBounds,
} from './eureka.ts'
export {
  windowFeatures,
} from './window-features.ts'
export type {
  CbeWindowFeatures,
} from './window-features.ts'
export {
  deriveCapsules,
  formatCapsule,
} from './report-capsules.ts'
export type {
  CbeCapsulePerspective,
  CbeExperienceCapsule,
  CbeCapsuleInput,
  CapsuleLang,
} from './report-capsules.ts'
export {
  assembleDigest,
} from './report-tier.ts'
export type {
  CbeDigestReport,
  CbeDigestTier,
  CbeDigestStat,
  CbeDigestRetrieval,
  CbeDigestEurekaRow,
  CbeDigestPerspectiveBlock,
  DigestInput,
} from './report-tier.ts'
export {
  renderDigest,
} from './render-digest.ts'
export {
  actionSequence,
  conditionalEntropy,
  ewsOrder,
  ewsReading,
  surprisalSequence,
  unigramEntropy,
  CBE_EWS_MIN_EVENTS,
  CBE_EWS_MAX_ORDER,
} from './ledger-ews.ts'
export type { CbeEwsReading } from './ledger-ews.ts'
export {
  deriveCuratedMoments,
  momentPins,
  MOMENT_PIN_ACTION,
  CBE_MOMENT_BURST_MIN_EVENTS,
} from './moment-index.ts'
export type { CbeCuratedMoment, CbeMomentKind, CbeMomentPin } from './moment-index.ts'
export {
  deriveEvidenceGraph,
  renderEvidenceGraphMarkdown,
  EVIDENCE_EDGE_ADDED_ACTION,
  EVIDENCE_EDGE_RETRACTED_ACTION,
  EVIDENCE_EDGE_RELS,
  EVIDENCE_GRAPH_DERIVATION_VERSION,
  isEvidenceEdgeRel,
} from './evidence-graph.ts'
export type {
  EvidenceAliasKeys,
  EvidenceClaimHistory,
  EvidenceConflict,
  EvidenceEdgeRel,
  EvidenceGraph,
  EvidenceGraphEdge,
  EvidenceGraphNode,
  EvidenceGraphRel,
  EvidenceGraphStats,
  EvidenceGraphWindow,
  EvidenceTimelineEntry,
  EvidenceTimelineGroup,
  EvidenceWikiSnapshot,
} from './evidence-graph.ts'
export {
  nodeKeyOf,
  isValidNodeKey,
  nodeKindOf,
  normalizeUrl,
  normalizeDoi,
  titleFingerprint,
  isTitleFingerprint,
  dedupKeyOf,
  isDedupKey,
  queryKeyOf,
  evidenceScopeOf,
  NODE_KEY_MAX_CHARS,
  LABEL_MAX_CHARS,
  ALIAS_MAX_CHARS,
  NOTE_MAX_CHARS,
} from './evidence-identity.ts'
export {
  deriveMomentCandidates,
  kindOfBurst,
  CBE_MOMENT_RETURN_GAP_DAYS,
  CBE_MOMENT_CONVERGENCE_LINES,
  CBE_MOMENT_LONG_SITTING_FACTOR,
  CBE_MOMENT_LONG_SITTING_MIN_SESSIONS,
  CBE_MOMENT_CLOSNESS_ENABLED,
} from './moment-candidates.ts'
export type {
  CbeMomentSource,
  CbeMomentStats,
  CbeMomentCandidate,
  CbeClosenessVotes,
} from './moment-candidates.ts'
export { renderJournalDraft } from './journal-draft.ts'
export type { JournalDraftInput, JournalDraftKind, JournalDraftLang } from './journal-draft.ts'
export { parseLatexErrors } from './latex-log.ts'
export type { LatexIssue } from './latex-log.ts'
export { parseTexOutline } from './outline.ts'
export { readPaperSource, resolvePaperDir, savePaperSourceFile } from './paper-source.ts'
export type { PaperSourceSnapshot, SavePaperOutcome } from './paper-source.ts'
export { DEFAULT_PAPER_DIR } from './paper-source.ts'
export { isArtifactName, isFigureFile, listPaperFigures, readWorkspaceArtifact, ARTIFACT_NAMES } from './artifacts.ts'
export type { ArtifactName, FigureFile } from './artifacts.ts'
export { convertSvgFigure, svgConverterNames, svgProductName, whichOnPath, SVG_CONVERTERS } from './svg-convert.ts'
export type { SvgConversion, SvgConversionDeps, SvgConverterKind, SvgConverterSpec, SvgRunner } from './svg-convert.ts'
