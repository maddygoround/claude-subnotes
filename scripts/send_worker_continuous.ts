#!/usr/bin/env npx tsx
/**
 * Continuous Background Worker - Long-Running Subconscious Agent
 *
 * Unlike the legacy one-shot worker pattern, this worker runs
 * continuously throughout the session, watching for new transcript entries
 * and updating memory in real-time.
 *
 * This enables PreToolUse to inject fresh analysis mid-conversation.
 *
 * Autonomic Pipeline (Systems 1-4):
 * Phase 1: Ingest transcript (existing)
 * Phase 2: Crystallize observations into patterns (System 1)
 * Phase 3: Promote patterns to reflex rules (System 2)
 * Phase 4: Resolve intervention outcomes (System 3)
 * Phase 5: Self-tune confidence and thresholds (System 4)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkerSdkToolsCapabilityLine } from './framework/utils/sdk-tools-mode.js';
import { isProcessRunning } from './framework/utils/process.js';
import {
  createFileLogger,
  runAgentLoop,
  appendAgentMessage,
  evaluateForegroundCandidate,
  loadAgentMessageHistory,
  BASE_SURFACE_THRESHOLD,
  scoreOutcomeMomentum,
  type AgentMessageType,
  type ForegroundCandidate,
  type ForegroundDecision,
} from './framework/index.js';
import { withProcessLock } from './state_store.js';
import {
  loadLocalMemory,
  saveLocalMemory,
  loadConfig,
  MemoryBlock,
  SdkToolsMode,
  getTempStateDir,
  getContinuousTranscriptPath,
  getContinuousWorkerPidFile,
  getSubconsciousSystemPrompt,
  isAutonomicEnabled,
} from './conversation_utils.js';
import {
  appendObservation,
  loadRecentObservations,
  loadPatterns,
  savePatterns,
  loadAllReflexRules,
  saveReflexRules,
  loadInterventions,
  saveInterventions,
  loadMetaConfig,
  saveMetaConfig,
  truncateObservations,
  crystallize,
  promotePatterns,
  resolveOutcomes,
  getRecentlyResolved,
  pruneInterventions,
  tune,
} from './autonomic/index.js';
import type {
  ObservationEntry,
  SentinelWarningType,
  InterventionRecord,
} from './autonomic/types.js';

const TEMP_STATE_DIR = getTempStateDir();
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_worker_continuous.log');
const log = createFileLogger(LOG_FILE);

interface ContinuousPayload {
  sessionId: string;
  cwd: string;
  sdkToolsMode: 'read-only' | 'full' | 'off';
}

interface TranscriptEntry {
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface TranscriptReadResult {
  newEntries: TranscriptEntry[];
  latestIndex: number;
}

// Graceful shutdown handling
let shouldExit = false;
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down gracefully...');
  shouldExit = true;
});
process.on('SIGINT', () => {
  log('Received SIGINT, shutting down gracefully...');
  shouldExit = true;
});

// ============================================
// Transcript Reading
// ============================================

function readNewTranscriptEntries(
  transcriptPath: string,
  lastProcessedIndex: number,
): TranscriptReadResult {
  if (!fs.existsSync(transcriptPath)) {
    return { newEntries: [], latestIndex: -1 };
  }

  const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
  if (!content) {
    return { newEntries: [], latestIndex: -1 };
  }

  const lines = content.split('\n');
  const newEntries: TranscriptEntry[] = [];
  const latestIndex = lines.length - 1;

  for (let i = lastProcessedIndex + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      newEntries.push(JSON.parse(lines[i]));
    } catch (e) {
      log(`Failed to parse transcript line ${i}: ${e}`);
    }
  }

  return { newEntries, latestIndex };
}

function formatTranscriptForAgent(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return '';

  const messages = entries
    .map((entry, idx) => {
      let role = 'System';
      switch (entry.role) {
        case 'user':
          role = 'User';
          break;
        case 'assistant':
          role = 'Claude Code';
          break;
        case 'system':
        default:
          role = 'System';
          break;
      }
      return `<message index="${idx}" role="${role}" timestamp="${entry.timestamp}">\n${entry.content}\n</message>`;
    })
    .join('\n\n');

  return `<transcript_update>\nNew messages since last check:\n\n${messages}\n</transcript_update>`;
}

// ============================================
// PID Management
// ============================================

function getPidFilePath(sessionId: string, cwd: string): string {
  return getContinuousWorkerPidFile(sessionId, cwd);
}

function readPidFile(pidFile: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    return Number.isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

function claimPidFile(sessionId: string, cwd: string): boolean {
  const pidFile = getPidFilePath(sessionId, cwd);
  return withProcessLock(
    `${pidFile}.claim.lock`,
    () => {
      const existingPid = readPidFile(pidFile);
      if (existingPid !== null && isProcessRunning(existingPid)) {
        log(
          `Another continuous worker already owns ${pidFile} (PID: ${existingPid}), exiting duplicate worker`,
        );
        return false;
      }

      if (fs.existsSync(pidFile)) {
        try {
          fs.unlinkSync(pidFile);
          log(`Removed stale PID file before claiming: ${pidFile}`);
        } catch (unlinkError) {
          const unlinkErr = unlinkError as NodeJS.ErrnoException;
          if (unlinkErr.code !== 'ENOENT') {
            throw unlinkError;
          }
        }
      }

      fs.writeFileSync(pidFile, `${process.pid}\n`, { flag: 'wx' });
      log(`Claimed PID file: ${pidFile} (PID: ${process.pid})`);
      return true;
    },
    {
      log,
      timeoutMs: 1500,
      staleMs: 15000,
    },
  );
}

function cleanupPidFile(sessionId: string, cwd: string): void {
  const pidFile = getPidFilePath(sessionId, cwd);
  if (!fs.existsSync(pidFile)) {
    return;
  }

  const currentPid = readPidFile(pidFile);
  if (currentPid === null) {
    fs.unlinkSync(pidFile);
    log(`Removed unreadable PID file during cleanup: ${pidFile}`);
    return;
  }

  if (currentPid !== process.pid) {
    log(
      `Skipping PID cleanup for ${pidFile}; ownership moved to PID ${currentPid}`,
    );
    return;
  }

  fs.unlinkSync(pidFile);
  log(`Cleaned up PID file: ${pidFile}`);
}

// ============================================
// Continuation Thought Extraction
// ============================================

interface ContinuationResult {
  text: string;
  continuationReason: string | null;
}

interface ParsedForegroundDecision {
  show: boolean;
  type: AgentMessageType | 'none';
  score: number;
  whyNow: string;
  content: string;
}

function extractContinuationThought(response: string): ContinuationResult {
  const match = response.match(/<continue_thought>([\s\S]*?)<\/continue_thought>/);
  if (!match) {
    return { text: response, continuationReason: null };
  }
  const continuationReason = match[1].trim();
  const text = response.replace(/<continue_thought>[\s\S]*?<\/continue_thought>/g, '').trim();
  return { text, continuationReason };
}

function extractXmlTag(block: string, tag: string): string {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = block.match(pattern);
  return match?.[1]?.trim() || '';
}

function parseForegroundDecision(response: string): ParsedForegroundDecision | null {
  const match = response.match(
    /<foreground_decision>([\s\S]*?)<\/foreground_decision>/i,
  );
  if (!match) {
    return null;
  }

  const block = match[1];
  const showRaw = extractXmlTag(block, 'show').toLowerCase();
  const typeRaw = extractXmlTag(block, 'type').toLowerCase();
  const scoreRaw = extractXmlTag(block, 'score');
  const whyNow = extractXmlTag(block, 'why_now');
  const content = extractXmlTag(block, 'content');
  const parsedScore = parseInt(scoreRaw, 10);
  const type: AgentMessageType | 'none' =
    typeRaw === 'reflect' || typeRaw === 'steer' || typeRaw === 'insight'
      ? typeRaw
      : 'none';
  const show = showRaw === 'yes' || showRaw === 'true';
  let fallbackScore = 18;
  switch (type) {
    case 'insight':
      fallbackScore = 84;
      break;
    case 'steer':
      fallbackScore = 72;
      break;
    case 'reflect':
      fallbackScore = 62;
      break;
    case 'none':
    default:
      fallbackScore = 18;
      break;
  }

  const score = Number.isFinite(parsedScore)
    ? Math.max(0, Math.min(100, parsedScore))
    : fallbackScore;

  return {
    show,
    type,
    score,
    whyNow,
    content,
  };
}

function extractLegacyThoughtCandidates(response: string): ForegroundCandidate[] {
  const typeRegex = /<(reflect|steer|insight)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  const candidates: ForegroundCandidate[] = [];

  while ((match = typeRegex.exec(response)) !== null) {
    const candidate: ForegroundCandidate = {
      type: match[1] as AgentMessageType,
      text: match[2].trim(),
    };
    if (!candidate.text) {
      continue;
    }
    candidates.push(candidate);
  }

  return candidates;
}

function summarizeRecentForegroundHistory(cwd: string): string {
  const history = loadAgentMessageHistory(cwd, log)
    .filter((message) => Boolean(message.read))
    .slice(-5);

  if (history.length === 0) {
    return `<recent_foreground_history>\nNone recently surfaced.\n</recent_foreground_history>`;
  }

  const items = history
    .map((message, index) => {
      const excerpt = message.text.replace(/\s+/g, ' ').slice(0, 180).trim();
      const score =
        typeof message.foreground_score === 'number'
          ? ` score="${message.foreground_score}"`
          : '';
      return `- [${index + 1}] type="${message.type || 'reflect'}"${score} ${excerpt}`;
    })
    .join('\n');

  return `<recent_foreground_history>\n${items}\n</recent_foreground_history>`;
}

function summarizeRecentInterventions(cwd: string): string {
  const interventions = loadInterventions(cwd, log).slice(-6);
  if (interventions.length === 0) {
    return `<recent_intervention_outcomes>\nNone recorded yet.\n</recent_intervention_outcomes>`;
  }

  const items = interventions
    .map((intervention, index) => {
      const outcome = intervention.outcome || 'unresolved';
      const excerpt = intervention.intervention_content
        .replace(/\s+/g, ' ')
        .slice(0, 160)
        .trim();
      return `- [${index + 1}] type="${intervention.type}" outcome="${outcome}" tool="${intervention.tool_name}" ${excerpt}`;
    })
    .join('\n');

  return `<recent_intervention_outcomes>\n${items}\n</recent_intervention_outcomes>`;
}

function buildWorkerForegroundDecision(
  decision: ParsedForegroundDecision,
  recentInterventions: InterventionRecord[],
): ForegroundDecision {
  const normalizedScore = decision.show
    ? Math.max(60, decision.score)
    : decision.score;

  const outcomeSignal = scoreOutcomeMomentum(recentInterventions);
  const typeBias = decision.type === 'reflect' ? 4 : 0;
  const threshold = Math.min(
    70,
    Math.max(48, BASE_SURFACE_THRESHOLD + outcomeSignal.thresholdAdjustment + typeBias),
  );

  return {
    shouldSurface: decision.show && normalizedScore >= threshold,
    score: normalizedScore,
    threshold,
    reasons: decision.whyNow
      ? [
          decision.whyNow,
          'foreground decision authored by subconscious worker',
        ]
      : ['foreground decision authored by subconscious worker'],
    urgency: 0,
    actionability: 0,
    relevance: 0,
    novelty: 0,
    durability: outcomeSignal.score,
    momentum: outcomeSignal.score,
    typeBias,
    metaPenalty: 0,
  };
}

// ============================================
// System Prompt
// ============================================

function buildSystemPrompt(
  memoryBlocks: MemoryBlock[],
  cwd: string,
  sdkToolsMode: SdkToolsMode,
): string {
  const fallbackSystemPrompt =
    `You are the Subconscious — a persistent agent that whispers to Claude Code.\n\n` +
    `You process transcript updates asynchronously. Use memory blocks to track user preferences, session patterns, project context, pending items, and guidance.\n\n` +
    `Be concise, observational, and useful.`;

  const basePrompt = getSubconsciousSystemPrompt(cwd, fallbackSystemPrompt, log);

  let prompt =
    `${basePrompt}\n\n` +
    `<runtime_context>\n` +
    `You are receiving incremental transcript updates between Claude tool calls and prompts.\n` +
    `${getWorkerSdkToolsCapabilityLine(sdkToolsMode)}\n` +
    `You are the subconscious layer, not the foreground assistant.\n` +
    `Do not ask the user questions directly and do not invent visible subagents.\n` +
    `If clarification is needed, frame it as a suggestion for Claude Code or provide a fallback assumption.\n` +
    `If you have a sub-question or follow-up thought that needs resolution before concluding, emit it as <continue_thought>your question or follow-up here</continue_thought> anywhere in your response — the worker will re-invoke you with that as the next input (max 2 continuations). Omit the tag when your thought is complete.\n` +
    `Tool results may include subconscious signals such as clarification_needed, assumption, risk, and boundary. Use them as internal scaffolding for your reasoning.\n` +
    `Update memory only when it adds durable value.\n` +
    `Silence is preferred. If you do not have a thought that should materially change Claude Code's next move or preserve important durable state, return an empty response.\n` +
    `</runtime_context>\n\n` +
    `<response_guidelines>\n` +
    `After you finish thinking and any tool use, emit exactly one <foreground_decision> block.\n` +
    `If nothing should surface right now, use:\n` +
    `<foreground_decision>\n<show>no</show>\n<type>none</type>\n<score>0-40</score>\n<why_now>brief internal reason</why_now>\n</foreground_decision>\n` +
    `If something should surface right now, use:\n` +
    `<foreground_decision>\n<show>yes</show>\n<type>reflect|steer|insight</type>\n<score>60-100</score>\n<why_now>brief internal reason tied to the current turn</why_now>\n<content>the exact single thought to surface</content>\n</foreground_decision>\n` +
    `Decision semantics:\n` +
    `- type="reflect": a concise durable observation that genuinely matters now.\n` +
    `- type="steer": Claude is drifting and a near-term correction will improve the next move.\n` +
    `- type="insight": high-priority loop breaker or root-cause pivot.\n` +
    `Never emit a surfaced thought merely to say you are watching, staying quiet, or that nothing needs guidance.\n` +
    `Choose the single highest-leverage thought per cycle. If you notice several things, keep only the one that most changes Claude's next action and use memory tools for the rest.\n` +
    `The <why_now> field is for internal routing/logging only and will not be shown to Claude.\n` +
    `Do not emit bare <reflect>, <steer>, or <insight> tags unless you are falling back because the decision format failed.\n` +
    `</response_guidelines>\n\n` +
    `Your current memory blocks:\n\n`;

  for (const block of memoryBlocks) {
    prompt += `<${block.label} description="${block.description}">\n${block.value}\n</${block.label}>\n\n`;
  }
  return prompt;
}

// ============================================
// Autonomic Pipeline (Phases 2-5)
// ============================================

// Autonomic interval/threshold defaults are now provided by config.json via loadConfig()

/**
 * Determine if a tool response represents an actual failure.
 *
 * The naive approach (scanning content for "error") produces false positives
 * whenever Claude reads TypeScript files containing `catch (error)`, error logs,
 * or any other legitimate use of the word "error" in code or documentation.
 *
 * Instead we check for structural indicators of real failure:
 * - Bash: non-zero exit code explicitly reported
 * - File tools: tool-level error prefix at the start of response
 */
