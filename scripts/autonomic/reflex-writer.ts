/**
 * Reflex Writer (System 2)
 *
 * Promotes high-confidence patterns into active reflex rules.
 * Demotes or deactivates rules when confidence drops.
 *
 * Key invariant: Reflex rules are the ONLY source of PreToolUse gating.
 * No manually authored rules. Everything the subconscious enforces,
 * it learned from observation.
 */

import type {
  PatternRecord,
  ReflexRule,
  ReflexAction,
  ReflexTrigger,
  MetaConfig,
  LogFn,
} from './types.js';
import { generateId } from './types.js';

const noopLog: LogFn = () => {};

// ============================================
// Pattern → Rule Promotion
// ============================================

/**
 * Determine what reflex action type a pattern should become
 * based on its confidence and the current thresholds.
 */
function determineActionType(
  pattern: PatternRecord,
  thresholds: MetaConfig['thresholds'],
): ReflexAction['type'] | null {
  const { confidence, suggested_action: suggestedAction } = pattern;

  if (confidence >= thresholds.deny) return 'deny';
  if (
    suggestedAction.type === 'correct_input' &&
    confidence >= thresholds.correct &&
    suggestedAction.field &&
    suggestedAction.match &&
    suggestedAction.replacement
  ) {
    return 'correct';
  }
  if (confidence >= thresholds.ask) return 'ask';
  if (confidence >= thresholds.whisper) {
    return suggestedAction.type === 'insight' ? 'insight' : 'whisper';
  }
  return null; // Below all thresholds
}

/**
 * Convert a pattern's suggested action into a reflex action
 * with the appropriate type based on confidence.
 */
function buildReflexAction(
  pattern: PatternRecord,
  actionType: ReflexAction['type'],
): ReflexAction {
  const base = pattern.suggested_action;

  switch (actionType) {
    case 'deny':
      return {
        type: 'deny',
        message:
          base.content ||
          `Blocked: "${pattern.name}" — this pattern has caused issues ${pattern.evidence_count} times.`,
      };

    case 'ask':
      return {
        type: 'ask',
        message:
          `⚠️ "${pattern.name}" — ${base.content || 'This action matches a known issue pattern.'} Proceed?`,
      };

    case 'correct':
      if (base.type === 'correct_input' && base.field && base.match && base.replacement) {
        return {
          type: 'correct',
          field: base.field,
          match: base.match,
          replacement: base.replacement,
          content:
            base.content || `Auto-corrected based on pattern: "${pattern.name}"`,
        };
      }
      // Fall back to whisper if correction isn't fully specified
      return {
        type: 'whisper',
        content: base.content || `Pattern detected: "${pattern.name}"`,
      };

    case 'insight':
      return {
        type: 'insight',
        content: base.content || `Insight detected: "${pattern.name}"`,
      };

    case 'whisper':
    default:
      return {
        type: 'whisper',
        content: base.content || `Pattern detected: "${pattern.name}"`,
      };
  }
}

function areReflexActionsEqual(a: ReflexAction, b: ReflexAction): boolean {
  return (
    a.type === b.type &&
    a.message === b.message &&
    a.content === b.content &&
    a.field === b.field &&
    a.match === b.match &&
    a.replacement === b.replacement
  );
}

function areReflexTriggersEqual(a: ReflexTrigger, b: ReflexTrigger): boolean {
  return (
    a.tool_name === b.tool_name &&
    a.file_pattern === b.file_pattern &&
    a.context_condition === b.context_condition
  );
}

/**
 * Convert a pattern trigger into a reflex trigger.
 */
function buildReflexTrigger(pattern: PatternRecord): ReflexTrigger {
  return {
    tool_name: pattern.trigger.tool || '*',
    file_pattern: pattern.trigger.file_pattern,
    context_condition: pattern.trigger.context_pattern,
  };
}

// ============================================
// Main Promotion Logic
// ============================================

