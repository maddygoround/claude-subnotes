/**
 * Shared conversation and state management utilities
 * Used by hook scripts and background workers.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import {
  readJsonFileWithFallback,
  writeJsonFileAtomic,
  withProcessLock,
} from './state_store.js';
import { getStdoutSdkToolsCapabilityLine } from './framework/utils/sdk-tools-mode.js';
import {
  escapeRegex,
  escapeXmlAttribute,
  escapeXmlContent,
} from './framework/utils/xml.js';
import {
  cloneMemoryBlock,
  cloneMemoryBlocks,
  coerceMemoryBlocks,
  mergeMemoryBlocks,
  parseSyncStateData,
} from './framework/utils/conversation-state.js';
import { isProcessRunning } from './framework/utils/process.js';
import { readPidFromFile } from './framework/utils/pid.js';
import { parseClaudeTranscriptEntries } from './framework/utils/transcript-parser.js';
import {
  CLAUDE_MD_PATH,
  ROOT_CLAUDE_MD_PATH,
  SUBNOTES_SECTION_START,
  SUBNOTES_SECTION_END,
  cleanSubNotesFromClaudeMd,
  formatDistilledClaudeMd,
  formatMemoryBlocksAsXml,
  updateClaudeMd,
} from './conversation-utils/claude-md.js';
import {
  SDK_TOOLS_BLOCKED,
  SDK_TOOLS_READ_ONLY,
  ensureConfigFile,
  getMode,
  getSdkToolsMode,
  getTempStateDir,
  invalidateConfigCache,
  isAutonomicEnabled,
  loadConfig,
  type ReflectConfig,
  type SdkToolsMode,
  type SubNotesMode,
} from './conversation-utils/config.js';
import {
  ensureDurableStateDir,
  getDurableStateDir,
  getLegacySyncStateFile,
  getMemoryFile,
  getRepoNamespace,
  getSyncStateFile,
} from './conversation-utils/state-paths.js';
import { spawnSilentWorker } from './conversation-utils/worker-spawn.js';

export { escapeRegex, escapeXmlAttribute, escapeXmlContent };
export {
  CLAUDE_MD_PATH,
  ROOT_CLAUDE_MD_PATH,
  SUBNOTES_SECTION_START,
  SUBNOTES_SECTION_END,
  cleanSubNotesFromClaudeMd,
  formatDistilledClaudeMd,
  formatMemoryBlocksAsXml,
  updateClaudeMd,
};
export {
  SDK_TOOLS_BLOCKED,
  SDK_TOOLS_READ_ONLY,
  ensureConfigFile,
  getMode,
  getSdkToolsMode,
  getTempStateDir,
  invalidateConfigCache,
  isAutonomicEnabled,
  loadConfig,
};
export {
  ensureDurableStateDir,
  getDurableStateDir,
  getMemoryFile,
  getRepoNamespace,
  getSyncStateFile,
};
export { spawnSilentWorker };
export type { ReflectConfig, SdkToolsMode, SubNotesMode };

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// State & Memory Storage
// ============================================

export interface SyncState {
  lastProcessedIndex: number;
  sessionId: string;
  lastBlockValues?: { [label: string]: string };
  lastSeenMessageId?: string;
  lastMirroredTranscriptLine?: number;
  pendingToolUses?: Record<
    string,
    {
      name: string;
      input: unknown;
      timestamp: string;
    }
  >;
}

export interface MemoryBlock {
  label: string;
  description: string;
  value: string;
}

export type LogFn = (message: string) => void;
const noopLog: LogFn = () => {};
const SUBCONSCIOUS_AF_PATH = 'Subconscious.af';

interface SubconsciousTemplate {
  systemPrompt?: string;
  memoryBlocks?: MemoryBlock[];
}

interface TemplateCacheEntry {
  mtimeMs: number;
  template: SubconsciousTemplate | null;
}

const templateCache = new Map<string, TemplateCacheEntry>();

const CONTINUOUS_WORKER_PID_PREFIX = 'continuous-worker-';
const CONTINUOUS_WORKER_PID_SUFFIX = '.pid';
const CONTINUOUS_WORKER_SPAWN_LOCK_SUFFIX = '.spawn.lock';
const CONTINUOUS_PAYLOAD_PREFIX = 'continuous-payload-';
const CONTINUOUS_PAYLOAD_SUFFIX = '.json';
const LOCAL_PAYLOAD_PREFIX = 'payload-';
const LOCAL_PAYLOAD_SUFFIX = '.json';
const STALE_PAYLOAD_MAX_AGE_MS = 60 * 60 * 1000;
const WORKER_SPAWN_LOCK_TIMEOUT_MS = 1500;
const WORKER_SPAWN_LOCK_STALE_MS = 15000;

export function loadSyncState(cwd: string, sessionId: string, log: LogFn = noopLog): SyncState {
  const statePaths = [
    getSyncStateFile(cwd, sessionId),
    getLegacySyncStateFile(cwd, sessionId),
  ];

  for (const statePath of statePaths) {
    if (!fs.existsSync(statePath)) {
      continue;
    }
    try {
      const parsed = readJsonFileWithFallback<unknown>(statePath, {}, log);
      const state = parseSyncStateData(parsed, sessionId);
      if (state) {
        log(`Loaded state: lastProcessedIndex=${state.lastProcessedIndex}`);
        return state;
      }
      log(`State file ${path.basename(statePath)} was invalid, ignoring`);
    } catch (e) {
      log(`Failed to load state: ${e}`);
    }
  }

  log(`No existing state, starting fresh`);
  return { lastProcessedIndex: -1, sessionId };
}

export function saveSyncState(cwd: string, state: SyncState, log: LogFn = noopLog): void {
  ensureDurableStateDir(cwd);
  const statePath = getSyncStateFile(cwd, state.sessionId);
  withProcessLock(
    `${statePath}.lock`,
    () => {
      const existingState = parseSyncStateData(
        readJsonFileWithFallback<unknown>(statePath, null, log),
        state.sessionId,
      );

      const mergedState: SyncState = {
        lastProcessedIndex: state.lastProcessedIndex,
        sessionId: state.sessionId,
      };

      if (Object.prototype.hasOwnProperty.call(state, 'lastBlockValues')) {
        if (state.lastBlockValues) {
          mergedState.lastBlockValues = state.lastBlockValues;
        }
      } else if (existingState?.lastBlockValues) {
        mergedState.lastBlockValues = existingState.lastBlockValues;
      }

      if (Object.prototype.hasOwnProperty.call(state, 'lastSeenMessageId')) {
        if (state.lastSeenMessageId) {
          mergedState.lastSeenMessageId = state.lastSeenMessageId;
        }
      } else if (existingState?.lastSeenMessageId) {
        mergedState.lastSeenMessageId = existingState.lastSeenMessageId;
      }

      if (
        Object.prototype.hasOwnProperty.call(state, 'lastMirroredTranscriptLine')
      ) {
        if (typeof state.lastMirroredTranscriptLine === 'number') {
          mergedState.lastMirroredTranscriptLine =
            state.lastMirroredTranscriptLine;
        }
      } else if (
        typeof existingState?.lastMirroredTranscriptLine === 'number'
      ) {
        mergedState.lastMirroredTranscriptLine =
          existingState.lastMirroredTranscriptLine;
      }

      if (Object.prototype.hasOwnProperty.call(state, 'pendingToolUses')) {
        if (
          state.pendingToolUses &&
          Object.keys(state.pendingToolUses).length > 0
        ) {
          mergedState.pendingToolUses = state.pendingToolUses;
        }
      } else if (
        existingState?.pendingToolUses &&
        Object.keys(existingState.pendingToolUses).length > 0
      ) {
        mergedState.pendingToolUses = existingState.pendingToolUses;
      }

      writeJsonFileAtomic(statePath, mergedState, log);
    },
    {
      log,
      timeoutMs: 1500,
      staleMs: 15000,
    },
  );
  log(`Saved state: lastProcessedIndex=${state.lastProcessedIndex}`);
}

const DEFAULT_MEMORY_BLOCKS: MemoryBlock[] = [
  {
    label: 'core_directives',
    description:
      'Primary role, behavioral guidelines, and processing logic for observing Claude Code sessions.',
    value:
      'ROLE: The Subconscious — a persistent agent that whispers to Claude Code.\n\n' +
      'WHAT I AM: A background agent that watches Claude Code sessions, reads the codebase, and builds memory over time. I receive transcripts asynchronously and build long-term context.\n\n' +
      'Observe preferences, recurring patterns, project context, and pending work. Write concise, useful guidance when it will help.\n\n' +
      'VISIBILITY: My messages are rendered visibly to the user as blockquotes in Claude Code\'s responses. Write messages that are worth showing — one clear signal, not a log dump. The user will see exactly what I send.'
  },
  {
    label: 'guidance',
    description:
      'Active guidance for the next Claude Code session. Write here when you have something useful to surface.',
    value:
      '(No active guidance. Write here when there\'s something genuinely useful for the next session.)'
  },
  {
    label: 'pending_items',
    description:
      'Unfinished work, explicit TODOs, follow-up items mentioned across sessions. Clear items when resolved.',
    value:
      '(No pending items. Populated when sessions end mid-task or user mentions follow-ups.)'
  },
  {
    label: 'project_context',
    description:
      'Active project knowledge: what the codebase does, architecture decisions, known gotchas, key files.',
    value:
      '(No project context yet. Populated as sessions reveal codebase details.)'
  },
  {
    label: 'self_improvement',
    description:
      'Guidelines for evolving memory architecture and learning procedures.',
    value:
      'MEMORY LIMITS (CRITICAL):\n' +
      '- Keep memory focused and compact.\n' +
      '- Prefer updating existing blocks over creating new ones.\n' +
      '- Consolidate stale or duplicate content.\n\n' +
      'LEARNING PROCEDURES:\n' +
      '1. Scan for user corrections (preference signals).\n' +
      '2. Note repeated edits and struggle points.\n' +
      '3. Capture explicit preference statements.\n' +
      '4. Track recurring task/tool patterns.\n' +
      '5. Record unfinished work for continuity.'
  },
  {
    label: 'session_patterns',
    description:
      'Recurring behaviors, time-based patterns, common struggles. Used for pattern-based guidance.',
    value:
      '(No patterns observed yet. Populated after multiple sessions.)'
  },
  {
    label: 'tool_guidelines',
    description:
      'How to use available tools effectively. Reference when uncertain about tool capabilities.',
    value:
      'AVAILABLE TOOLS:\n' +
      '- memory_replace / memory_insert / memory_rethink for memory edits\n' +
      '- read_file for local file inspection (always available unless SDK tools are off)\n\n' +
      'SUBCONSCIOUS RULES:\n' +
      '- Do not ask the user questions directly.\n' +
      '- If clarification is needed, suggest what Claude Code should ask next.\n' +
      '- Treat tool signals like clarification_needed, assumption, risk, and boundary as private reasoning scaffolding.\n\n' +
      'USAGE PATTERNS:\n' +
      '- Use small edits for localized changes.\n' +
      '- Use rethink for major rewrites.\n' +
      '- Read code before inferring project context.'
  },
  {
    label: 'user_preferences',
    description:
      'Learned coding style, tool preferences, and communication style. Updated from corrections and explicit statements.',
    value:
      '(No user preferences yet. Populated as sessions reveal coding style, tool choices, and communication preferences.)'
  }
];

function loadSubconsciousTemplate(
  cwd: string,
  log: LogFn = noopLog,
): SubconsciousTemplate | null {
  const templatePath = path.join(cwd, SUBCONSCIOUS_AF_PATH);
  if (!fs.existsSync(templatePath)) {
    return null;
  }

  const stat = fs.statSync(templatePath);
  const cached = templateCache.get(templatePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.template;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(templatePath, 'utf-8')) as {
      agents?: Array<{ system?: string }>;
      blocks?: Array<{
        label?: unknown;
        description?: unknown;
        value?: unknown;
      }>;
    };

    const template: SubconsciousTemplate = {};
    const systemPrompt = parsed.agents?.[0]?.system;
    if (typeof systemPrompt === 'string' && systemPrompt.trim()) {
      template.systemPrompt = systemPrompt;
    }

    const blockCandidates = parsed.blocks || [];
    const memoryBlocks: MemoryBlock[] = [];
    const seenLabels = new Set<string>();
    for (const block of blockCandidates) {
      const label =
        typeof block.label === 'string' ? block.label.trim() : '';
      if (!label || seenLabels.has(label)) {
        continue;
      }
      seenLabels.add(label);
      memoryBlocks.push({
        label,
        description:
          typeof block.description === 'string'
            ? block.description
            : '',
        value: typeof block.value === 'string' ? block.value : '',
      });
    }

    if (memoryBlocks.length > 0) {
      template.memoryBlocks = memoryBlocks;
    }

    if (!template.systemPrompt && !template.memoryBlocks) {
      templateCache.set(templatePath, { mtimeMs: stat.mtimeMs, template: null });
      return null;
    }
    templateCache.set(templatePath, { mtimeMs: stat.mtimeMs, template });
    return template;
  } catch (error) {
    log(`Failed to parse ${SUBCONSCIOUS_AF_PATH}: ${error}`);
    templateCache.set(templatePath, { mtimeMs: stat.mtimeMs, template: null });
    return null;
  }
}

function normalizeMemoryBlocksToTemplate(
  existingBlocks: MemoryBlock[],
  templateBlocks: MemoryBlock[],
): { blocks: MemoryBlock[]; changed: boolean } {
  const existingByLabel = new Map(existingBlocks.map((b) => [b.label, b]));
  const normalized: MemoryBlock[] = templateBlocks.map((tmpl) => {
    const existing = existingByLabel.get(tmpl.label);
    if (!existing) {
      return { ...tmpl };
    }
    return {
      label: tmpl.label,
      description: existing.description || tmpl.description,
      value: existing.value ?? tmpl.value,
    };
  });

  const templateLabels = new Set(templateBlocks.map((b) => b.label));
  for (const block of existingBlocks) {
    if (!templateLabels.has(block.label)) {
      normalized.push(block);
    }
  }

  const changed =
    normalized.length !== existingBlocks.length ||
    normalized.some((block, idx) => {
      const existing = existingBlocks[idx];
      return (
        !existing ||
        existing.label !== block.label ||
        existing.description !== block.description ||
        existing.value !== block.value
      );
    });

  return { blocks: normalized, changed };
}

function getDefaultTemplateMemoryBlocks(
  cwd: string,
  log: LogFn = noopLog,
): MemoryBlock[] {
  const templateBlocks = loadSubconsciousTemplate(cwd, log)?.memoryBlocks;
  if (templateBlocks && templateBlocks.length > 0) {
    return templateBlocks;
  }
  return DEFAULT_MEMORY_BLOCKS;
}

export function getSubconsciousSystemPrompt(
  cwd: string,
  fallback: string,
  log: LogFn = noopLog,
): string {
  const fromTemplate = loadSubconsciousTemplate(cwd, log)?.systemPrompt;
  if (fromTemplate && fromTemplate.trim()) {
    return fromTemplate;
  }
  return fallback;
}

function readMemoryBlocksFromFile(
  memoryFile: string,
  templateMemoryBlocks: MemoryBlock[],
  log: LogFn,
): { blocks: MemoryBlock[]; needsWrite: boolean } {
  if (!fs.existsSync(memoryFile)) {
    return {
      blocks: cloneMemoryBlocks(templateMemoryBlocks),
      needsWrite: true,
    };
  }

  const rawData = readJsonFileWithFallback<unknown>(
    memoryFile,
    templateMemoryBlocks,
    log,
  );
  const existingBlocks = coerceMemoryBlocks(rawData);
  if (!existingBlocks) {
    log(`Memory file was invalid or empty, restoring defaults`);
    return {
      blocks: cloneMemoryBlocks(templateMemoryBlocks),
      needsWrite: true,
    };
  }

  const { blocks, changed } = normalizeMemoryBlocksToTemplate(
    existingBlocks,
    templateMemoryBlocks,
  );

  return {
    blocks,
    needsWrite: changed,
  };
}

export function loadLocalMemory(cwd: string, log: LogFn = noopLog): MemoryBlock[] {
  const templateMemoryBlocks = getDefaultTemplateMemoryBlocks(cwd, log);
  const memoryFile = getMemoryFile(cwd);

  try {
    const { blocks, needsWrite } = readMemoryBlocksFromFile(
      memoryFile,
      templateMemoryBlocks,
      log,
    );

    if (needsWrite) {
      ensureDurableStateDir(cwd);
      writeJsonFileAtomic(memoryFile, blocks, log);
      log(`Normalized memory blocks to ${SUBCONSCIOUS_AF_PATH} structure`);
    }

    log(`Loaded memory blocks from disk`);
    return blocks;
  } catch (e) {
    log(`Failed to load memory blocks: ${e}`);
  }

  log(`Initializing default memory blocks`);
  ensureDurableStateDir(cwd);
  writeJsonFileAtomic(memoryFile, templateMemoryBlocks, log);
  return cloneMemoryBlocks(templateMemoryBlocks);
}

export interface SaveLocalMemoryOptions {
  baseBlocks?: MemoryBlock[];
}

export function saveLocalMemory(
  cwd: string,
  blocks: MemoryBlock[],
  log: LogFn = noopLog,
  options: SaveLocalMemoryOptions = {},
): void {
  ensureDurableStateDir(cwd);
  const memoryFile = getMemoryFile(cwd);
  const templateMemoryBlocks = getDefaultTemplateMemoryBlocks(cwd, log);

  withProcessLock(
    `${memoryFile}.lock`,
    () => {
      const { blocks: currentBlocks } = readMemoryBlocksFromFile(
        memoryFile,
        templateMemoryBlocks,
        log,
      );
      const blocksToSave = options.baseBlocks
        ? mergeMemoryBlocks(currentBlocks, options.baseBlocks, blocks)
        : cloneMemoryBlocks(blocks);
      const { blocks: normalizedBlocks } = normalizeMemoryBlocksToTemplate(
        blocksToSave,
        templateMemoryBlocks,
      );

      writeJsonFileAtomic(memoryFile, normalizedBlocks, log);
      syncClaudeMdFromMemory(cwd, normalizedBlocks);
      log(
        options.baseBlocks
          ? 'Saved memory blocks to disk with merge-on-save'
          : 'Saved memory blocks to disk',
      );
    },
    {
      log,
    },
  );
}

// ============================================
// CLAUDE.md Formatting and Writing
// ============================================

export function syncClaudeMdFromMemory(
  cwd: string,
  blocks: MemoryBlock[],
): void {
  updateClaudeMd(cwd, formatDistilledClaudeMd(blocks));
}

export function formatAllBlocksForStdout(
  blocks: MemoryBlock[],
  cwd?: string,
): string {
  const sdkToolsMode = getSdkToolsMode(cwd);
  const capabilityLine = getStdoutSdkToolsCapabilityLine(sdkToolsMode);

  const header = `<subnotes_context>
Notes agent is active and observing this session.
${capabilityLine}
</subnotes_context>`;

  if (!blocks || blocks.length === 0) {
    return header;
  }

  const formattedBlocks = blocks.map(block => {
    const escapedDescription = escapeXmlAttribute(block.description || '');
    const escapedContent = escapeXmlContent(block.value || '');
    return `<${block.label} description="${escapedDescription}">\n${escapedContent}\n</${block.label}>`;
  }).join('\n');

  return `${header}\n\n<subnotes_memory_blocks>\n${formattedBlocks}\n</subnotes_memory_blocks>`;
}

// ============================================
// Silent Worker Spawning
// ============================================

// ============================================
// Transcript Streaming (for continuous agent)
// ============================================

export interface TranscriptEntry {
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Get the continuous transcript file path
 */