function isToolResponseSuccessful(toolName: string, response: string): boolean {
  if (!response) return true;

  if (toolName === 'Bash') {
    // Real Bash failure: "exit code: N" where N is non-zero
    const exitCodeMatch = response.match(/exit code[:\s]+(\d+)/i);
    if (exitCodeMatch) {
      return parseInt(exitCodeMatch[1], 10) === 0;
    }
    return true;
  }

  // For file tools (Read, Glob, Grep, Edit, Write, LS):
  // Actual failures start with a tool-level error message, not file content.
  // File content always starts with line numbers (cat -n format) or structured output.
  const trimmed = response.trimStart();
  const toolErrorPrefixes = [
    'Error:',
    'ENOENT:',
    'EACCES:',
    'EPERM:',
    'Permission denied',
    'No such file or directory',
    'Cannot read',
    'Failed to',
    'not found',
  ];
  return !toolErrorPrefixes.some((prefix) =>
    trimmed.startsWith(prefix),
  );
}

/**
 * Convert transcript entries to observation entries for the autonomic store.
 */
function transcriptToObservations(
  entries: TranscriptEntry[],
  sessionId: string,
): ObservationEntry[] {
  const observations: ObservationEntry[] = [];
  const validSentinelWarnings = new Set<SentinelWarningType>([
    'thrashing',
    'test_loop',
    'error_cascade',
    'overwrite',
  ]);
  let userTurnActive = false;
  let lastObservation: ObservationEntry | null = null;

  for (const entry of entries) {
    if (entry.role === 'user') {
      userTurnActive = true;
      lastObservation = null;
      continue;
    }

    if (
      entry.role === 'system' &&
      entry.content.includes('<sentinel_event>') &&
      lastObservation
    ) {
      const warningTypes = Array.from(
        entry.content.matchAll(/<warning>(.*?)<\/warning>/g),
      )
        .map((match) => match[1])
        .filter(
          (warningType): warningType is SentinelWarningType =>
            validSentinelWarnings.has(warningType as SentinelWarningType),
        );

      if (warningTypes.length > 0) {
        const existingWarnings = new Set(lastObservation.sentinel_warnings || []);
        for (const warningType of warningTypes) {
          existingWarnings.add(warningType);
        }
        lastObservation.sentinel_warnings = Array.from(existingWarnings);
      }

      continue;
    }

    if (entry.role === 'system' && entry.content.includes('<tool_event>')) {
      const toolNameMatch = entry.content.match(/<name>(.*?)<\/name>/);
      const toolInputMatch = entry.content.match(/<input>([\s\S]*?)<\/input>/);
      const toolResponseMatch = entry.content.match(
        /<response>([\s\S]*?)<\/response>/,
      );

      if (toolNameMatch) {
        const toolName = toolNameMatch[1];
        const toolInput = toolInputMatch ? toolInputMatch[1] : '';
        const toolResponse = toolResponseMatch ? toolResponseMatch[1] : '';

        // Extract file paths from input
        const fileMatches = toolInput.match(
          /(?:file_path|filePath|path|TargetFile|AbsolutePath)["':\s]+["']?([^"'\s,}\]]+)/g,
        );
        const files = fileMatches
          ? fileMatches.map((m) => {
              const match = m.match(/["']?([^"'\s,}\]]+)$/);
              return match ? match[1] : '';
            }).filter(Boolean)
          : [];

        // Check for actual tool failure — not content containing the word "error"
        // (TypeScript files with `catch (error)` would otherwise be marked failed)
        const success = isToolResponseSuccessful(toolName, toolResponse);

        const observation: ObservationEntry = {
          timestamp: entry.timestamp,
          tool_name: toolName,
          files,
          success,
          error: success
            ? undefined
            : toolResponse.slice(0, 200),
          follows_user_prompt: userTurnActive,
          session_id: sessionId,
        };
        observations.push(observation);
        lastObservation = observation;
      }
    }
  }

  return observations;
}

