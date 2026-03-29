/**
 * Shared conversation and state management utilities
 * Used by hook scripts and background workers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import {
  readJsonFileWithFallback,
  writeJsonFileAtomic,
  withProcessLock,
} from './state_store.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLAUDE.md constants
export const ROOT_CLAUDE_MD_PATH = 'CLAUDE.md';
export const CLAUDE_MD_PATH = '.claude/CLAUDE.md';
export const SUBNOTES_SECTION_START = '<subnotes>';
export const SUBNOTES_SECTION_END = '</subnotes>';
const SUBNOTES_CONTEXT_START = '<subnotes_context>';
const SUBNOTES_CONTEXT_END = '</subnotes_context>';
const SUBNOTES_MEMORY_START = '<subnotes_memory_blocks>';
const SUBNOTES_MEMORY_END = '</subnotes_memory_blocks>';
const DISTILLED_CLAUDE_MD_COMMENT =
  '<!-- SubNotes distilled context is automatically synced below -->';
const DISTILLED_CLAUDE_MD_MAX_CHARS = 5000;
const DISTILLED_CLAUDE_MD_MIN_SECTION_BUDGET = 160;
const DISTILLED_CLAUDE_MD_TRUNCATION_NOTICE =
  '[Truncated in CLAUDE.md. Full canonical state lives in .subnotes.]';
const DISTILLED_CLAUDE_MD_OMISSION_NOTICE =
  '[Additional subconscious state omitted here to protect CLAUDE.md context budget. Canonical state lives in .subnotes.]';

// ============================================
// Configuration — all settings live in config.json
// ============================================

/**
 * Complete configuration for Claude Reflect.
 * All values are stored in `.subnotes/config.json`.
 * No settings come from environment variables.
 */
export interface ReflectConfig {
  // Core
  mode: SubNotesMode;
  sdkToolsMode: SdkToolsMode;
  architecture: 'continuous' | 'oneshot';
  autonomic: boolean;
  debug: boolean;

  // Worker tuning
  checkIntervalMs: number;
  minMessages: number;
  idleTimeoutMs: number;
  maxContinuations: number;

  // Autonomic tuning
  crystallizeInterval: number;
  minObservations: number;

  // API keys
  anthropicApiKey: string;
  anthropicModel: string;
  exaApiKey: string;

  // Project overrides
  projectDir: string | null;

  // Sentinel tuning
  sentinelThrashingThreshold: number;
  sentinelThrashingWindowMs: number;
  sentinelTestLoopThreshold: number;
  sentinelErrorCascadeThreshold: number;
  sentinelErrorCascadeWindowMs: number;
  sentinelOverwriteWindowMs: number;

  // Crystallizer tuning
  crystallizerMinClusterSize: number;
  crystallizerClusterWindowMs: number;
  crystallizerInitialConfidence: number;
  crystallizerConfidenceBump: number;
  crystallizerMaxConfidence: number;
  crystallizerModel: string;

  // Tuner sensitivity
  tunerIgnoreRateThreshold: number;
  tunerRetryRateThreshold: number;
  tunerOverrideRateThreshold: number;
  tunerOutcomeLookahead: number;
  tunerMaxUnresolvedAgeMs: number;
}

export type SubNotesMode = 'whisper' | 'full' | 'off';

const DEFAULT_CONFIG: ReflectConfig = {
  mode: 'whisper',
  sdkToolsMode: 'read-only',
  architecture: 'continuous',
  autonomic: true,
  debug: false,
  checkIntervalMs: 1000,
  minMessages: 1,
  idleTimeoutMs: 1800000,
  maxContinuations: 2,
  crystallizeInterval: 10,
  minObservations: 5,
  anthropicApiKey: '',
  anthropicModel: 'claude-sonnet-4-6',
  exaApiKey: '',
  projectDir: null,
  // Sentinel defaults
  sentinelThrashingThreshold: 5,
  sentinelThrashingWindowMs: 10 * 60 * 1000,
  sentinelTestLoopThreshold: 3,
  sentinelErrorCascadeThreshold: 3,
  sentinelErrorCascadeWindowMs: 5 * 60 * 1000,
  sentinelOverwriteWindowMs: 60 * 1000,
  // Crystallizer defaults
  crystallizerMinClusterSize: 3,
  crystallizerClusterWindowMs: 15 * 60 * 1000,
  crystallizerInitialConfidence: 0.25,
  crystallizerConfidenceBump: 0.05,
  crystallizerMaxConfidence: 0.7,
  crystallizerModel: 'claude-haiku-3-5-20250815',
  // Tuner sensitivity defaults
  tunerIgnoreRateThreshold: 0.4,
  tunerRetryRateThreshold: 0.2,
  tunerOverrideRateThreshold: 0.1,
  tunerOutcomeLookahead: 10,
  tunerMaxUnresolvedAgeMs: 30 * 60 * 1000,
};

/** Per-process config cache — loaded once per cwd */
let _configCache: ReflectConfig | null = null;
let _configCacheDir: string | null = null;