export function getContinuousTranscriptPath(cwd: string, sessionId: string): string {
  const namespace = getRepoNamespace(cwd);
  return path.join(getDurableStateDir(cwd), `transcript-${namespace}-${sessionId}.jsonl`);
}

export function getContinuousWorkerPidFile(sessionId: string, cwd: string): string {
  const namespace = getRepoNamespace(cwd);
  return path.join(getTempStateDir(), `continuous-worker-${namespace}-${sessionId}.pid`);
}

function getContinuousWorkerSpawnLockFile(sessionId: string, cwd: string): string {
  const namespace = getRepoNamespace(cwd);
  return path.join(
    getTempStateDir(),
    `continuous-worker-${namespace}-${sessionId}${CONTINUOUS_WORKER_SPAWN_LOCK_SUFFIX}`,
  );
}

function getLegacyContinuousWorkerPidFile(sessionId: string): string {
  return path.join(getTempStateDir(), `continuous-worker-${sessionId}.pid`);
}

function removePidFile(pidFile: string, log: LogFn): void {
  try {
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
      log(`Removed stale PID file: ${pidFile}`);
    }
  } catch (error) {
    log(`Failed to remove stale PID file ${pidFile}: ${error}`);
  }
}

function removePidFileIfMatches(
  pidFile: string,
  expectedPid: number,
  log: LogFn = noopLog,
): void {
  if (!fs.existsSync(pidFile)) {
    return;
  }

  const currentPid = readPidFromFile(
    pidFile,
    (error) => log(`Failed to read PID file ${pidFile}: ${error}`),
  );
  if (currentPid === null) {
    removePidFile(pidFile, log);
    return;
  }

  if (currentPid !== expectedPid) {
    log(
      `Skipping PID cleanup for ${pidFile}; ownership moved from ${expectedPid} to ${currentPid}`,
    );
    return;
  }

  removePidFile(pidFile, log);
}

