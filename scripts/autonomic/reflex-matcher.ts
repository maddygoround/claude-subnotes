/**
 * Reflex Matcher (System 2)
 *
 * Fast, synchronous reflex rule matcher for PreToolUse.
 * No LLM calls, no async — pure pattern matching.
 * Must execute in < 5ms.
 */

import type {
  ReflexRule,
  MetaConfig,
  HookAction,
  LogFn,
} from './types.js';
import { simpleGlobMatch } from './crystallizer.js';

const noopLog: LogFn = () => {};

// ============================================
// Tool Input Parsing
// ============================================

/**
 * Extract file paths from tool input for pattern matching.
 */
function extractFilePaths(toolInput: unknown): string[] {
  if (!toolInput || typeof toolInput !== 'object') return [];

  const input = toolInput as Record<string, unknown>;
  const paths: string[] = [];

  const fileFields = [
    'file_path',
    'filePath',
    'path',
    'TargetFile',
    'AbsolutePath',
    'SearchPath',
  ];

  for (const field of fileFields) {
    if (typeof input[field] === 'string') {
      paths.push(input[field] as string);
    }
  }

  return paths;
}

// ============================================
// Rule Matching
// ============================================

/**
 * Check if a tool name matches a rule's tool_name pattern.
 * Supports pipe-separated patterns (e.g., "Edit|Write").
 * Wildcard "*" matches everything.
 */
function matchToolName(rulePattern: string, toolName: string): boolean {
  if (rulePattern === '*') return true;

  const patterns = rulePattern.split('|').map((p) => p.trim());
  return patterns.some((pattern) => {
    // Exact match
    if (pattern === toolName) return true;
    // Partial match (e.g., "Edit" matches "mcp_claude-code_Edit")
    if (toolName.includes(pattern)) return true;
    return false;
  });
}

/**
 * Check if any file path in the tool input matches a rule's file pattern.
 */
function matchFilePattern(
  rulePattern: string | undefined,
  toolInput: unknown,
): boolean {
  if (!rulePattern) return true; // No file pattern = match everything

  const filePaths = extractFilePaths(toolInput);
  if (filePaths.length === 0) return true; // No files to check = match

  return filePaths.some((fp) => simpleGlobMatch(rulePattern, fp));
}

/**
 * Match reflex rules against a tool call.
 * Returns the highest-confidence matching rule and its decided action.
 *
 * HOT PATH — called on every PreToolUse hook.
 */
export function matchReflexRules(
  toolName: string,
  toolInput: unknown,
  rules: ReflexRule[],
  metaConfig: MetaConfig,
  log: LogFn = noopLog,
): HookAction {
  if (rules.length === 0) {
    return { type: 'pass' };
  }

  let bestMatch: ReflexRule | null = null;
  let bestConfidence = 0;

  for (const rule of rules) {
    if (!rule.active) continue;

    // Check tool name match
    if (!matchToolName(rule.trigger.tool_name, toolName)) continue;

    // Check file pattern match
    if (!matchFilePattern(rule.trigger.file_pattern, toolInput)) continue;

    // This rule matches — check if it's the best match
    if (rule.confidence > bestConfidence) {
      bestMatch = rule;
      bestConfidence = rule.confidence;
    }
  }

  if (!bestMatch) {
    return { type: 'pass' };
  }

  log(
    `Matched rule "${bestMatch.id}" (${bestMatch.action.type}) ` +
      `with confidence ${bestMatch.confidence.toFixed(2)}`,
  );

  // Build hook action from the matched rule
  return buildHookAction(bestMatch, metaConfig);
}

/**
 * Convert a matched reflex rule into a hook action.
 */
function buildHookAction(rule: ReflexRule, metaConfig: MetaConfig): HookAction {
  switch (rule.action.type) {
    case 'deny':
      return {
        type: 'deny',
        message:
          rule.action.message ||
          `Blocked by learned pattern (confidence: ${rule.confidence.toFixed(2)})`,
        source_rule_id: rule.id,
      };

    case 'ask':
      return {
        type: 'ask',
        message:
          rule.action.message ||
          `Learned pattern suggests caution (confidence: ${rule.confidence.toFixed(2)}). Proceed?`,
        source_rule_id: rule.id,
      };

    case 'correct': {
      if (!rule.action.field || !rule.action.match || !rule.action.replacement) {
        // Correction not fully specified — fall back to whisper
        return {
          type: 'whisper',
          content:
            rule.action.content ||
            `Pattern detected (confidence: ${rule.confidence.toFixed(2)})`,
          source_rule_id: rule.id,
        };
      }

      return {
        type: 'correct',
        content:
          rule.action.content ||
          `Auto-corrected: ${rule.action.field} (confidence: ${rule.confidence.toFixed(2)})`,
        source_rule_id: rule.id,
      };
    }

    case 'whisper':
    default:
      return {
        type: 'whisper',
        content:
          rule.action.content ||
          `Pattern detected (confidence: ${rule.confidence.toFixed(2)})`,
        source_rule_id: rule.id,
      };
  }
}

/**
 * Increment the times_fired counter on a matched rule.
 * Returns the updated rule.
 */
export function recordRuleFired(rule: ReflexRule): ReflexRule {
  return {
    ...rule,
    times_fired: rule.times_fired + 1,
    last_fired: new Date().toISOString(),
  };
}
