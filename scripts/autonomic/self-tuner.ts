/**
 * Self-Tuner (System 4)
 *
 * Adjusts reflex confidence scores, intervention thresholds,
 * and communication style based on intervention outcomes.
 *
 * This is what makes the subconscious truly alive — it improves
 * from its own experience. Without it, the system is an open loop.
 *
 * Key behaviors:
 * - Confidence adjustment based on outcome deltas
 * - Threshold meta-tuning (learns how aggressive to be)
 * - Communication style evolution
 * - Rule pruning (forgets what stopped being relevant)
 */

import type {
  InterventionRecord,
  InterventionOutcome,
  PatternRecord,
  ReflexRule,
  MetaConfig,
  LogFn,
} from './types.js';
import { ReflectConfig } from '../conversation_utils.js';

const noopLog: LogFn = () => {};

function isAdvisoryIntervention(intervention: InterventionRecord): boolean {
  return (
    intervention.type === 'whisper' ||
    intervention.type === 'insight' ||
    intervention.type === 'sentinel'
  );
}

// ============================================
// Confidence Adjustment Deltas
// ============================================

/**
 * Outcome → confidence delta mapping.
 * Positive = intervention was helpful, negative = harmful.
 */
const OUTCOME_DELTAS: Record<InterventionOutcome, number> = {
  // Whisper outcomes
  followed: 0.05,
  ignored: -0.03,
  acknowledged: 0.02,
  // Block outcomes
  redirected: 0.08,
  retried: -0.10,
  user_override: -0.15,
  // Correction outcomes
  correction_helped: 0.06,
  correction_failed: -0.12,
  correction_rejected: -0.15,
  // Ask outcomes
  user_approved: -0.02, // Ask was unnecessary
  user_denied: 0.05, // Ask was right to ask
};

// ============================================
// Confidence Adjustment
// ============================================

/**
 * Apply outcome-based confidence adjustments to patterns and rules.
 */
function adjustConfidence(
  resolvedInterventions: InterventionRecord[],
  patterns: PatternRecord[],
  rules: ReflexRule[],
  log: LogFn,
): { patterns: PatternRecord[]; rules: ReflexRule[] } {
  const updatedPatterns = [...patterns];
  const updatedRules = [...rules];

  // Build lookup maps
  const ruleById = new Map(updatedRules.map((r, i) => [r.id, i]));
  const patternByRuleId = new Map<string, number>();
  for (const rule of updatedRules) {
    const patIdx = updatedPatterns.findIndex(
      (p) => p.id === rule.source_pattern,
    );
    if (patIdx >= 0) {
      patternByRuleId.set(rule.id, patIdx);
    }
  }

  for (const intervention of resolvedInterventions) {
    if (intervention.outcome === null) continue;

    const delta = OUTCOME_DELTAS[intervention.outcome] || 0;
    if (delta === 0) continue;

    // Update rule confidence
    if (intervention.reflex_id) {
      const ruleIdx = ruleById.get(intervention.reflex_id);
      if (ruleIdx !== undefined) {
        const oldConf = updatedRules[ruleIdx].confidence;
        const newConf = Math.max(0, Math.min(1, oldConf + delta));
        updatedRules[ruleIdx] = {
          ...updatedRules[ruleIdx],
          confidence: newConf,
          times_effective:
            delta > 0
              ? updatedRules[ruleIdx].times_effective + 1
              : updatedRules[ruleIdx].times_effective,
        };

        log(
          `Rule "${intervention.reflex_id}" confidence: ` +
            `${oldConf.toFixed(2)} → ${newConf.toFixed(2)} (${intervention.outcome}: ${delta > 0 ? '+' : ''}${delta})`,
        );

        // Also update the source pattern's confidence
        const patIdx = patternByRuleId.get(intervention.reflex_id);
        if (patIdx !== undefined) {
          const oldPatConf = updatedPatterns[patIdx].confidence;
          const newPatConf = Math.max(0, Math.min(1, oldPatConf + delta));
          updatedPatterns[patIdx] = {
            ...updatedPatterns[patIdx],
            confidence: newPatConf,
          };
        }
      }
    }
  }

  return { patterns: updatedPatterns, rules: updatedRules };
}

// ============================================
// Threshold Meta-Tuning
// ============================================

/**
 * Adjust thresholds based on aggregate intervention effectiveness.
 */