function cleanupStaleFileIfOlderThan(
  filePath: string,
  maxAgeMs: number,
  log: LogFn = noopLog,
): void {
  try {
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs < maxAgeMs) {
      return;
    }
    fs.unlinkSync(filePath);
    log(`Removed stale artifact: ${filePath}`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      log(`Failed to remove stale artifact ${filePath}: ${error}`);
    }
  }
}

export function cleanupStaleContinuousWorkerArtifacts(
  log: LogFn = noopLog,
): void {
  const tempDir = getTempStateDir();
  if (!fs.existsSync(tempDir)) {
    return;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(tempDir);
  } catch (error) {
    log(`Failed to scan temp state dir ${tempDir}: ${error}`);
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(tempDir, entry);

    if (
      entry.startsWith(CONTINUOUS_WORKER_PID_PREFIX) &&
      entry.endsWith(CONTINUOUS_WORKER_PID_SUFFIX)
    ) {
      const pid = readPidFromFile(
        fullPath,
        (error) => log(`Failed to read PID file ${fullPath}: ${error}`),
      );
      if (pid === null || !isProcessRunning(pid)) {
        removePidFile(fullPath, log);
      }
      continue;
    }

    if (
      entry.startsWith(CONTINUOUS_PAYLOAD_PREFIX) &&
      entry.endsWith(CONTINUOUS_PAYLOAD_SUFFIX)
    ) {
      cleanupStaleFileIfOlderThan(fullPath, STALE_PAYLOAD_MAX_AGE_MS, log);
      continue;
    }

    if (
      entry.startsWith(LOCAL_PAYLOAD_PREFIX) &&
      entry.endsWith(LOCAL_PAYLOAD_SUFFIX)
    ) {
      cleanupStaleFileIfOlderThan(fullPath, STALE_PAYLOAD_MAX_AGE_MS, log);
    }
  }
}

