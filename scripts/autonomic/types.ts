/**
 * Autonomic Subconscious — Shared Type Definitions
 *
 * Types for all five autonomic systems:
 * - Patterns (System 1: Crystallizer)
 * - Reflexes (System 2: Reflex Writer)
 * - Interventions (System 3: Intervention Tracker)
 * - Meta-config (System 4: Self-Tuner)
 * - Sentinel state (System 5: Real-Time Sentinel)
 */

// ============================================
// Pattern Records (System 1)
// ============================================

export type PatternType =
  | 'failure_loop'
  | 'user_correction'
  | 'thrashing'
  | 'recurring_gotcha'
  | 'preference_signal';

export interface PatternTrigger {
  /** Tool name or comma-separated list of tools */
  tool?: string;
  /** Glob pattern for files involved (e.g., "src/auth/**") */
  file_pattern?: string;
  /** Contextual condition (e.g., "after_test_failure") */
  context_pattern?: string;
}

export type SuggestedActionType =
  | 'whisper'
  | 'insight'
  | 'block'
  | 'correct_input'
  | 'inject_context';

export interface SuggestedAction {
  type: SuggestedActionType;
  /** Auto-generated message or context to inject */
  content: string;
  /** For correct_input: the field to correct */
  field?: string;
  /** For correct_input: regex match pattern */
  match?: string;
  /** For correct_input: replacement string */
  replacement?: string;
}

export interface PatternRecord {
  /** Unique identifier, format: "pat_xxxx" */
  id: string;
  /** Auto-generated descriptive name */
  name: string;
  /** Classification of the pattern */
  type: PatternType;
  /** Conditions that trigger this pattern */
  trigger: PatternTrigger;
  /** Number of observations supporting this pattern */
  evidence_count: number;
  /** Confidence score 0.0 - 1.0 */
  confidence: number;
  /** ISO timestamp of first observation */
  first_seen: string;
  /** ISO timestamp of most recent observation */
  last_seen: string;
  /** What the subconscious should do when this pattern triggers */
  suggested_action: SuggestedAction;
}

// ============================================
// Reflex Rules (System 2)
// ============================================

export type ReflexActionType =
  | 'deny'
  | 'ask'
  | 'whisper'
  | 'insight'
  | 'correct';

export interface ReflexAction {
  type: ReflexActionType;
  /** For deny/ask: the message to show */
  message?: string;
  /** For whisper/insight: the advisory content */
  content?: string;
  /** For correct: the field in tool_input to modify */
  field?: string;
  /** For correct: regex match pattern on the field value */
  match?: string;
  /** For correct: replacement string */
  replacement?: string;
}

export interface ReflexTrigger {
  /** Tool name(s) to match (pipe-separated, e.g., "Edit|Write") */
  tool_name: string;
  /** Glob pattern for files involved */
  file_pattern?: string;
  /** Optional contextual condition */
  context_condition?: string;
}

export interface ReflexRule {
  /** Unique identifier, format: "ref_xxxx" */
  id: string;
  /** Source pattern that spawned this rule */
  source_pattern: string;
  /** Whether this rule is currently active */
  active: boolean;
  /** What to do when the rule matches */
  action: ReflexAction;
  /** Conditions that trigger this rule */
  trigger: ReflexTrigger;
  /** Current confidence score 0.0 - 1.0 */
  confidence: number;
  /** How many times this rule has matched */
  times_fired: number;
  /** How many times the intervention was effective */
  times_effective: number;
  /** Always "self" — rules are never manually authored */
  created_by: 'self';
  /** ISO timestamp of last match, or null */
  last_fired: string | null;
  /** ISO timestamp of creation */
  created_at: string;
}

// ============================================
// Intervention Records (System 3)
// ============================================

export type InterventionType =
  | 'whisper'
  | 'insight'
  | 'ask'
  | 'deny'
  | 'correct'
  | 'sentinel';

export type InterventionOutcome =
  // Advisory outcomes
  | 'followed'
  | 'ignored'
  | 'acknowledged'
  // Block (deny) outcomes
  | 'redirected'
  | 'retried'
  | 'user_override'
  // Correction outcomes
  | 'correction_helped'
  | 'correction_failed'
  | 'correction_rejected'
  // Ask outcomes
  | 'user_approved'
  | 'user_denied';

export interface InterventionRecord {
  /** Unique identifier, format: "int_xxxx" */
  id: string;
  /** Source reflex rule ID, null for sentinel interventions */
  reflex_id: string | null;
  /** Type of intervention performed */
  type: InterventionType;
  /** ISO timestamp of the intervention */
  timestamp: string;
  /** Tool that was being called */
  tool_name: string;
  /** The tool's input at the time */
  tool_input: unknown;
  /** What the subconscious said or did */
  intervention_content: string;
  /** Result of the intervention — filled asynchronously */
  outcome: InterventionOutcome | null;
  /** When the outcome was determined */
  outcome_timestamp: string | null;
}