function adjustThresholds(
  resolvedInterventions: InterventionRecord[],
  config: MetaConfig,
  reflectConfig: ReflectConfig,
  log: LogFn,
): MetaConfig {
  const updated = {
    ...config,
    thresholds: { ...config.thresholds },
  };

  // Count outcomes by intervention type
  const advisoryOutcomes = resolvedInterventions.filter(isAdvisoryIntervention);
  const denyOutcomes = resolvedInterventions.filter((i) => i.type === 'deny');
  const allOutcomes = resolvedInterventions;

  // If >40% of soft advisories are being ignored → raise whisper threshold
  if (advisoryOutcomes.length >= 5) {
    const ignoredCount = advisoryOutcomes.filter(
      (i) => i.outcome === 'ignored',
    ).length;
    const ignoreRate = ignoredCount / advisoryOutcomes.length;

    if (ignoreRate > reflectConfig.tunerIgnoreRateThreshold) {
      const oldThreshold = updated.thresholds.whisper;
      updated.thresholds.whisper = Math.min(0.6, oldThreshold + 0.05);
      log(
        `Advisory ignore rate ${(ignoreRate * 100).toFixed(0)}% > ${(reflectConfig.tunerIgnoreRateThreshold * 100).toFixed(0)}% — ` +
          `raised whisper threshold: ${oldThreshold.toFixed(2)} → ${updated.thresholds.whisper.toFixed(2)}`,
      );
    }
  }

  // If >20% of blocks result in retries → raise deny threshold
  if (denyOutcomes.length >= 3) {
    const retriedCount = denyOutcomes.filter(
      (i) => i.outcome === 'retried',
    ).length;
    const retryRate = retriedCount / denyOutcomes.length;

    if (retryRate > reflectConfig.tunerRetryRateThreshold) {
      const oldThreshold = updated.thresholds.deny;
      updated.thresholds.deny = Math.min(0.95, oldThreshold + 0.03);
      log(
        `Block retry rate ${(retryRate * 100).toFixed(0)}% > ${(reflectConfig.tunerRetryRateThreshold * 100).toFixed(0)}% — ` +
          `raised deny threshold: ${oldThreshold.toFixed(2)} → ${updated.thresholds.deny.toFixed(2)}`,
      );
    }
  }

  // If >10% of all interventions result in user overrides → scale back
  if (allOutcomes.length >= 10) {
    const overrideCount = allOutcomes.filter(
      (i) => i.outcome === 'user_override' || i.outcome === 'correction_rejected',
    ).length;
    const overrideRate = overrideCount / allOutcomes.length;

    if (overrideRate > reflectConfig.tunerOverrideRateThreshold) {
      const scale = 0.02;
      updated.thresholds.whisper = Math.min(0.6, updated.thresholds.whisper + scale);
      updated.thresholds.ask = Math.min(0.8, updated.thresholds.ask + scale);
      updated.thresholds.correct = Math.min(0.85, updated.thresholds.correct + scale);
      updated.thresholds.deny = Math.min(0.95, updated.thresholds.deny + scale);
      log(
        `User override rate ${(overrideRate * 100).toFixed(0)}% > ${(reflectConfig.tunerOverrideRateThreshold * 100).toFixed(0)}% — ` +
          `scaled back all thresholds by +${scale}`,
      );
    }
  }

  return updated;
}

// ============================================
// Communication Style Evolution
// ============================================

/**
 * Track which advisory phrasings lead to "followed" vs "ignored" outcomes.
 */
