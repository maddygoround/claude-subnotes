/**
 * Intervention Tracker (System 3)
 *
 * Records every subconscious intervention and tracks outcomes
 * by analyzing what happens after the intervention.
 *
 * This is the critical feedback loop — without it, the subconscious
 * is an open loop that acts but never learns from its actions.
 */

import type {
  InterventionRecord,
  InterventionType,
  InterventionOutcome,
  LogFn,
} from './types.js';
import { generateId } from './types.js';
import { ReflectConfig } from '../conversation_utils.js';
import {
  type TranscriptEntry,
  resolveInterventionOutcome,
} from './outcome-resolvers.js';

const noopLog: LogFn = () => {};

// ============================================
// Intervention Recording
// ============================================

/**
 * Create an intervention record for tracking.
 * Called from the PreToolUse hook when the subconscious intervenes.
 */
export function createInterventionRecord(
  type: InterventionType,
  toolName: string,
  toolInput: unknown,
  interventionContent: string,
  reflexId: string | null = null,
): InterventionRecord {
  return {
    id: generateId('int'),
    reflex_id: reflexId,
    type,
    timestamp: new Date().toISOString(),
    tool_name: toolName,
    tool_input: toolInput,
    intervention_content: interventionContent,
    outcome: null,
    outcome_timestamp: null,
  };
}

// ============================================
// Outcome Resolution
// ============================================

/**
 * Resolve outcomes for pending interventions.
 * Called from the background worker as Phase 4.
 *
 * @param interventions All intervention records (may include already resolved ones)
 * @param recentTranscript Recent transcript entries for outcome analysis
 * @returns Updated interventions with outcomes filled in where possible
 */
export function resolveOutcomes(
  interventions: InterventionRecord[],
  recentTranscript: TranscriptEntry[],
  config: ReflectConfig,
  log: LogFn = noopLog,
): InterventionRecord[] {
  const now = Date.now();
  const updated = interventions.map((intervention) => {
    // Skip already resolved
    if (intervention.outcome !== null) return intervention;

    // Check if too old to resolve
    const ageMs = now - new Date(intervention.timestamp).getTime();
    if (ageMs > config.tunerMaxUnresolvedAgeMs) {
      log(
        `Intervention "${intervention.id}" expired — ` +
          `no outcome determined after ${Math.round(ageMs / 60000)} minutes`,
      );
      return {
        ...intervention,
        outcome: 'ignored' as InterventionOutcome,
        outcome_timestamp: new Date().toISOString(),
      };
    }

    // Get transcript entries after this intervention
    const interventionTime = new Date(intervention.timestamp).getTime();
    const subsequentEntries = recentTranscript
      .filter((e) => new Date(e.timestamp).getTime() > interventionTime)
      .slice(0, config.tunerOutcomeLookahead);

    if (subsequentEntries.length === 0) return intervention; // Not enough data yet

    const outcome = resolveInterventionOutcome(intervention, subsequentEntries);

    if (outcome) {
      log(`Resolved intervention "${intervention.id}" → ${outcome}`);
      return {
        ...intervention,
        outcome,
        outcome_timestamp: new Date().toISOString(),
      };
    }

    return intervention;
  });

  return updated;
}

/**
 * Get only recently resolved interventions (for self-tuner input).
 */
export function getRecentlyResolved(
  interventions: InterventionRecord[],
  sinceDatetime: string,
): InterventionRecord[] {
  const sinceTime = new Date(sinceDatetime).getTime();
  return interventions.filter(
    (i) =>
      i.outcome !== null &&
      i.outcome_timestamp !== null &&
      new Date(i.outcome_timestamp).getTime() > sinceTime,
  );
}

/**
 * Prune old intervention records to prevent unbounded growth.
 * Keeps the last N records and any unresolved ones.
 */
export function pruneInterventions(
  interventions: InterventionRecord[],
  keepCount: number = 500,
): InterventionRecord[] {
  // Always keep unresolved interventions
  const unresolved = interventions.filter((i) => i.outcome === null);
  const resolved = interventions.filter((i) => i.outcome !== null);

  // Keep the most recent resolved ones
  const keptResolved = resolved.slice(-keepCount);

  return [...keptResolved, ...unresolved];
}