/**
 * Removes stale PID files for the given session and returns a running PID if found.
 */
export function cleanupStaleContinuousWorkerPidFiles(
  sessionId: string,
  cwd: string,
  log: LogFn = noopLog,
): number | null {
  const pidFiles = [
    getContinuousWorkerPidFile(sessionId, cwd),
    getLegacyContinuousWorkerPidFile(sessionId),
  ];

  for (const pidFile of pidFiles) {
    if (!fs.existsSync(pidFile)) {
      continue;
    }

    const pid = readPidFromFile(
      pidFile,
      (error) => log(`Failed to read PID file ${pidFile}: ${error}`),
    );
    if (pid === null) {
      log(`Invalid PID in ${pidFile}, cleaning up`);
      removePidFile(pidFile, log);
      continue;
    }

    if (isProcessRunning(pid)) {
      return pid;
    }

    removePidFile(pidFile, log);
  }

  return null;
}

/**
 * Append a transcript entry to the continuous transcript file
 * Used by hooks to stream conversation data to the continuous agent
 */
export function appendTranscriptEntry(
  cwd: string,
  sessionId: string,
  entry: TranscriptEntry
): void {
  ensureDurableStateDir(cwd);
  const transcriptPath = getContinuousTranscriptPath(cwd, sessionId);
  const jsonLine = JSON.stringify(entry) + '\n';

  try {
    fs.appendFileSync(transcriptPath, jsonLine, 'utf-8');
  } catch (error) {
    // Fail silently - don't break hooks if transcript streaming fails
    console.error(`Failed to append transcript entry: ${error}`);
  }
}