function evolveCommunicationStyle(
  resolvedInterventions: InterventionRecord[],
  config: MetaConfig,
  log: LogFn,
): MetaConfig {
  const updated = {
    ...config,
    communication_style: {
      ...config.communication_style,
      effectiveness_data: { ...config.communication_style.effectiveness_data },
    },
  };

  for (const intervention of resolvedInterventions) {
    if (!isAdvisoryIntervention(intervention)) continue;
    if (!intervention.outcome) continue;

    // Classify the phrasing style
    const content = intervention.intervention_content.toLowerCase();
    let style = 'unknown';

    if (content.includes('?') || content.includes('consider')) {
      style = 'question';
    } else if (content.includes('do not') || content.includes("don't") || content.includes('stop')) {
      style = 'directive';
    } else if (
      content.includes('last time') ||
      content.includes('previously') ||
      content.includes('pattern') ||
      content.includes('first showed up') ||
      content.includes('most recently') ||
      content.includes('history')
    ) {
      style = 'contextual';
    } else if (content.length < 100) {
      style = 'short';
    } else {
      style = 'long';
    }

    // Track effectiveness
    if (!updated.communication_style.effectiveness_data[style]) {
      updated.communication_style.effectiveness_data[style] = {
        followed: 0,
        ignored: 0,
      };
    }

    const data = updated.communication_style.effectiveness_data[style];
    if (intervention.outcome === 'followed' || intervention.outcome === 'acknowledged') {
      data.followed++;
    } else if (intervention.outcome === 'ignored') {
      data.ignored++;
    }
  }

  // Determine preferred style from effectiveness data
  let bestStyle = 'contextual';
  let bestRatio = 0;

  for (const [style, data] of Object.entries(
    updated.communication_style.effectiveness_data,
  )) {
    const total = data.followed + data.ignored;
    if (total < 3) continue; // Not enough data

    const ratio = data.followed / total;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestStyle = style;
    }
  }

  if (bestStyle !== updated.communication_style.preferred_format) {
    log(
      `Communication style evolved: ${updated.communication_style.preferred_format} → ` +
        `${bestStyle} (effectiveness: ${(bestRatio * 100).toFixed(0)}%)`,
    );
    updated.communication_style.preferred_format = bestStyle as
      | 'question'
      | 'directive'
      | 'contextual';
  }

  // Determine preferred length
  const shortData =
    updated.communication_style.effectiveness_data['short'] || {
      followed: 0,
      ignored: 0,
    };
  const longData =
    updated.communication_style.effectiveness_data['long'] || {
      followed: 0,
      ignored: 0,
    };
  const shortTotal = shortData.followed + shortData.ignored;
  const longTotal = longData.followed + longData.ignored;

  if (shortTotal >= 3 && longTotal >= 3) {
    const shortRatio = shortData.followed / shortTotal;
    const longRatio = longData.followed / longTotal;
    updated.communication_style.preferred_length =
      shortRatio > longRatio ? 'short' : 'medium';
  }

  return updated;
}

// ============================================
// Rule Pruning
// ============================================

/**
 * Prune dead rules and decay stale patterns.
 *
 * - confidence < min_confidence → delete rule
 * - No fire in stale_days → decay confidence
 * - Pattern evidence stale for 14+ days → reduce confidence
 */
function pruneRulesAndPatterns(
  patterns: PatternRecord[],
  rules: ReflexRule[],
  config: MetaConfig,
  log: LogFn,
): { patterns: PatternRecord[]; rules: ReflexRule[] } {
  const now = Date.now();
  const staleMs = config.prune_config.stale_days * 24 * 60 * 60 * 1000;
  const evidenceStaleMs = 14 * 24 * 60 * 60 * 1000; // 14 days

  // Prune and decay rules
  const updatedRules: ReflexRule[] = [];
  const prunedRuleIds = new Set<string>();

  for (const rule of rules) {
    // Delete if confidence too low
    if (rule.confidence < config.prune_config.min_confidence) {
      prunedRuleIds.add(rule.id);
      log(
        `Pruned rule "${rule.id}" — confidence ${rule.confidence.toFixed(2)} < ` +
          `min ${config.prune_config.min_confidence}`,
      );
      continue;
    }

    // Decay if stale (hasn't fired in stale_days)
    if (rule.last_fired) {
      const lastFiredMs = new Date(rule.last_fired).getTime();
      const daysSinceLastFire = (now - lastFiredMs) / (24 * 60 * 60 * 1000);

      if (daysSinceLastFire > config.prune_config.stale_days) {
        const decayDays =
          daysSinceLastFire - config.prune_config.stale_days;
        const decay = decayDays * config.prune_config.decay_rate;
        const newConf = Math.max(0, rule.confidence - decay);

        if (newConf < config.prune_config.min_confidence) {
          prunedRuleIds.add(rule.id);
          log(
            `Pruned stale rule "${rule.id}" — decayed to ${newConf.toFixed(2)} ` +
              `after ${Math.round(daysSinceLastFire)} days without firing`,
          );
          continue;
        }

        updatedRules.push({
          ...rule,
          confidence: newConf,
        });
        continue;
      }
    } else if (rule.created_at) {
      // Never fired — check if it's been too long since creation
      const createdMs = new Date(rule.created_at).getTime();
      const daysSinceCreation = (now - createdMs) / (24 * 60 * 60 * 1000);

      if (daysSinceCreation > config.prune_config.stale_days) {
        const decay =
          (daysSinceCreation - config.prune_config.stale_days) *
          config.prune_config.decay_rate;
        const newConf = Math.max(0, rule.confidence - decay);

        if (newConf < config.prune_config.min_confidence) {
          prunedRuleIds.add(rule.id);
          log(
            `Pruned unused rule "${rule.id}" — never fired in ` +
              `${Math.round(daysSinceCreation)} days`,
          );
          continue;
        }
      }
    }

    updatedRules.push(rule);
  }

  // Decay stale patterns
  const updatedPatterns: PatternRecord[] = [];

  for (const pattern of patterns) {
    const lastSeenMs = new Date(pattern.last_seen).getTime();
    const daysSinceEvidence = (now - lastSeenMs) / (24 * 60 * 60 * 1000);

    if (daysSinceEvidence > 14) {
      // Evidence is stale — reduce confidence
      const decay =
        ((daysSinceEvidence - 14) * config.prune_config.decay_rate) / 2;
      const newConf = Math.max(0, pattern.confidence - decay);

      if (newConf < config.prune_config.min_confidence) {
        log(
          `Pruned stale pattern "${pattern.name}" — no evidence in ` +
            `${Math.round(daysSinceEvidence)} days`,
        );
        continue;
      }

      updatedPatterns.push({
        ...pattern,
        confidence: newConf,
      });
    } else {
      updatedPatterns.push(pattern);
    }
  }

  if (prunedRuleIds.size > 0) {
    log(`Pruned ${prunedRuleIds.size} rules total`);
  }

  return { patterns: updatedPatterns, rules: updatedRules };
}