/**
 * Load configuration from `.subnotes/config.json`.
 * Cached per-process for the lifetime of the script.
 * Falls back to defaults for any missing keys.
 */
export function loadConfig(cwd: string): ReflectConfig {
  if (_configCache && _configCacheDir === cwd) {
    return _configCache;
  }

  const configPath = path.join(getDurableStateDir(cwd), 'config.json');
  let fileData: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      fileData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // Corrupted config — use all defaults
      fileData = {};
    }
  }

  const config: ReflectConfig = {
    mode: parseMode(fileData.mode),
    sdkToolsMode: parseSdkTools(fileData.sdkToolsMode),
    architecture: fileData.architecture === 'oneshot' ? 'oneshot' : 'continuous',
    autonomic: fileData.autonomic !== false,
    debug: fileData.debug === true,
    checkIntervalMs: parsePositiveInt(fileData.checkIntervalMs, DEFAULT_CONFIG.checkIntervalMs),
    minMessages: parsePositiveInt(fileData.minMessages, DEFAULT_CONFIG.minMessages),
    idleTimeoutMs: parsePositiveInt(fileData.idleTimeoutMs, DEFAULT_CONFIG.idleTimeoutMs),
    maxContinuations: parsePositiveInt(fileData.maxContinuations, DEFAULT_CONFIG.maxContinuations),
    crystallizeInterval: parsePositiveInt(fileData.crystallizeInterval, DEFAULT_CONFIG.crystallizeInterval),
    minObservations: parsePositiveInt(fileData.minObservations, DEFAULT_CONFIG.minObservations),
    anthropicApiKey: typeof fileData.anthropicApiKey === 'string' && fileData.anthropicApiKey
      ? fileData.anthropicApiKey
      : (process.env.ANTHROPIC_API_KEY || DEFAULT_CONFIG.anthropicApiKey),
    anthropicModel: typeof fileData.anthropicModel === 'string' && fileData.anthropicModel ? fileData.anthropicModel : DEFAULT_CONFIG.anthropicModel,
    exaApiKey: typeof fileData.exaApiKey === 'string' && fileData.exaApiKey
      ? fileData.exaApiKey
      : (process.env.EXA_API_KEY || DEFAULT_CONFIG.exaApiKey),
    projectDir: typeof fileData.projectDir === 'string' && fileData.projectDir ? fileData.projectDir : null,
    // Sentinel
    sentinelThrashingThreshold: parsePositiveInt(fileData.sentinelThrashingThreshold, DEFAULT_CONFIG.sentinelThrashingThreshold),
    sentinelThrashingWindowMs: parsePositiveInt(fileData.sentinelThrashingWindowMs, DEFAULT_CONFIG.sentinelThrashingWindowMs),
    sentinelTestLoopThreshold: parsePositiveInt(fileData.sentinelTestLoopThreshold, DEFAULT_CONFIG.sentinelTestLoopThreshold),
    sentinelErrorCascadeThreshold: parsePositiveInt(fileData.sentinelErrorCascadeThreshold, DEFAULT_CONFIG.sentinelErrorCascadeThreshold),
    sentinelErrorCascadeWindowMs: parsePositiveInt(fileData.sentinelErrorCascadeWindowMs, DEFAULT_CONFIG.sentinelErrorCascadeWindowMs),
    sentinelOverwriteWindowMs: parsePositiveInt(fileData.sentinelOverwriteWindowMs, DEFAULT_CONFIG.sentinelOverwriteWindowMs),
    // Crystallizer
    crystallizerMinClusterSize: parsePositiveInt(fileData.crystallizerMinClusterSize, DEFAULT_CONFIG.crystallizerMinClusterSize),
    crystallizerClusterWindowMs: parsePositiveInt(fileData.crystallizerClusterWindowMs, DEFAULT_CONFIG.crystallizerClusterWindowMs),
    crystallizerInitialConfidence: parsePositiveFloat(fileData.crystallizerInitialConfidence, DEFAULT_CONFIG.crystallizerInitialConfidence),
    crystallizerConfidenceBump: parsePositiveFloat(fileData.crystallizerConfidenceBump, DEFAULT_CONFIG.crystallizerConfidenceBump),
    crystallizerMaxConfidence: parsePositiveFloat(fileData.crystallizerMaxConfidence, DEFAULT_CONFIG.crystallizerMaxConfidence),
    crystallizerModel: typeof fileData.crystallizerModel === 'string' && fileData.crystallizerModel ? fileData.crystallizerModel : DEFAULT_CONFIG.crystallizerModel,
    // Tuner
    tunerIgnoreRateThreshold: parsePositiveFloat(fileData.tunerIgnoreRateThreshold, DEFAULT_CONFIG.tunerIgnoreRateThreshold),
    tunerRetryRateThreshold: parsePositiveFloat(fileData.tunerRetryRateThreshold, DEFAULT_CONFIG.tunerRetryRateThreshold),
    tunerOverrideRateThreshold: parsePositiveFloat(fileData.tunerOverrideRateThreshold, DEFAULT_CONFIG.tunerOverrideRateThreshold),
    tunerOutcomeLookahead: parsePositiveInt(fileData.tunerOutcomeLookahead, DEFAULT_CONFIG.tunerOutcomeLookahead),
    tunerMaxUnresolvedAgeMs: parsePositiveInt(fileData.tunerMaxUnresolvedAgeMs, DEFAULT_CONFIG.tunerMaxUnresolvedAgeMs),
  };

  _configCache = config;
  _configCacheDir = cwd;
  return config;
}

