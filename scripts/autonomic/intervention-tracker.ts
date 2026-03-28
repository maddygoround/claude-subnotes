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

const noopLog: LogFn = () => {};

// ============================================
// Transcript Entry (minimal type for outcome resolution)
// ============================================

interface TranscriptEntry {
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

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
 * Determine the outcome of a whisper intervention.
 *
 * A whisper is "followed" if Claude's next action aligns with the advice.
 * It's "ignored" if Claude does exactly what was warned about.
 * It's "acknowledged" if Claude explicitly references the warning.
 */
function resolveWhisperOutcome(
  intervention: InterventionRecord,
  subsequentEntries: TranscriptEntry[],
): InterventionOutcome | null {
  if (subsequentEntries.length === 0) return null;

  // Check if Claude acknowledged the warning
  for (const entry of subsequentEntries) {
    if (entry.role === 'assistant') {
      const content = entry.content.toLowerCase();
      // Check for acknowledgement patterns
      if (
        content.includes('noted') ||
        content.includes('good point') ||
        content.includes('taking into account') ||
        content.includes('sentinel') ||
        content.includes('pattern detected') ||
        content.includes('warning')
      ) {
        return 'acknowledged';
      }
    }
  }

  // Check if Claude's next tool call touches the same file/tool
  for (const entry of subsequentEntries) {
    if (entry.role === 'system' && entry.content.includes('<tool_event>')) {
      // Parse the tool event
      const toolNameMatch = entry.content.match(/<name>(.*?)<\/name>/);
      const toolInputMatch = entry.content.match(/<input>([\s\S]*?)<\/input>/);

      if (toolNameMatch) {
        const nextTool = toolNameMatch[1];
        const nextInput = toolInputMatch ? toolInputMatch[1] : '';

        // If the same tool is used on the same file, check if behavior changed
        if (
          nextTool === intervention.tool_name &&
          typeof intervention.tool_input === 'object' &&
          intervention.tool_input !== null
        ) {
          // Same tool, same target — probably ignored
          return 'ignored';
        }

        // Different tool or different target — probably followed
        return 'followed';
      }
    }
  }

  // If no subsequent tool calls, assume acknowledged (Claude stopped)
  return 'acknowledged';
}

/**
 * Determine the outcome of a deny intervention.
 *
 * "redirected" if Claude tries a different approach.
 * "retried" if Claude tries the exact same thing.
 * "user_override" if the user explicitly tells Claude to proceed.
 */
function resolveDenyOutcome(
  intervention: InterventionRecord,
  subsequentEntries: TranscriptEntry[],
): InterventionOutcome | null {
  if (subsequentEntries.length === 0) return null;

  // Check for user override
  for (const entry of subsequentEntries) {
    if (entry.role === 'user') {
      const content = entry.content.toLowerCase();
      if (
        content.includes('go ahead') ||
        content.includes('proceed') ||
        content.includes('do it anyway') ||
        content.includes('override') ||
        content.includes('ignore the warning') ||
        content.includes('just do it')
      ) {
        return 'user_override';
      }
    }
  }

  // Check if Claude retried the same action
  for (const entry of subsequentEntries) {
    if (entry.role === 'system' && entry.content.includes('<tool_event>')) {
      const toolNameMatch = entry.content.match(/<name>(.*?)<\/name>/);
      if (toolNameMatch && toolNameMatch[1] === intervention.tool_name) {
        // Same tool used again — check if it's the same input
        const inputStr = JSON.stringify(intervention.tool_input);
        if (entry.content.includes(inputStr.slice(1, 50))) {
          return 'retried';
        }
      }
    }
  }

  return 'redirected';
}

/**
 * Determine the outcome of a correction intervention.
 *
 * "correction_helped" if the corrected call succeeded.
 * "correction_failed" if it failed.
 * "correction_rejected" if the user noticed and undid it.
 */
function resolveCorrectionOutcome(
  intervention: InterventionRecord,
  subsequentEntries: TranscriptEntry[],
): InterventionOutcome | null {
  if (subsequentEntries.length === 0) return null;

  // Check if user rejected the correction
  for (const entry of subsequentEntries) {
    if (entry.role === 'user') {
      const content = entry.content.toLowerCase();
      if (
        content.includes('undo') ||
        content.includes('revert') ||
        content.includes('no, use') ||
        content.includes('wrong path') ||
        content.includes("that's not right")
      ) {
        return 'correction_rejected';
      }
    }
  }

  // Check if the next tool call (with corrected input) succeeded
  for (const entry of subsequentEntries) {
    if (entry.role === 'system' && entry.content.includes('<tool_event>')) {
      const responseMatch = entry.content.match(/<response>([\s\S]*?)<\/response>/);
      if (responseMatch) {
        const response = responseMatch[1].toLowerCase();
        const hasError =
          response.includes('error') ||
          response.includes('failed') ||
          response.includes('enoent');
        return hasError ? 'correction_failed' : 'correction_helped';
      }
    }
  }

  return null; // Can't determine yet
}

/**
 * Determine the outcome of an ask intervention.
 *
 * "user_approved" if the user approved.
 * "user_denied" if the user denied.
 */
function resolveAskOutcome(
  intervention: InterventionRecord,
  subsequentEntries: TranscriptEntry[],
): InterventionOutcome | null {
  if (subsequentEntries.length === 0) return null;

  // For ask, we need to see if the tool call proceeded
  for (const entry of subsequentEntries) {
    if (entry.role === 'system' && entry.content.includes('<tool_event>')) {
      const toolNameMatch = entry.content.match(/<name>(.*?)<\/name>/);
      if (toolNameMatch && toolNameMatch[1] === intervention.tool_name) {
        return 'user_approved';
      }
    }

    // If user says no
    if (entry.role === 'user') {
      const content = entry.content.toLowerCase();
      if (
        content.includes('no') ||
        content.includes("don't") ||
        content.includes('stop') ||
        content.includes('cancel')
      ) {
        return 'user_denied';
      }
    }
  }

  return null; // Can't determine yet
}

import { ReflectConfig } from '../conversation_utils.js';

// ================= ===========================
// Main Outcome Resolution
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

    // Resolve based on intervention type
    let outcome: InterventionOutcome | null = null;

    switch (intervention.type) {
      case 'whisper':
      case 'sentinel':
        outcome = resolveWhisperOutcome(intervention, subsequentEntries);
        break;
      case 'deny':
        outcome = resolveDenyOutcome(intervention, subsequentEntries);
        break;
      case 'correct':
        outcome = resolveCorrectionOutcome(intervention, subsequentEntries);
        break;
      case 'ask':
        outcome = resolveAskOutcome(intervention, subsequentEntries);
        break;
    }

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