// ============================================
// Main Tuning
// ============================================

export interface TuneResult {
  patterns: PatternRecord[];
  rules: ReflexRule[];
  metaConfig: MetaConfig;
  changes: string[];
}

/**
 * Run the full self-tuning cycle.
 * Called from the background worker as Phase 5.
 *
 * @returns Updated patterns, rules, and meta-config
 */
export function tune(
  resolvedInterventions: InterventionRecord[],
  patterns: PatternRecord[],
  rules: ReflexRule[],
  metaConfig: MetaConfig,
  reflectConfig: ReflectConfig,
  log: LogFn = noopLog,
): TuneResult {
  const changes: string[] = [];

  if (resolvedInterventions.length === 0) {
    // Still do pruning even with no new interventions
    const pruned = pruneRulesAndPatterns(patterns, rules, metaConfig, log);
    return {
      patterns: pruned.patterns,
      rules: pruned.rules,
      metaConfig: { ...metaConfig, last_tuned: new Date().toISOString() },
      changes: [],
    };
  }

  log(
    `Self-tuning with ${resolvedInterventions.length} resolved interventions...`,
  );

  // 1. Adjust confidence scores
  const adjusted = adjustConfidence(resolvedInterventions, patterns, rules, log);
  if (adjusted.rules !== rules) {
    changes.push('Adjusted rule confidence scores');
  }

  // 2. Adjust thresholds
  const thresholdConfig = adjustThresholds(
    resolvedInterventions,
    metaConfig,
    reflectConfig,
    log,
  );
  if (
    thresholdConfig.thresholds.whisper !== metaConfig.thresholds.whisper ||
    thresholdConfig.thresholds.deny !== metaConfig.thresholds.deny
  ) {
    changes.push('Adjusted confidence thresholds');
  }

  // 3. Evolve communication style
  const styleConfig = evolveCommunicationStyle(
    resolvedInterventions,
    thresholdConfig,
    log,
  );
  if (
    styleConfig.communication_style.preferred_format !==
    metaConfig.communication_style.preferred_format
  ) {
    changes.push(
      `Communication style: ${metaConfig.communication_style.preferred_format} → ` +
        `${styleConfig.communication_style.preferred_format}`,
    );
  }

  // 4. Prune dead rules and stale patterns
  const pruned = pruneRulesAndPatterns(
    adjusted.patterns,
    adjusted.rules,
    styleConfig,
    log,
  );
  if (pruned.rules.length < adjusted.rules.length) {
    changes.push(
      `Pruned ${adjusted.rules.length - pruned.rules.length} rules`,
    );
  }
  if (pruned.patterns.length < adjusted.patterns.length) {
    changes.push(
      `Pruned ${adjusted.patterns.length - pruned.patterns.length} patterns`,
    );
  }

  const finalConfig = {
    ...styleConfig,
    last_tuned: new Date().toISOString(),
  };

  if (changes.length > 0) {
    log(`Self-tuning complete: ${changes.join(', ')}`);
  } else {
    log('Self-tuning complete: no changes needed');
  }

  return {
    patterns: pruned.patterns,
    rules: pruned.rules,
    metaConfig: finalConfig,
    changes,
  };
}