function parseMode(value: unknown): SubNotesMode {
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (v === 'full' || v === 'off') return v;
  }
  return 'whisper';
}

function parseSdkTools(value: unknown): SdkToolsMode {
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (v === 'full' || v === 'off') return v as SdkToolsMode;
  }
  return 'read-only';
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return fallback;
}

function parsePositiveFloat(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

/** Invalidate config cache (useful after writing config). */
export function invalidateConfigCache(): void {
  _configCache = null;
  _configCacheDir = null;
}

/**
 * Get the current operating mode.
 */
export function getMode(cwd?: string): SubNotesMode {
  if (cwd) return loadConfig(cwd).mode;
  // Fallback for callers that don't have cwd — check cache first
  if (_configCache) return _configCache.mode;
  return 'whisper';
}

/**
 * Ensure config.json exists with all default values.
 * Creates the file if it doesn't exist.
 * Merges any missing keys into an existing config (non-destructive).
 */
export function ensureConfigFile(cwd: string, log: LogFn = noopLog): void {
  const configPath = path.join(getDurableStateDir(cwd), 'config.json');
  ensureDurableStateDir(cwd);

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      existing = {};
    }
  }

  // Merge defaults for any missing keys
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG, ...existing };
  // Remove null projectDir from output if not set
  if (merged.projectDir === null) {
    delete merged.projectDir;
  }
  // Remove empty API keys from output to keep the file clean
  if (!merged.anthropicApiKey) delete merged.anthropicApiKey;
  if (!merged.exaApiKey) delete merged.exaApiKey;

  writeJsonFileAtomic(configPath, merged, log);
  invalidateConfigCache();
  log(`Config file ensured at ${configPath}`);
}

/**
 * Get user-specific temp state directory.
 */
export function getTempStateDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
  return path.join(os.tmpdir(), `subnotes-sync-${uid}`);
}

// ============================================
// SDK Tools Configuration
// ============================================

export type SdkToolsMode = 'read-only' | 'full' | 'off';

export const SDK_TOOLS_READ_ONLY = ['Read', 'Grep', 'Glob', 'web_search', 'fetch_webpage'];
export const SDK_TOOLS_BLOCKED = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

export function getSdkToolsMode(cwd?: string): SdkToolsMode {
  if (cwd) return loadConfig(cwd).sdkToolsMode;
  if (_configCache) return _configCache.sdkToolsMode;
  return 'read-only';
}

// ============================================
// Autonomic Mode
// ============================================

/**
 * Check if the autonomic subconscious is enabled.
 * Controlled by `autonomic` field in config.json (default: true).
 */
export function isAutonomicEnabled(cwd?: string): boolean {
  if (cwd) return loadConfig(cwd).autonomic;
  if (_configCache) return _configCache.autonomic;
  return true;
}

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

function cloneMemoryBlock(block: MemoryBlock): MemoryBlock {
  return {
    label: block.label,
    description: block.description,
    value: block.value,
  };
}

function cloneMemoryBlocks(blocks: MemoryBlock[]): MemoryBlock[] {
  return blocks.map(cloneMemoryBlock);
}

function isMemoryBlock(value: unknown): value is MemoryBlock {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<MemoryBlock>;
  return (
    typeof candidate.label === 'string' &&
    typeof candidate.description === 'string' &&
    typeof candidate.value === 'string'
  );
}

function coerceMemoryBlocks(data: unknown): MemoryBlock[] | null {
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const blocks = data.filter(isMemoryBlock).map(cloneMemoryBlock);
  return blocks.length > 0 ? blocks : null;
}

