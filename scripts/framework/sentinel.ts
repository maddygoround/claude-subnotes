/**
 * Real-Time Sentinel (System 5)
 *
 * Fast, in-process pattern detection using pure counters and timers.
 * No LLM calls — must execute in < 50ms.
 *
 * Detects:
 * 1. Thrashing: Same file edited 5+ times in 10 minutes
 * 2. Test loops: 3+ consecutive test failures
 * 3. Error cascades: Same tool errored 3+ times in 5 minutes
 * 4. Overwrites: Writing to a file created < 60 seconds ago
 *
 * State lives in /tmp (ephemeral per session).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  SentinelState,
  SentinelWarning,
  SentinelWarningType,
  FileEditRecord,
  ToolFailureRecord,
  LogFn,
} from '../autonomic/types.js';
import { createDefaultSentinelState } from '../autonomic/types.js';
import {
  extractFilePathsFromToolInput,
  STANDARD_FILE_PATH_FIELDS,
} from './utils/file-paths.js';

import { ReflectConfig } from '../conversation_utils.js';

/** Tools that count as "test runners" */
const TEST_TOOL_PATTERNS = ['test', 'vitest', 'jest', 'pytest', 'cargo test', 'go test'];

/** Tools that do file edits */
const FILE_EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'mcp_claude-code_Edit', 'mcp_claude-code_Write'];

/** Tools that create files */
const FILE_CREATE_TOOLS = ['Write', 'mcp_claude-code_Write'];

const noopLog: LogFn = () => {};

// ============================================
// State I/O
// ============================================

function getSentinelStatePath(sessionId: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
  const tempDir = path.join(os.tmpdir(), `subnotes-sync-${uid}`);
  return path.join(tempDir, `sentinel-${sessionId}.json`);
}

/**
 * Load sentinel state from /tmp.
 * Returns default state if file doesn't exist.
 */
export function loadSentinelState(sessionId: string): SentinelState {
  const statePath = getSentinelStatePath(sessionId);
  if (!fs.existsSync(statePath)) {
    return createDefaultSentinelState(sessionId);
  }

  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    // Ensure all fields exist
    return {
      ...createDefaultSentinelState(sessionId),
      ...data,
      session_id: sessionId,
    };
  } catch {
    return createDefaultSentinelState(sessionId);
  }
}

/**
 * Save sentinel state to /tmp.
 */
export function saveSentinelState(sessionId: string, state: SentinelState): void {
  const statePath = getSentinelStatePath(sessionId);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf-8');
  } catch {
    // Fail silently — sentinel state is ephemeral
  }
}

/**
 * Clean up sentinel state file on session end.
 */
