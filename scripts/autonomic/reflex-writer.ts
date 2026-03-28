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
  confidence: number,
  thresholds: MetaConfig['thresholds'],
): ReflexAction['type'] | null {
  if (confidence >= thresholds.deny) return 'deny';
  if (confidence >= thresholds.correct) return 'correct';
  if (confidence >= thresholds.ask) return 'ask';
  if (confidence >= thresholds.whisper) return 'whisper';
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

    case 'whisper':
    default:
      return {
        type: 'whisper',
        content: base.content || `Pattern detected: "${pattern.name}"`,
      };
  }
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
      pattern.confidence,
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

      // Only update if the action type changed or was inactive
      if (existingRule.action.type !== actionType || !existingRule.active) {
        updatedRules[existingRuleIdx] = {
          ...existingRule,
          active: true,
          action: newAction,
          confidence: pattern.confidence,
          trigger: buildReflexTrigger(pattern),
        };

        if (existingRule.action.type !== actionType) {
          log(
            `Promoted rule "${existingRule.id}" from ${existingRule.action.type} → ${actionType} ` +
              `(confidence: ${pattern.confidence.toFixed(2)})`,
          );
        } else {
          log(
            `Reactivated rule "${existingRule.id}" as ${actionType} ` +
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
        `Created new rule "${newRule.id}" as ${actionType} ` +
          `for pattern "${pattern.name}" (confidence: ${pattern.confidence.toFixed(2)})`,
      );
    }
  }

  return updatedRules;
}