/**
 * Mirror Claude Code's official transcript into the plugin's internal
 * session transcript so the worker can observe full user/assistant/tool flow.
 */
export function mirrorClaudeTranscript(
  cwd: string,
  sessionId: string,
  transcriptPath: string,
  log: LogFn = noopLog,
): number {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return 0;
  }

  const stateLock = `${getSyncStateFile(cwd, sessionId)}.mirror.lock`;

  return withProcessLock(
    stateLock,
    () => {
      const sourceContent = fs.readFileSync(transcriptPath, 'utf-8').trim();
      if (!sourceContent) {
        return 0;
      }

      const lines = sourceContent.split('\n');
      const state = loadSyncState(cwd, sessionId, log);
      const previousLineIndex = state.lastMirroredTranscriptLine ?? -1;

      if (previousLineIndex >= lines.length) {
        state.lastMirroredTranscriptLine = -1;
        state.pendingToolUses = {};
      }

      const pendingToolUses = { ...(state.pendingToolUses || {}) };
      const { entries, latestLineIndex } = parseClaudeTranscriptEntries(
        lines,
        state.lastMirroredTranscriptLine ?? -1,
        pendingToolUses,
        new Date().toISOString(),
        log,
      );

      if (entries.length > 0) {
        ensureDurableStateDir(cwd);
        const destinationPath = getContinuousTranscriptPath(cwd, sessionId);
        const payload = entries
          .map((entry) => JSON.stringify(entry))
          .join('\n');
        fs.appendFileSync(destinationPath, `${payload}\n`, 'utf-8');
      }

      state.lastMirroredTranscriptLine =
        latestLineIndex >= 0 ? latestLineIndex : previousLineIndex;
      state.pendingToolUses =
        Object.keys(pendingToolUses).length > 0 ? pendingToolUses : undefined;
      saveSyncState(cwd, state, log);

      return entries.length;
    },
    {
      log,
      timeoutMs: 1500,
      staleMs: 15000,
    },
  );
}