/**
 * Run the autonomic processing pipeline (Phases 2-5).
 * Called after each transcript processing cycle.
 *
 * Phases 2-5 are batched: they only run every CRYSTALLIZE_INTERVAL cycles
 * or when enough observations have accumulated.
 */
async function runAutonomicPipeline(
  payload: ContinuousPayload,
  newEntries: TranscriptEntry[],
  cycleCount: number,
  pipelineLog: typeof log,
): Promise<void> {
  const { cwd, sessionId } = payload;

  // Phase: Convert transcript entries to observations and append
  const observations = transcriptToObservations(newEntries, sessionId);
  if (observations.length > 0) {
    for (const obs of observations) {
      appendObservation(cwd, obs, pipelineLog);
    }
    pipelineLog(
      `[Autonomic] Logged ${observations.length} observations`,
    );
  }

  const reflectConfig = loadConfig(cwd);
  const crystallizeInterval = reflectConfig.crystallizeInterval;
  const minObsForCrystallize = reflectConfig.minObservations;

  // Check if it's time for the heavy phases (batched)
  const recentObs = loadRecentObservations(cwd, 200, pipelineLog);
  const shouldCrystallize =
    cycleCount % crystallizeInterval === 0 ||
    recentObs.length >= minObsForCrystallize * 2;

  if (!shouldCrystallize) {
    return;
  }

  pipelineLog(
    `[Autonomic] Running full pipeline (cycle ${cycleCount}, ${recentObs.length} observations)...`,
  );

  // Phase 2: Crystallize patterns (System 1)
  let patterns = loadPatterns(cwd, pipelineLog);
  try {
    patterns = await crystallize(cwd, recentObs, patterns, pipelineLog);
    savePatterns(cwd, patterns, pipelineLog);
    pipelineLog(`[Autonomic] Phase 2 complete: ${patterns.length} patterns`);
  } catch (err) {
    pipelineLog(`[Autonomic] Phase 2 error: ${err}`);
  }

  // Phase 3: Promote patterns to reflex rules (System 2)
  let rules = loadAllReflexRules(cwd, pipelineLog);
  try {
    const metaConfig = loadMetaConfig(cwd, pipelineLog);
    rules = promotePatterns(patterns, rules, metaConfig, pipelineLog);
    saveReflexRules(cwd, rules, pipelineLog);
    pipelineLog(
      `[Autonomic] Phase 3 complete: ${rules.filter((r) => r.active).length} active rules`,
    );
  } catch (err) {
    pipelineLog(`[Autonomic] Phase 3 error: ${err}`);
  }

  // Phase 4: Resolve intervention outcomes (System 3)
  let interventions = loadInterventions(cwd, pipelineLog);
  try {
    // Convert recent transcript entries to the format expected by the tracker
    const transcriptForTracker = newEntries.map((e) => ({
      timestamp: e.timestamp,
      role: e.role,
      content: e.content,
    }));

    interventions = resolveOutcomes(
      interventions,
      transcriptForTracker,
      reflectConfig,
      pipelineLog,
    );
    interventions = pruneInterventions(interventions, 500);
    saveInterventions(cwd, interventions, pipelineLog);

    const unresolvedCount = interventions.filter(
      (i) => i.outcome === null,
    ).length;
    pipelineLog(
      `[Autonomic] Phase 4 complete: ${interventions.length} interventions (${unresolvedCount} pending)`,
    );
  } catch (err) {
    pipelineLog(`[Autonomic] Phase 4 error: ${err}`);
  }

  // Phase 5: Self-tune (System 4)
  try {
    let metaConfig = loadMetaConfig(cwd, pipelineLog);
    const recentlyResolved = getRecentlyResolved(
      interventions,
      metaConfig.last_tuned,
    );

    if (recentlyResolved.length > 0 || cycleCount % (crystallizeInterval * 5) === 0) {
      const result = tune(
        recentlyResolved,
        patterns,
        rules,
        metaConfig,
        reflectConfig,
        pipelineLog,
      );

      savePatterns(cwd, result.patterns, pipelineLog);
      saveReflexRules(cwd, result.rules, pipelineLog);
      saveMetaConfig(cwd, result.metaConfig, pipelineLog);

      if (result.changes.length > 0) {
        pipelineLog(
          `[Autonomic] Phase 5 complete: ${result.changes.join(', ')}`,
        );
      }
    }
  } catch (err) {
    pipelineLog(`[Autonomic] Phase 5 error: ${err}`);
  }

  // Periodic observation log cleanup
  if (cycleCount % (crystallizeInterval * 10) === 0) {
    truncateObservations(cwd, 1000, pipelineLog);
  }

  pipelineLog('[Autonomic] Pipeline complete');
}