function parseSyncStateData(
  data: unknown,
  fallbackSessionId: string,
): SyncState | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const candidate = data as Partial<SyncState>;
  if (typeof candidate.lastProcessedIndex !== 'number') {
    return null;
  }

  const parsed: SyncState = {
    lastProcessedIndex: candidate.lastProcessedIndex,
    sessionId:
      typeof candidate.sessionId === 'string' && candidate.sessionId.trim()
        ? candidate.sessionId
        : fallbackSessionId,
  };

  if (
    candidate.lastBlockValues &&
    typeof candidate.lastBlockValues === 'object'
  ) {
    const entries = Object.entries(candidate.lastBlockValues).filter(
      ([label, value]) => typeof label === 'string' && typeof value === 'string',
    );
    if (entries.length > 0) {
      parsed.lastBlockValues = Object.fromEntries(entries);
    }
  }

  if (
    typeof candidate.lastSeenMessageId === 'string' &&
    candidate.lastSeenMessageId.trim()
  ) {
    parsed.lastSeenMessageId = candidate.lastSeenMessageId;
  }

  if (typeof candidate.lastMirroredTranscriptLine === 'number') {
    parsed.lastMirroredTranscriptLine = candidate.lastMirroredTranscriptLine;
  }

  if (
    candidate.pendingToolUses &&
    typeof candidate.pendingToolUses === 'object'
  ) {
    const pendingEntries = Object.entries(candidate.pendingToolUses)
      .filter(([toolUseId, value]) => {
        if (!toolUseId || !value || typeof value !== 'object') {
          return false;
        }
        const candidateValue = value as {
          name?: unknown;
          input?: unknown;
          timestamp?: unknown;
        };
        return (
          typeof candidateValue.name === 'string' &&
          typeof candidateValue.timestamp === 'string'
        );
      })
      .map(([toolUseId, value]) => {
        const candidateValue = value as {
          name: string;
          input?: unknown;
          timestamp: string;
        };
        return [
          toolUseId,
          {
            name: candidateValue.name,
            input: candidateValue.input,
            timestamp: candidateValue.timestamp,
          },
        ] as const;
      });

    if (pendingEntries.length > 0) {
      parsed.pendingToolUses = Object.fromEntries(pendingEntries);
    }
  }

  return parsed;
}

