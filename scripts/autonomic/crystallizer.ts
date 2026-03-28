/**
 * Pattern Crystallizer (System 1)
 *
 * Turns raw observations into named, typed, scored pattern records.
 * Runs inside the background worker as Phase 2.
 *
 * Process:
 * 1. Temporal clustering — group observations by file + tool within time windows
 * 2. Outcome correlation — count successes vs failures within clusters
 * 3. User correction detection — scan for user messages that override Claude's work
 * 4. Cross-session recurrence — check if cluster shape matches existing patterns
 * 5. LLM naming — use a cheap model to name and describe discovered patterns
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ObservationEntry,
  PatternRecord,
  PatternType,
  PatternTrigger,
  SuggestedAction,
  LogFn,
} from './types.js';
import { generateId } from './types.js';
import { loadConfig, ReflectConfig } from '../conversation_utils.js';

const noopLog: LogFn = () => {};
const DAY_MS = 1000 * 60 * 60 * 24;

/**
 * Format a date as a human-readable relative time string.
 */
function formatRelativeTime(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return 'recently';

  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(Math.abs(diffMs) / DAY_MS);

  if (diffMs < 0) {
    if (diffDays === 0) return 'later today';
    if (diffDays === 1) return 'tomorrow';
    if (diffDays < 7) return `in ${diffDays} days`;
    return formatCalendarDate(dateStr);
  }

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return formatCalendarDate(dateStr);
}

function formatCalendarDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ============================================
// Observation Clustering
// ============================================

interface ObservationCluster {
  /** Observations in this cluster */
  entries: ObservationEntry[];
  /** Primary file involved */
  primary_file: string | null;
  /** Primary tool involved */
  primary_tool: string;
  /** Failure rate within the cluster */
  failure_rate: number;
  /** Whether this cluster involves user corrections */
  has_user_correction: boolean;
  /** Cluster type hint */
  type_hint: PatternType;
}

/**
 * Group observations into temporal clusters by file + tool.
 */