export function cleanupSentinelState(sessionId: string): void {
  const statePath = getSentinelStatePath(sessionId);
  try {
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================
// State Update
// ============================================

/**
 * Check if a tool call represents a test run.
 */
function isTestRun(toolName: string, toolInput: unknown): boolean {
  if (!toolInput || typeof toolInput !== 'object') return false;

  const input = toolInput as Record<string, unknown>;

  // Check tool name patterns
  const lowerTool = toolName.toLowerCase();
  if (TEST_TOOL_PATTERNS.some((p) => lowerTool.includes(p))) {
    return true;
  }

  // Check Bash commands for test patterns
  if (
    (toolName === 'Bash' || toolName === 'mcp_claude-code_Bash') &&
    typeof input.command === 'string'
  ) {
    const cmd = (input.command as string).toLowerCase();
    return TEST_TOOL_PATTERNS.some((p) => cmd.includes(p));
  }

  return false;
}

/**
 * Check if a tool response indicates failure.
 */
function isToolFailure(toolResponse: unknown): boolean {
  if (!toolResponse) return false;

  const responseStr =
    typeof toolResponse === 'string'
      ? toolResponse
      : JSON.stringify(toolResponse);

  // Common failure indicators
  const failurePatterns = [
    'error',
    'Error',
    'ERROR',
    'FAIL',
    'failed',
    'Failed',
    'exit code',
    'exitCode',
    'is_error',
    'ENOENT',
    'EACCES',
    'EPERM',
    'SyntaxError',
    'TypeError',
    'ReferenceError',
  ];

  return failurePatterns.some((p) => responseStr.includes(p));
}

/**
 * Extract error message from tool response.
 */
function extractError(toolResponse: unknown): string {
  if (!toolResponse) return 'unknown error';
  const str =
    typeof toolResponse === 'string'
      ? toolResponse
      : JSON.stringify(toolResponse);
  // Take first 200 chars as error summary
  return str.slice(0, 200);
}

/**
 * Prune old entries from counter maps.
 * Removes entries older than the given window.
 */
function pruneOldEntries<T extends { last: number }>(
  records: Record<string, T>,
  windowMs: number,
): Record<string, T> {
  const now = Date.now();
  const pruned: Record<string, T> = {};
  for (const [key, record] of Object.entries(records)) {
    if (now - record.last < windowMs) {
      pruned[key] = record;
    }
  }
  return pruned;
}

/**
 * Update sentinel state based on a tool event.
 * Called from PostToolUse hook.
 */
export function updateSentinelState(
  state: SentinelState,
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
  config: ReflectConfig,
  log: LogFn = noopLog,
): SentinelState {
  const now = Date.now();
  const updated = { ...state };

  // 1. Track file edits
  if (FILE_EDIT_TOOLS.some((t) => toolName.includes(t))) {
    const files = extractFilePathsFromToolInput(
      toolInput,
      STANDARD_FILE_PATH_FIELDS,
    );
    for (const filePath of files) {
      const existing = updated.file_edit_counts[filePath];
      if (existing && now - existing.first < config.sentinelThrashingWindowMs) {
        updated.file_edit_counts[filePath] = {
          count: existing.count + 1,
          first: existing.first,
          last: now,
        };
      } else {
        updated.file_edit_counts[filePath] = {
          count: 1,
          first: now,
          last: now,
        };
      }
    }
  }

  // 2. Track file creations (for overwrite detection)
  if (FILE_CREATE_TOOLS.some((t) => toolName.includes(t))) {
    const files = extractFilePathsFromToolInput(
      toolInput,
      STANDARD_FILE_PATH_FIELDS,
    );
    for (const filePath of files) {
      if (!updated.recent_files_created[filePath]) {
        updated.recent_files_created[filePath] = { created_at: now };
      }
    }
  }

  // 3. Track test runs
  if (isTestRun(toolName, toolInput)) {
    const failed = isToolFailure(toolResponse);
    if (failed) {
      updated.consecutive_test_failures = (updated.consecutive_test_failures || 0) + 1;
    } else {
      updated.consecutive_test_failures = 0;
    }
  }

  // 4. Track tool failures
  if (isToolFailure(toolResponse)) {
    const existing = updated.tool_failure_counts[toolName];
    if (existing && now - existing.last < config.sentinelErrorCascadeWindowMs) {
      updated.tool_failure_counts[toolName] = {
        count: existing.count + 1,
        last_error: extractError(toolResponse),
        last: now,
      };
    } else {
      updated.tool_failure_counts[toolName] = {
        count: 1,
        last_error: extractError(toolResponse),
        last: now,
      };
    }
  }

  // Periodic pruning — remove stale entries
  updated.file_edit_counts = pruneOldEntries(
    updated.file_edit_counts,
    config.sentinelThrashingWindowMs * 2,
  );
  updated.tool_failure_counts = pruneOldEntries(
    updated.tool_failure_counts,
    config.sentinelErrorCascadeWindowMs * 2,
  );

  // Prune old file creation records
  const creationPruned: Record<string, { created_at: number }> = {};
  for (const [key, record] of Object.entries(updated.recent_files_created)) {
    if (now - record.created_at < config.sentinelOverwriteWindowMs * 5) {
      creationPruned[key] = record;
    }
  }
  updated.recent_files_created = creationPruned;

  return updated;
}

// ============================================
// Trigger Checking
// ============================================

/**
 * Count how many times a warning type has been emitted.
 */
function countWarningType(
  warnings: string[],
  type: SentinelWarningType,
): number {
  return warnings.filter((w) => w === type).length;
}

/**
 * Check sentinel state for trigger conditions.
 * Returns warnings to inject into PreToolUse context.
 *
 * Called from PreToolUse hook — must be fast (< 5ms).
 */
export function checkSentinelTriggers(
  state: SentinelState,
  config: ReflectConfig,
  currentToolName?: string,
  currentToolInput?: unknown,
): SentinelWarning[] {
  const warnings: SentinelWarning[] = [];
  const now = Date.now();

  // 1. Thrashing detector
  for (const [filePath, record] of Object.entries(state.file_edit_counts)) {
    if (
      record.count >= config.sentinelThrashingThreshold &&
      now - record.first < config.sentinelThrashingWindowMs &&
      countWarningType(state.recent_sentinel_warnings, 'thrashing') < 3
    ) {
      const filename = path.basename(filePath);
      warnings.push({
        type: 'thrashing',
        message:
          `File "${filename}" has been edited ${record.count} times in the last ` +
          `${Math.round((now - record.first) / 60000)} minutes. Consider stepping back ` +
          `to re-read the file and understand the full context before making more changes.`,
        severity: record.count >= config.sentinelThrashingThreshold * 2 ? 'high' : 'medium',
        subject: filePath,
      });
    }
  }

  // 2. Test loop detector
  if (
    state.consecutive_test_failures >= config.sentinelTestLoopThreshold &&
    countWarningType(state.recent_sentinel_warnings, 'test_loop') < 3
  ) {
    warnings.push({
      type: 'test_loop',
      message:
        `Tests have failed ${state.consecutive_test_failures} times consecutively. ` +
        `Consider re-reading the test expectations and the code under test together ` +
        `before making more changes. The root cause may be different from what the ` +
        `error messages suggest.`,
      severity: state.consecutive_test_failures >= config.sentinelTestLoopThreshold * 2 ? 'high' : 'medium',
      subject: 'test',
    });
  }

  // 3. Error cascade detector
  for (const [toolName, record] of Object.entries(state.tool_failure_counts)) {
    if (
      record.count >= config.sentinelErrorCascadeThreshold &&
      now - record.last < config.sentinelErrorCascadeWindowMs &&
      countWarningType(state.recent_sentinel_warnings, 'error_cascade') < 3
    ) {
      warnings.push({
        type: 'error_cascade',
        message:
          `Tool "${toolName}" has errored ${record.count} times in the last ` +
          `${Math.round((now - record.last + (now - record.last)) / 60000)} minutes. ` +
          `Last error: "${record.last_error.slice(0, 100)}". ` +
          `Consider trying a completely different approach.`,
        severity: 'high',
        subject: toolName,
      });
    }
  }

  // 4. Overwrite detector (check current tool call)
  if (
    currentToolName &&
    FILE_CREATE_TOOLS.some((t) => currentToolName.includes(t)) &&
    currentToolInput
  ) {
    const files = extractFilePathsFromToolInput(
      currentToolInput,
      STANDARD_FILE_PATH_FIELDS,
    );
    for (const filePath of files) {
      const creation = state.recent_files_created[filePath];
      if (
        creation &&
        now - creation.created_at < config.sentinelOverwriteWindowMs &&
        countWarningType(state.recent_sentinel_warnings, 'overwrite') < 3
      ) {
        const filename = path.basename(filePath);
        const secondsAgo = Math.round((now - creation.created_at) / 1000);
        warnings.push({
          type: 'overwrite',
          message:
            `File "${filename}" was created only ${secondsAgo} seconds ago and is ` +
            `about to be overwritten. Is this intentional? If not, consider using ` +
            `Edit instead of Write to modify specific parts.`,
          severity: 'low',
          subject: filePath,
        });
      }
    }
  }

  return warnings;
}

/**
 * Record that sentinel warnings were emitted (for deduplication).
 */
export function recordSentinelWarnings(
  state: SentinelState,
  warnings: SentinelWarning[],
): SentinelState {
  const updated = { ...state };
  updated.recent_sentinel_warnings = [
    ...updated.recent_sentinel_warnings,
    ...warnings.map((w) => w.type),
  ];
  // Keep only last 50 warning types
  if (updated.recent_sentinel_warnings.length > 50) {
    updated.recent_sentinel_warnings = updated.recent_sentinel_warnings.slice(-50);
  }
  return updated;
}

/**
 * Queue emitted warnings so the following PostToolUse observation can retain
 * the real-time sentinel context in the historical log.
 */
export function queueSentinelWarningsForObservation(
  state: SentinelState,
  warnings: SentinelWarning[],
): SentinelState {
  const nextWarningTypes = new Set([
    ...(state.pending_observation_warnings || []),
    ...warnings.map((warning) => warning.type),
  ]);

  return {
    ...state,
    pending_observation_warnings: Array.from(nextWarningTypes),
  };
}

/**
 * Format sentinel warnings as XML for hook context injection.
 */
export function formatSentinelWarnings(warnings: SentinelWarning[]): string {
  if (warnings.length === 0) return '';

  const formatted = warnings
    .map(
      (w) =>
        `<sentinel_warning type="${w.type}" severity="${w.severity}" subject="${w.subject}">\n` +
        `${w.message}\n` +
        `</sentinel_warning>`,
    )
    .join('\n\n');

  return `<sentinel_alerts>\n${formatted}\n</sentinel_alerts>`;
}