/**
 * Check if continuous agent is running for a session
 */
export function isContinuousAgentRunning(sessionId: string, cwd: string): boolean {
  return cleanupStaleContinuousWorkerPidFiles(sessionId, cwd) !== null;
}

/**
 * Spawn continuous worker if not already running
 */
export function ensureContinuousWorker(
  sessionId: string,
  cwd: string,
  sdkToolsMode: 'read-only' | 'full' | 'off',
  log: LogFn = noopLog,
): ChildProcess | null {
  cleanupStaleContinuousWorkerArtifacts(log);

  return withProcessLock(
    getContinuousWorkerSpawnLockFile(sessionId, cwd),
    () => {
      cleanupStaleContinuousWorkerPidFiles(sessionId, cwd, log);

      if (isContinuousAgentRunning(sessionId, cwd)) {
        log(`Continuous worker already running for session ${sessionId}`);
        return null;
      }

      const payload = {
        sessionId,
        cwd,
        sdkToolsMode,
      };

      const tempDir = getTempStateDir();
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const namespace = getRepoNamespace(cwd);
      const payloadFile = path.join(
        tempDir,
        `continuous-payload-${namespace}-${sessionId}.json`,
      );
      writeJsonFileAtomic(payloadFile, payload, log);
      log(`Wrote worker payload: ${payloadFile}`);

      const workerScript = path.join(__dirname, 'send_worker_continuous.ts');
      return spawnSilentWorker(workerScript, payloadFile, cwd);
    },
    {
      log,
      timeoutMs: WORKER_SPAWN_LOCK_TIMEOUT_MS,
      staleMs: WORKER_SPAWN_LOCK_STALE_MS,
    },
  );
}
