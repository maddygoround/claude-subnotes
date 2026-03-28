/**
 * Autonomic Subconscious — Barrel Export
 *
 * Re-exports all autonomic modules for clean imports.
 */

// Types
export type {
  PatternRecord,
  PatternType,
  PatternTrigger,
  SuggestedAction,
  SuggestedActionType,
  ReflexRule,
  ReflexAction,
  ReflexActionType,
  ReflexTrigger,
  InterventionRecord,
  InterventionType,
  InterventionOutcome,
  MetaConfig,
  ConfidenceThresholds,
  CommunicationStyleData,
  PruneConfig,
  SentinelState,
  SentinelWarning,
  SentinelWarningType,
  ObservationEntry,
  HookAction,
  HookActionType,
  LogFn,
} from './types.js';

export {
  DEFAULT_META_CONFIG,
  createDefaultSentinelState,
  generateId,
} from './types.js';

// Store
export {
  getAutonomicDir,
  ensureAutonomicDir,
  loadPatterns,
  savePatterns,
  loadReflexRules,
  loadAllReflexRules,
  saveReflexRules,
  loadInterventions,
  saveInterventions,
  appendIntervention,
  loadMetaConfig,
  saveMetaConfig,
  appendObservation,
  loadRecentObservations,
  truncateObservations,
} from './store.js';

// Crystallizer
export { crystallize } from './crystallizer.js';

// Reflex Writer
export { promotePatterns } from './reflex-writer.js';

// Reflex Matcher
export { matchReflexRules, recordRuleFired } from './reflex-matcher.js';

// Intervention Tracker
export {
  createInterventionRecord,
  resolveOutcomes,
  getRecentlyResolved,
  pruneInterventions,
} from './intervention-tracker.js';

// Self-Tuner
export { tune } from './self-tuner.js';
export type { TuneResult } from './self-tuner.js';