/**
 * Promote patterns into reflex rules based on confidence thresholds.
 * Demotes or deactivates rules whose source patterns lost confidence.
 *
 * @returns Updated rules array
 */
export function promotePatterns(
  patterns: PatternRecord[],
  existingRules: ReflexRule[],
  metaConfig: MetaConfig,
  log: LogFn = noopLog,
): ReflexRule[] {
  const updatedRules = [...existingRules];
  const rulesByPattern = new Map<string, number>();

  // Index existing rules by source pattern
  for (let i = 0; i < updatedRules.length; i++) {
    rulesByPattern.set(updatedRules[i].source_pattern, i);
  }

  for (const pattern of patterns) {
    const actionType = determineActionType(
      pattern,
      metaConfig.thresholds,
    );
    const existingRuleIdx = rulesByPattern.get(pattern.id);

    if (actionType === null) {
      // Pattern is below all thresholds
      if (existingRuleIdx !== undefined) {
        // Deactivate existing rule
        if (updatedRules[existingRuleIdx].active) {
          updatedRules[existingRuleIdx] = {
            ...updatedRules[existingRuleIdx],
            active: false,
          };
          log(
            `Deactivated rule "${updatedRules[existingRuleIdx].id}" — ` +
              `pattern "${pattern.name}" confidence dropped to ${pattern.confidence.toFixed(2)}`,
          );
        }
      }
      continue;
    }

    if (existingRuleIdx !== undefined) {
      // Update existing rule
      const existingRule = updatedRules[existingRuleIdx];
      const newAction = buildReflexAction(pattern, actionType);
      const newTrigger = buildReflexTrigger(pattern);
      const shouldRefreshRule =
        !existingRule.active ||
        !areReflexActionsEqual(existingRule.action, newAction) ||
        !areReflexTriggersEqual(existingRule.trigger, newTrigger);

      if (shouldRefreshRule) {
        updatedRules[existingRuleIdx] = {
          ...existingRule,
          active: true,
          action: newAction,
          confidence: pattern.confidence,
          trigger: newTrigger,
        };

        if (existingRule.action.type !== newAction.type) {
          log(
            `Promoted rule "${existingRule.id}" from ${existingRule.action.type} → ${newAction.type} ` +
              `(confidence: ${pattern.confidence.toFixed(2)})`,
          );
        } else if (!areReflexActionsEqual(existingRule.action, newAction)) {
          log(
            `Refreshed rule "${existingRule.id}" ${newAction.type} content ` +
              `(confidence: ${pattern.confidence.toFixed(2)})`,
          );
        } else if (!areReflexTriggersEqual(existingRule.trigger, newTrigger)) {
          log(
            `Updated rule "${existingRule.id}" trigger for pattern "${pattern.name}" ` +
              `(confidence: ${pattern.confidence.toFixed(2)})`,
          );
        } else {
          log(
            `Reactivated rule "${existingRule.id}" as ${newAction.type} ` +
              `(confidence: ${pattern.confidence.toFixed(2)})`,
          );
        }
      } else {
        // Just update confidence
        updatedRules[existingRuleIdx] = {
          ...existingRule,
          confidence: pattern.confidence,
        };
      }
    } else {
      // Create new rule
      const newRule: ReflexRule = {
        id: generateId('ref'),
        source_pattern: pattern.id,
        active: true,
        action: buildReflexAction(pattern, actionType),
        trigger: buildReflexTrigger(pattern),
        confidence: pattern.confidence,
        times_fired: 0,
        times_effective: 0,
        created_by: 'self',
        last_fired: null,
        created_at: new Date().toISOString(),
      };

      updatedRules.push(newRule);
      rulesByPattern.set(pattern.id, updatedRules.length - 1);
      log(
        `Created new rule "${newRule.id}" as ${newRule.action.type} ` +
          `for pattern "${pattern.name}" (confidence: ${pattern.confidence.toFixed(2)})`,
      );
    }
  }

  return updatedRules;
}