function clusterObservations(
  observations: ObservationEntry[],
  config: ReflectConfig,
): ObservationCluster[] {
  if (observations.length < config.crystallizerMinClusterSize) return [];

  // Sort by timestamp
  const sorted = [...observations].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Group by tool + primary file
  const groups = new Map<string, ObservationEntry[]>();
  for (const obs of sorted) {
    const primaryFile = obs.files[0] || '__no_file__';
    const key = `${obs.tool_name}::${primaryFile}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(obs);
  }

  const clusters: ObservationCluster[] = [];

  for (const [key, entries] of groups) {
    // Split into temporal windows
    const windows: ObservationEntry[][] = [];
    let currentWindow: ObservationEntry[] = [];

    for (const entry of entries) {
      const entryTime = new Date(entry.timestamp).getTime();
      if (
        currentWindow.length === 0 ||
        entryTime - new Date(currentWindow[0].timestamp).getTime() < config.crystallizerClusterWindowMs
      ) {
        currentWindow.push(entry);
      } else {
        if (currentWindow.length >= config.crystallizerMinClusterSize) {
          windows.push(currentWindow);
        }
        currentWindow = [entry];
      }
    }
    if (currentWindow.length >= config.crystallizerMinClusterSize) {
      windows.push(currentWindow);
    }

    // Convert windows to clusters
    for (const window of windows) {
      const failures = window.filter((e) => !e.success);
      const failureRate = failures.length / window.length;
      const hasUserCorrection = window.some((e) => e.follows_user_prompt);
      const primaryFile = window[0].files[0] || null;
      const primaryTool = window[0].tool_name;

      // Determine type hint
      let typeHint: PatternType = 'recurring_gotcha';
      if (failureRate > 0.5) {
        typeHint = 'failure_loop';
      } else if (hasUserCorrection) {
        typeHint = 'user_correction';
      } else if (window.some((e) => e.sentinel_warnings?.includes('thrashing'))) {
        typeHint = 'thrashing';
      }

      clusters.push({
        entries: window,
        primary_file: primaryFile,
        primary_tool: primaryTool,
        failure_rate: failureRate,
        has_user_correction: hasUserCorrection,
        type_hint: typeHint,
      });
    }
  }

  return clusters;
}

/**
 * Check if a cluster matches an existing pattern based on trigger similarity.
 */
function findMatchingPattern(
  cluster: ObservationCluster,
  patterns: PatternRecord[],
): PatternRecord | null {
  for (const pattern of patterns) {
    const toolMatch =
      !pattern.trigger.tool || pattern.trigger.tool === cluster.primary_tool;
    const fileMatch =
      !pattern.trigger.file_pattern ||
      (cluster.primary_file && simpleGlobMatch(pattern.trigger.file_pattern, cluster.primary_file));
    const typeMatch = pattern.type === cluster.type_hint;

    if (toolMatch && fileMatch && typeMatch) {
      return pattern;
    }
  }
  return null;
}

/**
 * Simple glob pattern matching (avoids minimatch dependency).
 * Supports: *, **, and basic path matching.
 */
function simpleGlobMatch(pattern: string, filepath: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DOUBLESTAR>>>/g, '.*');

  try {
    const regex = new RegExp(`^${regexStr}$`);
    return regex.test(filepath);
  } catch {
    // If pattern is invalid, do substring match
    return filepath.includes(pattern.replace(/\*/g, ''));
  }
}

/**
 * Derive a file pattern from observed file paths.
 */
function deriveFilePattern(files: string[]): string | undefined {
  if (files.length === 0) return undefined;

  // Find common directory prefix
  const parts = files.map((f) => f.split('/'));
  const minLen = Math.min(...parts.map((p) => p.length));
  let commonPrefixLen = 0;

  for (let i = 0; i < minLen - 1; i++) {
    if (parts.every((p) => p[i] === parts[0][i])) {
      commonPrefixLen = i + 1;
    } else {
      break;
    }
  }

  if (commonPrefixLen === 0) return undefined;

  const prefix = parts[0].slice(0, commonPrefixLen).join('/');
  return `${prefix}/**`;
}

// ============================================
// LLM-Powered Pattern Naming
// ============================================

interface CrystallizedPattern {
  name: string;
  type: PatternType;
  trigger: PatternTrigger;
  suggested_action: SuggestedAction;
}

function buildHistoricalInsight(
  type: PatternType,
  cluster: ObservationCluster,
  options: {
    firstSeen?: string;
    lastSeen?: string;
    totalOccurrences?: number;
  } = {},
): string {
  const actions: Record<PatternType, string> = {
    failure_loop:
      'This file has caused repeated failures. Re-read the full file and any related test files before editing.',
    user_correction:
      "The user has corrected work on this file before. Pay close attention to the user's preferred approach.",
    thrashing:
      'This file is being edited repeatedly. Step back and plan the changes before making more edits.',
    recurring_gotcha:
      "There's a recurring issue with this tool on this file. Consider using a different approach.",
    preference_signal:
      'The user has a preference around how this file is handled.',
  };

  const firstSeen = options.firstSeen ?? cluster.entries[0].timestamp;
  const lastSeen =
    options.lastSeen ?? cluster.entries[cluster.entries.length - 1].timestamp;
  const totalOccurrences = options.totalOccurrences ?? cluster.entries.length;
  const firstSeenSummary = `${formatRelativeTime(firstSeen)} (${formatCalendarDate(firstSeen)})`;
  const lastSeenSummary = `${formatRelativeTime(lastSeen)} (${formatCalendarDate(lastSeen)})`;
  const recurrenceSummary =
    totalOccurrences > 1
      ? `This pattern first showed up ${firstSeenSummary} and has now appeared ${totalOccurrences} times, most recently ${lastSeenSummary}.`
      : `This pattern first showed up ${firstSeenSummary}.`;

  return `${actions[type]} ${recurrenceSummary}`;
}

/**
 * Use a cheap LLM to name and classify a cluster into a pattern.
 * Falls back to heuristic naming if the API call fails.
 */
async function namePatternWithLLM(
  cluster: ObservationCluster,
  cwd: string,
  log: LogFn = noopLog,
): Promise<CrystallizedPattern> {
  const config = loadConfig(cwd);
  const apiKey = config.anthropicApiKey;
  if (!apiKey) {
    log('No API key, using heuristic pattern naming');
    return heuristicPatternName(cluster);
  }

  try {
    const client = new Anthropic({ apiKey });
    const clusterSummary = summarizeCluster(cluster);

    const response = await client.messages.create({
      model: config.crystallizerModel,
      max_tokens: 400,
      system:
        'You analyze coding behavior patterns. Given a cluster of tool observations, ' +
        'generate a concise JSON object describing the pattern. ' +
        'Respond ONLY with valid JSON, no markdown fences.',
      messages: [
        {
          role: 'user',
          content:
            `Analyze this cluster of ${cluster.entries.length} observations and generate a pattern record:\n\n` +
            `${clusterSummary}\n\n` +
            `Respond with JSON: { "name": "short descriptive name", "type": "${cluster.type_hint}", ` +
            `"suggested_action": { "type": "insight", "content": "A conversational insight that explains the history of this pattern and why it is resurfacing now. Ground it in the timestamps and counts provided. Mention concrete first-seen and last-seen dates, not only relative terms like 'yesterday'." } }`,

        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip markdown fences if present
    text = text.replace(/```json\n?/, '').replace(/\n?```/, '').trim();

    const parsed = JSON.parse(text);
    const parsedInsightContent =
      typeof parsed?.suggested_action?.content === 'string'
        ? parsed.suggested_action.content.trim()
        : '';

    return {
      name: parsed.name || heuristicPatternName(cluster).name,
      type: parsed.type || cluster.type_hint,
      trigger: {
        tool: cluster.primary_tool,
        file_pattern: cluster.primary_file
          ? deriveFilePattern(cluster.entries.flatMap((e) => e.files))
          : undefined,
      },
      suggested_action: {
        type: 'insight',
        content:
          parsedInsightContent || buildHistoricalInsight(cluster.type_hint, cluster),
      },
    };
  } catch (error) {
    log(`LLM pattern naming failed: ${error}, falling back to heuristic`);
    return heuristicPatternName(cluster);
  }
}

/**
 * Generate a pattern name heuristically (no LLM needed).
 */
function heuristicPatternName(cluster: ObservationCluster): CrystallizedPattern {
  const filename = cluster.primary_file
    ? cluster.primary_file.split('/').pop() || 'unknown'
    : 'multiple files';

  const names: Record<PatternType, string> = {
    failure_loop: `Repeated failures editing ${filename}`,
    user_correction: `User corrections on ${filename}`,
    thrashing: `Thrashing on ${filename}`,
    recurring_gotcha: `Recurring issue with ${cluster.primary_tool} on ${filename}`,
    preference_signal: `Preference pattern for ${filename}`,
  };

  return {
    name: names[cluster.type_hint],
    type: cluster.type_hint,
    trigger: {
      tool: cluster.primary_tool,
      file_pattern: cluster.primary_file
        ? deriveFilePattern(cluster.entries.flatMap((e) => e.files))
        : undefined,
    },
    suggested_action: {
      type: 'insight',
      content: buildHistoricalInsight(cluster.type_hint, cluster),
    },
  };
}

/**
 * Create a human-readable summary of a cluster for the LLM.
 */
function summarizeCluster(cluster: ObservationCluster): string {
  const files = [...new Set(cluster.entries.flatMap((e) => e.files))];
  const tools = [...new Set(cluster.entries.map((e) => e.tool_name))];
  const failures = cluster.entries.filter((e) => !e.success);
  const successes = cluster.entries.filter((e) => e.success);
  const errors = failures
    .filter((e) => e.error)
    .map((e) => e.error!)
    .slice(0, 3);

  const firstSeenStr = cluster.entries[0].timestamp;
  const lastSeenStr = cluster.entries[cluster.entries.length - 1].timestamp;

  return [
    `Tool(s): ${tools.join(', ')}`,
    `File(s): ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}`,
    `Total observations: ${cluster.entries.length}`,
    `Successes: ${successes.length}, Failures: ${failures.length}`,
    `Failure rate: ${Math.round(cluster.failure_rate * 100)}%`,
    `Has user corrections: ${cluster.has_user_correction}`,
    `Type hint: ${cluster.type_hint}`,
    errors.length > 0 ? `Sample errors: ${errors.join('; ')}` : '',
    `First seen: ${formatRelativeTime(firstSeenStr)} (${firstSeenStr})`,
    `Last seen: ${formatRelativeTime(lastSeenStr)} (${lastSeenStr})`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ============================================
// Main Crystallization
// ============================================

/**
 * Process recent observations and crystallize them into patterns.
 * Called from the background worker as Phase 2.
 *
 * @returns Updated patterns array
 */
export async function crystallize(
  cwd: string,
  recentObservations: ObservationEntry[],
  existingPatterns: PatternRecord[],
  log: LogFn = noopLog,
): Promise<PatternRecord[]> {
  const config = loadConfig(cwd);
  if (recentObservations.length < config.crystallizerMinClusterSize) {
    log(`Only ${recentObservations.length} observations, skipping crystallization`);
    return existingPatterns;
  }

  log(`Crystallizing ${recentObservations.length} observations...`);
  const clusters = clusterObservations(recentObservations, config);
  log(`Found ${clusters.length} clusters`);

  if (clusters.length === 0) {
    return existingPatterns;
  }

  const updatedPatterns = [...existingPatterns];

  for (const cluster of clusters) {
    // Check if this cluster matches an existing pattern
    const existingMatch = findMatchingPattern(cluster, updatedPatterns);

    if (existingMatch) {
      // Update existing pattern with new evidence
      const idx = updatedPatterns.findIndex((p) => p.id === existingMatch.id);
      if (idx >= 0) {
        const totalEvidence = existingMatch.evidence_count + cluster.entries.length;
        const clusterLastSeen =
          cluster.entries[cluster.entries.length - 1].timestamp;
        const refreshedSuggestedAction =
          existingMatch.suggested_action.type === 'insight'
            ? {
                ...existingMatch.suggested_action,
                content: buildHistoricalInsight(existingMatch.type, cluster, {
                  firstSeen: existingMatch.first_seen,
                  lastSeen: clusterLastSeen,
                  totalOccurrences: totalEvidence,
                }),
              }
            : existingMatch.suggested_action;

        updatedPatterns[idx] = {
          ...existingMatch,
          evidence_count: totalEvidence,
          confidence: Math.min(
            config.crystallizerMaxConfidence,
            existingMatch.confidence + config.crystallizerConfidenceBump * cluster.entries.length,
          ),
          last_seen: clusterLastSeen,
          suggested_action: refreshedSuggestedAction,
        };
        log(
          `Updated pattern "${existingMatch.name}" — evidence: ${updatedPatterns[idx].evidence_count}, ` +
            `confidence: ${updatedPatterns[idx].confidence.toFixed(2)}`,
        );
      }
    } else {
      // Create new pattern
      const crystallized = await namePatternWithLLM(cluster, cwd, log);
      const newPattern: PatternRecord = {
        id: generateId('pat'),
        name: crystallized.name,
        type: crystallized.type,
        trigger: crystallized.trigger,
        evidence_count: cluster.entries.length,
        confidence: config.crystallizerInitialConfidence + config.crystallizerConfidenceBump * (cluster.entries.length - config.crystallizerMinClusterSize),
        first_seen: cluster.entries[0].timestamp,
        last_seen: cluster.entries[cluster.entries.length - 1].timestamp,
        suggested_action: crystallized.suggested_action,
      };

      updatedPatterns.push(newPattern);
      log(
        `New pattern: "${newPattern.name}" (${newPattern.type}) — confidence: ${newPattern.confidence.toFixed(2)}`,
      );
    }
  }

  return updatedPatterns;
}

// Re-export for use by other modules
export { simpleGlobMatch };