// ============================================
// Main Continuous Loop
// ============================================

async function continuousLoop(payload: ContinuousPayload): Promise<void> {
  const transcriptPath = getContinuousTranscriptPath(
    payload.cwd,
    payload.sessionId,
  );
  let lastProcessedIndex = -1;
  let lastSeenTranscriptIndex = -1;
  let lastActivityAt = Date.now();
  let autonomicCycleCount = 0;

  const config = loadConfig(payload.cwd);
  const checkInterval = config.checkIntervalMs;
  const minMessages = config.minMessages;
  const idleTimeoutMs = config.idleTimeoutMs;

  log('Starting continuous loop...');
  log(`Check interval: ${checkInterval}ms`);
  log(`Min messages before processing: ${minMessages}`);
  if (idleTimeoutMs > 0) {
    log(`Idle timeout: ${idleTimeoutMs}ms`);
  } else {
    log('Idle timeout: disabled');
  }
  log(`Transcript path: ${transcriptPath}`);

  while (!shouldExit) {
    try {
      const { newEntries, latestIndex } = readNewTranscriptEntries(
        transcriptPath,
        lastProcessedIndex,
      );

      if (latestIndex !== lastSeenTranscriptIndex) {
        lastSeenTranscriptIndex = latestIndex;
        lastActivityAt = Date.now();
      }

      if (newEntries.length >= minMessages) {
        log(`Processing ${newEntries.length} new transcript entries...`);

        let memoryBlocks = loadLocalMemory(payload.cwd, log);
        let baseMemoryBlocks = memoryBlocks.map((block) => ({ ...block }));

        const transcriptText = formatTranscriptForAgent(newEntries);
        const recentForegroundHistory = summarizeRecentForegroundHistory(payload.cwd);
        const recentInterventionOutcomes = summarizeRecentInterventions(payload.cwd);
        const maxContinuations = config.maxContinuations;

        let currentUserMessage = `${transcriptText}

${recentForegroundHistory}

${recentInterventionOutcomes}

Process these new messages. Update memory blocks if you observe patterns, preferences, or important context. Then decide for yourself whether anything should surface into Claude's foreground right now.`;
        let finalResponse = '';

        for (let continuation = 0; continuation <= maxContinuations; continuation++) {
          const result = await runAgentLoop(
            {
              cwd: payload.cwd,
              sdkToolsMode: payload.sdkToolsMode,
              systemPromptBuilder: () =>
                buildSystemPrompt(memoryBlocks, payload.cwd, payload.sdkToolsMode),
              userMessage: currentUserMessage,
              log,
            },
            memoryBlocks,
          );

          memoryBlocks = result.memoryBlocks;

          if (result.memoriesUpdated) {
            saveLocalMemory(payload.cwd, memoryBlocks, log, {
              baseBlocks: baseMemoryBlocks,
            });
            baseMemoryBlocks = memoryBlocks.map((block) => ({ ...block }));
            log('✓ Saved updated memory blocks');
          }

          const { text: cleanResponse, continuationReason } =
            extractContinuationThought(result.assistantResponse);
          finalResponse = cleanResponse;

          if (!continuationReason || continuation >= maxContinuations) {
            if (continuationReason && continuation >= maxContinuations) {
              log(`↩ Max continuations reached (${maxContinuations}), concluding thought`);
            }
            break;
          }

          log(`↩ Self-continuing thought (${continuation + 1}/${maxContinuations}): ${continuationReason.slice(0, 120)}`);
          currentUserMessage = `Continuing your own thought from the previous cycle:\n\n"${continuationReason}"\n\nResolve this and conclude. If still unresolved and essential, you may continue once more.`;
        }

        if (finalResponse.trim()) {
          const structuredDecision = parseForegroundDecision(finalResponse);
          if (structuredDecision) {
            log(
              `Foreground decision from worker: show=${structuredDecision.show} ` +
              `type=${structuredDecision.type} score=${structuredDecision.score}` +
              (structuredDecision.whyNow
                ? ` — ${structuredDecision.whyNow}`
                : ''),
            );

            const workerRecentInterventions = loadInterventions(payload.cwd, log).slice(-12);
            const workerDecision = buildWorkerForegroundDecision(structuredDecision, workerRecentInterventions);
            if (
              workerDecision.shouldSurface &&
              structuredDecision.type !== 'none' &&
              structuredDecision.content
            ) {
              appendAgentMessage(
                payload.cwd,
                structuredDecision.content,
                log,
                structuredDecision.type,
                workerDecision,
              );
              log(
                `✓ Appended worker-directed foreground thought of type <${structuredDecision.type}>`,
              );
            } else {
              log('Worker kept this cycle internal; nothing entered Claude foreground');
            }
          } else {
            const thoughtCandidates = extractLegacyThoughtCandidates(finalResponse);
            if (thoughtCandidates.length > 0) {
              const recentInterventions = loadInterventions(payload.cwd, log).slice(-12);
              const history = loadAgentMessageHistory(payload.cwd, log);
              const evaluatedCandidates = thoughtCandidates
                .map((candidate) => ({
                  candidate,
                  decision: evaluateForegroundCandidate(
                    payload.cwd,
                    candidate,
                    {
                      recentTranscriptEntries: newEntries,
                      recentInterventions,
                      history,
                    },
                    log,
                  ),
                }))
                .sort((a, b) => b.decision.score - a.decision.score);
              const selectedThought = evaluatedCandidates.find(
                ({ decision }) => decision.shouldSurface,
              );

              for (const { candidate, decision } of evaluatedCandidates) {
                log(
                  `Legacy thought <${candidate.type}> scored ${decision.score}/${decision.threshold} ` +
                  `[urgency=${decision.urgency}, actionability=${decision.actionability}, ` +
                  `relevance=${decision.relevance}, novelty=${decision.novelty}, ` +
                  `durability=${decision.durability}, momentum=${decision.momentum}, ` +
                  `meta=${decision.metaPenalty}]` +
                  (decision.reasons.length > 0
                    ? ` — ${decision.reasons.join('; ')}`
                    : ''),
                );
              }

              if (selectedThought) {
                appendAgentMessage(
                  payload.cwd,
                  selectedThought.candidate.text,
                  log,
                  selectedThought.candidate.type,
                  selectedThought.decision,
                );
                log(
                  `✓ Appended legacy fallback foreground thought of type <${selectedThought.candidate.type}>`,
                );
              } else {
                log(
                  'Legacy fallback scorer kept all candidate thoughts internal for this cycle',
                );
              }
            } else {
              log(
                'No foreground decision or legacy thought candidates found; keeping the worker silent',
              );
            }
          }
        }

        lastProcessedIndex = latestIndex;
        log(`✓ Processed up to index ${lastProcessedIndex}`);

        // ========================================
        // Autonomic Pipeline (Phases 2-5)
        // ========================================
        if (isAutonomicEnabled(payload.cwd)) {
          try {
            await runAutonomicPipeline(
              payload,
              newEntries,
              autonomicCycleCount,
              log,
            );
          } catch (autoErr) {
            log(`Autonomic pipeline error (non-fatal): ${autoErr}`);
          }
          autonomicCycleCount++;
        }
      }

      if (
        idleTimeoutMs > 0 &&
        Date.now() - lastActivityAt >= idleTimeoutMs
      ) {
        log(
          `Idle timeout reached (${idleTimeoutMs}ms without transcript changes), exiting worker`,
        );
        break;
      }

      // Sleep before next check
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    } catch (error) {
      log(`Error in continuous loop: ${error}`);
      await new Promise((resolve) =>
        setTimeout(resolve, checkInterval * 2),
      );
    }
  }

  log('Continuous loop exited gracefully');
}