function getCanonicalRepoPath(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    const realPath = fs.realpathSync.native
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
    return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

export function getRepoNamespace(cwd: string): string {
  const canonicalRepoPath = getCanonicalRepoPath(cwd);
  return createHash('sha1').update(canonicalRepoPath).digest('hex').slice(0, 12);
}

function getLegacySharedStateDir(cwd: string): string {
  // SUBNOTES_HOME is the only value that stays as an env var —
  // it determines where the config file itself lives.
  const sharedHome = process.env.SUBNOTES_HOME;
  const base = sharedHome || cwd;
  return path.join(base, '.subnotes');
}

export function getDurableStateDir(cwd: string): string {
  // SUBNOTES_HOME is the only value read from env —
  // it determines the root location of all state including config.json.
  const sharedHome = process.env.SUBNOTES_HOME;
  if (!sharedHome) {
    return path.join(cwd, '.subnotes');
  }

  const namespace = getRepoNamespace(cwd);
  return path.join(sharedHome, '.subnotes', namespace);
}

export function getSyncStateFile(cwd: string, sessionId: string): string {
  const namespace = getRepoNamespace(cwd);
  return path.join(getDurableStateDir(cwd), `session-${namespace}-${sessionId}.json`);
}

function getLegacySyncStateFile(cwd: string, sessionId: string): string {
  return path.join(getLegacySharedStateDir(cwd), `session-${sessionId}.json`);
}

export function getMemoryFile(cwd: string): string {
  return path.join(getDurableStateDir(cwd), 'memory.json');
}

export function ensureDurableStateDir(cwd: string): void {
  const dir = getDurableStateDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

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

function diffMemoryBlocks(
  baseBlocks: MemoryBlock[],
  updatedBlocks: MemoryBlock[],
): { touchedLabels: Set<string>; deletedLabels: Set<string> } {
  const baseByLabel = new Map(baseBlocks.map((block) => [block.label, block]));
  const updatedByLabel = new Map(
    updatedBlocks.map((block) => [block.label, block]),
  );
  const touchedLabels = new Set<string>();
  const deletedLabels = new Set<string>();
  const labels = new Set([
    ...baseByLabel.keys(),
    ...updatedByLabel.keys(),
  ]);

  for (const label of labels) {
    const before = baseByLabel.get(label);
    const after = updatedByLabel.get(label);

    if (!before && after) {
      touchedLabels.add(label);
      continue;
    }

    if (before && !after) {
      deletedLabels.add(label);
      continue;
    }

    if (
      before &&
      after &&
      (before.description !== after.description || before.value !== after.value)
    ) {
      touchedLabels.add(label);
    }
  }

  return { touchedLabels, deletedLabels };
}

function mergeMemoryBlocks(
  currentBlocks: MemoryBlock[],
  baseBlocks: MemoryBlock[],
  updatedBlocks: MemoryBlock[],
): MemoryBlock[] {
  const { touchedLabels, deletedLabels } = diffMemoryBlocks(
    baseBlocks,
    updatedBlocks,
  );

  if (touchedLabels.size === 0 && deletedLabels.size === 0) {
    return cloneMemoryBlocks(currentBlocks);
  }

  const updatedByLabel = new Map(
    updatedBlocks.map((block) => [block.label, cloneMemoryBlock(block)]),
  );
  const merged: MemoryBlock[] = [];
  const seenLabels = new Set<string>();

  for (const block of currentBlocks) {
    if (deletedLabels.has(block.label)) {
      continue;
    }

    if (touchedLabels.has(block.label)) {
      const replacement = updatedByLabel.get(block.label);
      if (replacement) {
        merged.push(replacement);
        seenLabels.add(block.label);
      }
      continue;
    }

    merged.push(cloneMemoryBlock(block));
    seenLabels.add(block.label);
  }

  for (const block of updatedBlocks) {
    if (!touchedLabels.has(block.label) || seenLabels.has(block.label)) {
      continue;
    }
    merged.push(cloneMemoryBlock(block));
    seenLabels.add(block.label);
  }

  return merged;
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
// XML Escaping Utilities
// ============================================

export function escapeXmlAttribute(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, ' ');
}

export function escapeXmlContent(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================
// CLAUDE.md Formatting and Writing
// ============================================

function formatContextSection(): string {
  return `${SUBNOTES_CONTEXT_START}
**Notes**

This is your persistent notes layer. It observes conversations asynchronously, updates memory blocks, and surfaces thoughts via <subnotes_message>. You can address it directly — it sees everything and may respond on the next sync.

Memory blocks below are the agent's long-term storage. Reference as needed.
${SUBNOTES_CONTEXT_END}`;
}

function isPlaceholderMemoryValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  return /^\(No [^)]+\)$/.test(trimmed);
}

function trimDistilledSectionContent(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (maxChars <= 0) {
    return '';
  }

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  const notice = `\n\n${DISTILLED_CLAUDE_MD_TRUNCATION_NOTICE}`;
  if (maxChars <= notice.length + 40) {
    return trimmed.slice(0, maxChars).trimEnd();
  }

  const availableChars = Math.max(0, maxChars - notice.length);
  return `${trimmed.slice(0, availableChars).trimEnd()}${notice}`;
}

interface DistilledClaudeSectionConfig {
  label: string;
  title: string;
  maxChars: number;
  fallback?: string;
}

interface ClaudeMdTargetResolution {
  baseDir: string;
  canonicalPath: string;
  canonicalExisted: boolean;
  alternatePath: string | null;
}

const DISTILLED_CLAUDE_SECTIONS: DistilledClaudeSectionConfig[] = [
  {
    label: 'guidance',
    title: 'Active Guidance',
    maxChars: 1200,
    fallback: 'No active guidance right now.',
  },
  {
    label: 'pending_items',
    title: 'Pending Items',
    maxChars: 1200,
  },
  {
    label: 'project_context',
    title: 'Project Context',
    maxChars: 1800,
  },
  {
    label: 'user_preferences',
    title: 'User Preferences',
    maxChars: 1200,
  },
  {
    label: 'session_patterns',
    title: 'Relevant Patterns',
    maxChars: 1200,
  },
];

function hasMeaningfulDistilledValue(
  blockMap: Map<string, MemoryBlock>,
  sectionConfig: DistilledClaudeSectionConfig,
): boolean {
  const block = blockMap.get(sectionConfig.label);
  if (!block) {
    return Boolean(sectionConfig.fallback);
  }

  return !isPlaceholderMemoryValue(block.value);
}

function renderDistilledSection(
  sectionConfig: DistilledClaudeSectionConfig,
  block: MemoryBlock | undefined,
  remainingBudget: number,
): string {
  const sectionHeader = `## ${sectionConfig.title}\n`;
  const availableBodyBudget = remainingBudget - sectionHeader.length;
  if (availableBodyBudget <= 0) {
    return '';
  }

  const rawValue = block?.value || '';
  let sectionBody = '';

  if (!block || isPlaceholderMemoryValue(rawValue)) {
    if (!sectionConfig.fallback) {
      return '';
    }
    sectionBody = trimDistilledSectionContent(
      sectionConfig.fallback,
      availableBodyBudget,
    );
  } else {
    sectionBody = trimDistilledSectionContent(
      rawValue,
      Math.min(sectionConfig.maxChars, availableBodyBudget),
    );
  }

  if (!sectionBody.trim()) {
    return '';
  }

  return `${sectionHeader}${sectionBody}`;
}

export function formatMemoryBlocksAsXml(blocks: MemoryBlock[]): string {
  const contextSection = formatContextSection();

  if (!blocks || blocks.length === 0) {
    return `${SUBNOTES_SECTION_START}
${contextSection}

${SUBNOTES_MEMORY_START}
<!-- No memory blocks found -->
${SUBNOTES_MEMORY_END}
${SUBNOTES_SECTION_END}`;
  }

  const formattedBlocks = blocks.map(block => {
    const escapedDescription = escapeXmlAttribute(block.description || '');
    const escapedContent = escapeXmlContent(block.value || '');
    return `<${block.label} description="${escapedDescription}">\n${escapedContent}\n</${block.label}>`;
  }).join('\n');

  return `${SUBNOTES_SECTION_START}
${contextSection}

${SUBNOTES_MEMORY_START}
${formattedBlocks}
${SUBNOTES_MEMORY_END}
${SUBNOTES_SECTION_END}`;
}

export function formatDistilledClaudeMd(blocks: MemoryBlock[]): string {
  const blockMap = new Map(blocks.map((block) => [block.label, block]));
  const contextSection =
    `${SUBNOTES_CONTEXT_START}\n` +
    `This section is auto-generated from \`.subnotes\` and is a distilled foreground view for Claude.\n` +
    `Canonical memory, transcripts, rules, and history live under \`.subnotes\`.\n` +
    `Do not treat this section as the source of truth.\n` +
    `${SUBNOTES_CONTEXT_END}`;
  const prefix = `${SUBNOTES_SECTION_START}\n${contextSection}\n\n`;
  const suffix = `\n${SUBNOTES_SECTION_END}`;
  let remainingBudget =
    DISTILLED_CLAUDE_MD_MAX_CHARS - prefix.length - suffix.length;
  const renderedSections: string[] = [];
  let omittedDueToBudget = false;

  for (const sectionConfig of DISTILLED_CLAUDE_SECTIONS) {
    if (!hasMeaningfulDistilledValue(blockMap, sectionConfig)) {
      continue;
    }

    const separatorLength = renderedSections.length > 0 ? 2 : 0;
    const sectionBudget = remainingBudget - separatorLength;
    if (sectionBudget < DISTILLED_CLAUDE_MD_MIN_SECTION_BUDGET) {
      omittedDueToBudget = true;
      continue;
    }

    const renderedSection = renderDistilledSection(
      sectionConfig,
      blockMap.get(sectionConfig.label),
      sectionBudget,
    );
    if (!renderedSection) {
      omittedDueToBudget = true;
      continue;
    }

    renderedSections.push(renderedSection);
    remainingBudget -= renderedSection.length + separatorLength;
  }

  if (renderedSections.length === 0) {
    const fallbackSection = renderDistilledSection(
      DISTILLED_CLAUDE_SECTIONS[0],
      blockMap.get(DISTILLED_CLAUDE_SECTIONS[0].label),
      remainingBudget,
    );
    if (fallbackSection) {
      renderedSections.push(fallbackSection);
      remainingBudget -= fallbackSection.length;
    }
  }

  if (
    omittedDueToBudget &&
    remainingBudget > DISTILLED_CLAUDE_MD_MIN_SECTION_BUDGET
  ) {
    const omissionSection = renderDistilledSection(
      {
        label: '__budget_notice__',
        title: 'Additional Context',
        maxChars: DISTILLED_CLAUDE_MD_OMISSION_NOTICE.length,
        fallback: DISTILLED_CLAUDE_MD_OMISSION_NOTICE,
      },
      undefined,
      remainingBudget - (renderedSections.length > 0 ? 2 : 0),
    );

    if (omissionSection) {
      renderedSections.push(omissionSection);
      remainingBudget -= omissionSection.length + (renderedSections.length > 1 ? 2 : 0);
    }
  }

  const distilledBody =
    renderedSections.length > 0
      ? renderedSections.join('\n\n')
      : '## Active Guidance\nNo distilled subconscious context yet.';

  return `${prefix}${distilledBody}${suffix}`;
}

function resolveClaudeMdBaseDir(projectDir: string): string {
  const config = loadConfig(projectDir);
  return config.projectDir || projectDir;
}

function resolveClaudeMdTargets(projectDir: string): ClaudeMdTargetResolution {
  const baseDir = resolveClaudeMdBaseDir(projectDir);
  const rootClaudeMdPath = path.join(baseDir, ROOT_CLAUDE_MD_PATH);
  const scopedClaudeMdPath = path.join(baseDir, CLAUDE_MD_PATH);
  const rootExists = fs.existsSync(rootClaudeMdPath);
  const scopedExists = fs.existsSync(scopedClaudeMdPath);

  if (rootExists) {
    return {
      baseDir,
      canonicalPath: rootClaudeMdPath,
      canonicalExisted: true,
      alternatePath: scopedExists ? scopedClaudeMdPath : null,
    };
  }

  if (scopedExists) {
    return {
      baseDir,
      canonicalPath: scopedClaudeMdPath,
      canonicalExisted: true,
      alternatePath: null,
    };
  }

  return {
    baseDir,
    canonicalPath: scopedClaudeMdPath,
    canonicalExisted: false,
    alternatePath: null,
  };
}

function getClaudeMdBootstrapContent(): string {
  return `# Project Context\n\n${DISTILLED_CLAUDE_MD_COMMENT}\n`;
}

function upsertGeneratedSubnotesSection(
  existingContent: string,
  subnotesContent: string,
): string {
  const subnotesPattern =
    `^${escapeRegex(SUBNOTES_SECTION_START)}[\\s\\S]*?^${escapeRegex(SUBNOTES_SECTION_END)}$`;
  const subnotesRegex = new RegExp(subnotesPattern, 'gm');

  let updatedContent: string;

  if (subnotesRegex.test(existingContent)) {
    subnotesRegex.lastIndex = 0;
    updatedContent = existingContent.replace(subnotesRegex, subnotesContent);
  } else {
    updatedContent =
      existingContent.trimEnd() + '\n\n' + subnotesContent + '\n';
  }

  const messagePattern = /^<subnotes_message>[\s\S]*?^<\/subnotes_message>\n*/gm;
  updatedContent = updatedContent.replace(messagePattern, '');
  return updatedContent.trimEnd() + '\n';
}

function stripGeneratedSubnotesContent(existingContent: string): string {
  const patterns = [
    `^${escapeRegex(SUBNOTES_SECTION_START)}[\\s\\S]*?^${escapeRegex(SUBNOTES_SECTION_END)}\\n*`,
  ];

  let cleaned = existingContent;
  for (const pattern of patterns) {
    const regex = new RegExp(pattern, 'gm');
    cleaned = cleaned.replace(regex, '');
  }

  const messagePatterns = [
    /^<subnotes_message>[\s\S]*?^<\/subnotes_message>\n*/gm,
  ];

  for (const pattern of messagePatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  cleaned = cleaned.replace(
    /<!-- (Subconscious|SubNotes) (agent memory|distilled context) is automatically synced below -->\n*/g,
    '',
  );

  const trimmed = cleaned.trim();
  if (!trimmed || trimmed === '# Project Context') {
    return '';
  }

  return `${trimmed}\n`;
}

function cleanGeneratedSubnotesFromClaudeMdFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const existingContent = fs.readFileSync(filePath, 'utf-8');
  const cleanedContent = stripGeneratedSubnotesContent(existingContent);

  if (!cleanedContent) {
    fs.unlinkSync(filePath);
    return;
  }

  if (cleanedContent !== existingContent) {
    fs.writeFileSync(filePath, cleanedContent, 'utf-8');
  }
}

export function updateClaudeMd(projectDir: string, subnotesContent: string): void {
  const claudeMdLockPath = path.join(
    getDurableStateDir(projectDir),
    'claude-md-sync.lock',
  );

  withProcessLock(claudeMdLockPath, () => {
    const targets = resolveClaudeMdTargets(projectDir);
    let existingContent = '';

    if (targets.canonicalExisted) {
      existingContent = fs.readFileSync(targets.canonicalPath, 'utf-8');
    } else {
      const claudeDir = path.dirname(targets.canonicalPath);
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
      existingContent = getClaudeMdBootstrapContent();
    }

    const updatedContent = upsertGeneratedSubnotesSection(
      existingContent,
      subnotesContent,
    );

    if (updatedContent === existingContent) {
      if (targets.alternatePath) {
        cleanGeneratedSubnotesFromClaudeMdFile(targets.alternatePath);
      }
      return;
    }

    fs.writeFileSync(targets.canonicalPath, updatedContent, 'utf-8');

    if (targets.alternatePath) {
      cleanGeneratedSubnotesFromClaudeMdFile(targets.alternatePath);
    }
  });
}

export function syncClaudeMdFromMemory(
  cwd: string,
  blocks: MemoryBlock[],
): void {
  updateClaudeMd(cwd, formatDistilledClaudeMd(blocks));
}

export function cleanSubNotesFromClaudeMd(projectDir: string): void {
  const baseDir = resolveClaudeMdBaseDir(projectDir);
  const candidatePaths = [
    path.join(baseDir, ROOT_CLAUDE_MD_PATH),
    path.join(baseDir, CLAUDE_MD_PATH),
  ];

  for (const candidatePath of candidatePaths) {
    if (fs.existsSync(candidatePath)) {
      cleanGeneratedSubnotesFromClaudeMdFile(candidatePath);
    }
  }
}

export function formatAllBlocksForStdout(
  blocks: MemoryBlock[],
  cwd?: string,
): string {
  const sdkToolsMode = getSdkToolsMode(cwd);
  const capabilityLine = sdkToolsMode === 'full'
    ? 'It can read files, search the web, and make changes to your codebase.'
    : sdkToolsMode === 'read-only'
      ? 'It can read files, search your codebase, and browse the web (read-only).'
      : 'It operates in listen-only mode (memory updates only).';

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

const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx';

export function spawnSilentWorker(
  workerScript: string,
  payloadFile: string,
  cwd: string,
): ChildProcess {
  const isWindows = process.platform === 'win32';
  let child: ChildProcess;

  if (isWindows) {
    const silentLauncher = path.join(__dirname, '..', 'hooks', 'silent-launcher.exe');
    const tsxCli = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const workerEnv = { ...process.env };
    delete workerEnv.SL_STDIN_FILE;
    delete workerEnv.SL_STDOUT_FILE;

    if (fs.existsSync(silentLauncher) && fs.existsSync(tsxCli)) {
      child = spawn(silentLauncher, ['node', tsxCli, workerScript, payloadFile], {
        detached: true,
        stdio: 'ignore',
        cwd,
        env: workerEnv,
        windowsHide: true,
      });
    } else if (fs.existsSync(tsxCli)) {
      child = spawn(process.execPath, [tsxCli, workerScript, payloadFile], {
        stdio: 'ignore',
        cwd,
        env: workerEnv,
        windowsHide: true,
      });
    } else {
      child = spawn(NPX_CMD, ['tsx', workerScript, payloadFile], {
        stdio: 'ignore',
        cwd,
        env: workerEnv,
        shell: true,
        windowsHide: true,
      });
    }
  } else {
    child = spawn(NPX_CMD, ['tsx', workerScript, payloadFile], {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: process.env,
    });
  }
  child.unref();
  return child;
}

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

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // EPERM means process exists but we don't have permission to signal it.
    return err.code === 'EPERM';
  }
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

function readPidFile(pidFile: string, log: LogFn = noopLog): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (Number.isNaN(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch (error) {
    log(`Failed to read PID file ${pidFile}: ${error}`);
    return null;
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

  const currentPid = readPidFile(pidFile, log);
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
      const pid = readPidFile(fullPath, log);
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

    let pid: number;
    try {
      pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    } catch (error) {
      log(`Failed to read PID file ${pidFile}: ${error}`);
      removePidFile(pidFile, log);
      continue;
    }

    if (Number.isNaN(pid) || pid <= 0) {
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

interface ClaudeTranscriptContentBlock {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
}

interface ClaudeTranscriptRecord {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: ClaudeTranscriptContentBlock[] | unknown;
  };
}

function stringifyTranscriptValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function collectTextBlocks(blocks: ClaudeTranscriptContentBlock[]): string[] {
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text) {
        parts.push(text);
      }
      continue;
    }

    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const thinking = block.thinking.trim();
      if (thinking) {
        parts.push(`<thinking>\n${thinking}\n</thinking>`);
      }
    }
  }

  return parts;
}