// ============================================
// Meta-Configuration (System 4)
// ============================================

export interface ConfidenceThresholds {
  /** Minimum confidence to emit a whisper/insight advisory (default 0.3) */
  whisper: number;
  /** Minimum confidence to ask for user confirmation (default 0.6) */
  ask: number;
  /** Minimum confidence to auto-correct tool input (default 0.7) */
  correct: number;
  /** Minimum confidence to deny a tool call (default 0.85) */
  deny: number;
}

export interface CommunicationStyleData {
  /** Preferred warning length based on effectiveness */
  preferred_length: 'short' | 'medium';
  /** Preferred format based on effectiveness */
  preferred_format: 'question' | 'directive' | 'contextual';
  /** Per-phrasing-style effectiveness tracking */
  effectiveness_data: Record<string, { followed: number; ignored: number }>;
}

export interface PruneConfig {
  /** Delete rules below this confidence (default 0.1) */
  min_confidence: number;
  /** Days without firing before decay starts (default 30) */
  stale_days: number;
  /** Confidence decay per day once stale (default 0.02) */
  decay_rate: number;
}

export interface MetaConfig {
  /** Current confidence thresholds */
  thresholds: ConfidenceThresholds;
  /** Learned communication style preferences */
  communication_style: CommunicationStyleData;
  /** Pruning configuration */
  prune_config: PruneConfig;
  /** ISO timestamp of last self-tuning run */
  last_tuned: string;
}

// ============================================
// Sentinel State (System 5)
// ============================================

export interface FileEditRecord {
  count: number;
  /** Unix timestamp (ms) of first edit in window */
  first: number;
  /** Unix timestamp (ms) of most recent edit */
  last: number;
}

export interface ToolFailureRecord {
  count: number;
  last_error: string;
  /** Unix timestamp (ms) of most recent failure */
  last: number;
}

export interface FileCreationRecord {
  /** Unix timestamp (ms) when file was created */
  created_at: number;
}

export interface SentinelState {
  session_id: string;
  /** Per-file edit counters */
  file_edit_counts: Record<string, FileEditRecord>;
  /** Per-tool failure counters */
  tool_failure_counts: Record<string, ToolFailureRecord>;
  /** Consecutive test failure count */
  consecutive_test_failures: number;
  /** Recently created files for overwrite detection */
  recent_files_created: Record<string, FileCreationRecord>;
  /** Recent intervention IDs for deduplication */
  recent_sentinel_warnings: string[];
}

export type SentinelWarningType =
  | 'thrashing'
  | 'test_loop'
  | 'error_cascade'
  | 'overwrite';

export interface SentinelWarning {
  type: SentinelWarningType;
  message: string;
  severity: 'low' | 'medium' | 'high';
  /** File or tool involved */
  subject: string;
}

// ============================================
// Observation Log Entries
// ============================================

export interface ObservationEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Tool that was called */
  tool_name: string;
  /** Key file paths involved */
  files: string[];
  /** Whether the tool call succeeded */
  success: boolean;
  /** Brief error description if failed */
  error?: string;
  /** Whether this followed a user prompt (potential correction) */
  follows_user_prompt: boolean;
  /** Session ID */
  session_id: string;
  /** Sentinel warnings that fired, if any */
  sentinel_warnings?: SentinelWarningType[];
}

// ============================================
// Hook Action Types (PreToolUse output)
// ============================================

export type HookActionType =
  | 'deny'
  | 'ask'
  | 'whisper'
  | 'insight'
  | 'correct'
  | 'pass';

export interface HookAction {
  type: HookActionType;
  /** For deny/ask: reason message */
  message?: string;
  /** For whisper/insight: advisory content */
  content?: string;
  /** For correct: modified tool input */
  updatedInput?: Record<string, unknown>;
  /** Source rule that triggered this action */
  source_rule_id?: string;
}

// ============================================
// Utility Types
// ============================================

export type LogFn = (message: string) => void;

/** Default meta-config values */
export const DEFAULT_META_CONFIG: MetaConfig = {
  thresholds: {
    whisper: 0.3,
    ask: 0.6,
    correct: 0.7,
    deny: 0.85,
  },
  communication_style: {
    preferred_length: 'short',
    preferred_format: 'contextual',
    effectiveness_data: {},
  },
  prune_config: {
    min_confidence: 0.1,
    stale_days: 30,
    decay_rate: 0.02,
  },
  last_tuned: new Date().toISOString(),
};

/** Default sentinel state */
export function createDefaultSentinelState(sessionId: string): SentinelState {
  return {
    session_id: sessionId,
    file_edit_counts: {},
    tool_failure_counts: {},
    consecutive_test_failures: 0,
    recent_files_created: {},
    recent_sentinel_warnings: [],
  };
}

/** Generate a unique ID with prefix */
export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.floor(Math.random() * 0xffff).toString(36).padStart(3, '0');
  return `${prefix}_${timestamp}${random}`;
}