async function main(): Promise<void> {
  const payloadFile = process.argv[2];

  if (!payloadFile) {
    log('ERROR: No payload file specified');
    process.exit(1);
  }

  log('='.repeat(60));
  log(`Continuous Worker started with payload: ${payloadFile}`);

  try {
    if (!fs.existsSync(payloadFile)) {
      log(`ERROR: Payload file not found: ${payloadFile}`);
      process.exit(1);
    }

    const payload: ContinuousPayload = JSON.parse(
      fs.readFileSync(payloadFile, 'utf-8'),
    );
    log(`Loaded payload for session ${payload.sessionId}`);

    if (!claimPidFile(payload.sessionId, payload.cwd)) {
      if (fs.existsSync(payloadFile)) {
        fs.unlinkSync(payloadFile);
      }
      log('Duplicate worker exited before processing payload');
      return;
    }

    // Ensure cleanup on exit
    process.on('exit', () => cleanupPidFile(payload.sessionId, payload.cwd));

    // Start continuous processing
    await continuousLoop(payload);

    // Cleanup
    if (fs.existsSync(payloadFile)) {
      fs.unlinkSync(payloadFile);
      log('Cleaned up payload file');
    }
    log('Continuous Worker shut down successfully');
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
      log(`Stack: ${error.stack}`);
    }
    process.exit(1);
  }
}

main();