function extractToolResultText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return stringifyTranscriptValue(item);
        }

        const block = item as { type?: unknown; text?: unknown };
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }

        return stringifyTranscriptValue(item);
      })
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length > 0) {
      return parts.join('\n\n');
    }
  }

  return stringifyTranscriptValue(value);
}

function buildToolEventContent(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
): string {
  return (
    `<tool_event>\n` +
    `<name>${toolName}</name>\n` +
    `<input>\n${stringifyTranscriptValue(toolInput)}\n</input>\n` +
    `<response>\n${extractToolResultText(toolResponse)}\n</response>\n` +
    `</tool_event>`
  );
}

function parseClaudeTranscriptEntries(
  lines: string[],
  startIndex: number,
  pendingToolUses: Record<
    string,
    {
      name: string;
      input: unknown;
      timestamp: string;
    }
  >,
  fallbackTimestamp: string,
  log: LogFn = noopLog,
): { entries: TranscriptEntry[]; latestLineIndex: number } {
  const entries: TranscriptEntry[] = [];
  let latestLineIndex = startIndex;

  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    latestLineIndex = index;

    let record: ClaudeTranscriptRecord;
    try {
      record = JSON.parse(line) as ClaudeTranscriptRecord;
    } catch (error) {
      log(`Failed to parse Claude transcript line ${index}: ${error}`);
      continue;
    }

    if (!record || (record.type !== 'user' && record.type !== 'assistant')) {
      continue;
    }

    const blocks = Array.isArray(record.message?.content)
      ? record.message.content
      : [];
    const timestamp =
      typeof record.timestamp === 'string' && record.timestamp
        ? record.timestamp
        : fallbackTimestamp;

    if (record.type === 'assistant') {
      const assistantParts = collectTextBlocks(blocks);
      if (assistantParts.length > 0) {
        entries.push({
          timestamp,
          role: 'assistant',
          content: assistantParts.join('\n\n'),
        });
      }

      for (const block of blocks) {
        if (
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string'
        ) {
          pendingToolUses[block.id] = {
            name: block.name,
            input: block.input,
            timestamp,
          };
        }
      }

      continue;
    }

    const userTextParts = blocks
      .filter(
        (block): block is ClaudeTranscriptContentBlock =>
          block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => {
        const text = block.text;
        return typeof text === 'string' ? text.trim() : '';
      })
      .filter(Boolean);

    if (userTextParts.length > 0) {
      entries.push({
        timestamp,
        role: 'user',
        content: userTextParts.join('\n\n'),
      });
    }

    for (const block of blocks) {
      if (
        block.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string'
      ) {
        continue;
      }

      const pending =
        pendingToolUses[block.tool_use_id] || {
          name: 'unknown_tool',
          input: '(missing tool input)',
          timestamp,
        };

      entries.push({
        timestamp,
        role: 'system',
        content: buildToolEventContent(
          pending.name,
          pending.input,
          block.content ?? '(no tool response)',
        ),
      });

      delete pendingToolUses[block.tool_use_id];
    }
  }

  return { entries, latestLineIndex };
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
