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
export const CLAUDE_MD_PATH = '.claude/CLAUDE.md';
export const SUBNOTES_SECTION_START = '<subnotes>';
export const SUBNOTES_SECTION_END = '</subnotes>';
const SUBNOTES_CONTEXT_START = '<subnotes_context>';
const SUBNOTES_CONTEXT_END = '</subnotes_context>';
const SUBNOTES_MEMORY_START = '<subnotes_memory_blocks>';
const SUBNOTES_MEMORY_END = '</subnotes_memory_blocks>';

// ============================================
// Mode Configuration
// ============================================

export type SubNotesMode = 'whisper' | 'full' | 'off';

/**
 * Get the current operating mode.
 */
export function getMode(): SubNotesMode {
  const mode = process.env.SUBNOTES_MODE?.toLowerCase();
  if (mode === 'full' || mode === 'off') return mode;
  return 'whisper';
}

/**
 * Ensure config.json exists with default values.
 * Creates the file if it doesn't exist, preserves existing config if it does.
 */
export function ensureConfigFile(cwd: string, log: LogFn = noopLog): void {
  const configPath = path.join(getDurableStateDir(cwd), 'config.json');

  // If config already exists, don't overwrite it
  if (fs.existsSync(configPath)) {
    log('Config file already exists');
    return;
  }

  // Create default config using current environment defaults
  const defaultConfig = {
    sdkToolsMode: getSdkToolsMode(),
    architecture: 'continuous',
  };

  ensureDurableStateDir(cwd);
  writeJsonFileAtomic(configPath, defaultConfig, log);
  log(`Created default config.json: ${JSON.stringify(defaultConfig)}`);
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

export function getSdkToolsMode(): SdkToolsMode {
  const mode = process.env.SUBNOTES_SDK_TOOLS?.toLowerCase();
  if (mode === 'full' || mode === 'off') return mode;
  return 'read-only';
}

// ============================================
// State & Memory Storage
// ============================================

export interface SyncState {
  lastProcessedIndex: number;
  sessionId: string;
  lastBlockValues?: { [label: string]: string };
  lastSeenMessageId?: string;
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
  const sharedHome = process.env.SUBNOTES_HOME;
  const base = sharedHome || cwd;
  return path.join(base, '.subnotes');
}

export function getDurableStateDir(cwd: string): string {
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
  writeJsonFileAtomic(statePath, state, log);
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

export function updateClaudeMd(projectDir: string, subnotesContent: string): void {
  const base = process.env.SUBNOTES_PROJECT || projectDir;
  const claudeMdPath = path.join(base, CLAUDE_MD_PATH);

  let existingContent = '';

  if (fs.existsSync(claudeMdPath)) {
    existingContent = fs.readFileSync(claudeMdPath, 'utf-8');
  } else {
    const claudeDir = path.dirname(claudeMdPath);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
    existingContent = `# Project Context\n\n<!-- SubNotes agent memory is automatically synced below -->\n`;
  }

  const subnotesPattern = `^${escapeRegex(SUBNOTES_SECTION_START)}[\\s\\S]*?^${escapeRegex(SUBNOTES_SECTION_END)}$`;
  const subnotesRegex = new RegExp(subnotesPattern, 'gm');

  let updatedContent: string;

  if (subnotesRegex.test(existingContent)) {
    subnotesRegex.lastIndex = 0;
    updatedContent = existingContent.replace(subnotesRegex, subnotesContent);
  } else {
    updatedContent = existingContent.trimEnd() + '\n\n' + subnotesContent + '\n';
  }

  const messagePattern = /^<subnotes_message>[\s\S]*?^<\/subnotes_message>\n*/gm;
  updatedContent = updatedContent.replace(messagePattern, '');
  updatedContent = updatedContent.trimEnd() + '\n';

  fs.writeFileSync(claudeMdPath, updatedContent, 'utf-8');
}

export function cleanSubNotesFromClaudeMd(projectDir: string): void {
  const base = process.env.SUBNOTES_PROJECT || projectDir;
  const claudeMdPath = path.join(base, CLAUDE_MD_PATH);

  if (!fs.existsSync(claudeMdPath)) {
    return;
  }

  const content = fs.readFileSync(claudeMdPath, 'utf-8');

  // Clean both old letta tags and new subnotes tags for migration
  const patterns = [
    `^<letta>[\\s\\S]*?^<\\/letta>\\n*`,
    `^${escapeRegex(SUBNOTES_SECTION_START)}[\\s\\S]*?^${escapeRegex(SUBNOTES_SECTION_END)}\\n*`
  ];

  let cleaned = content;
  for (const pattern of patterns) {
    const regex = new RegExp(pattern, 'gm');
    cleaned = cleaned.replace(regex, '');
  }

  const messagePatterns = [
    /^<letta_message>[\s\S]*?^<\/letta_message>\n*/gm,
    /^<subnotes_message>[\s\S]*?^<\/subnotes_message>\n*/gm
  ];

  for (const pattern of messagePatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  cleaned = cleaned.replace(/<!-- (Subconscious|SubNotes) agent memory is automatically synced below -->\n*/g, '');
  cleaned = cleaned.replace(/^# Project Context\n*/gm, '');

  cleaned = cleaned.trim();

  if (cleaned.length === 0) {
    fs.unlinkSync(claudeMdPath);
  } else {
    fs.writeFileSync(claudeMdPath, cleaned + '\n', 'utf-8');
  }
}

export function formatAllBlocksForStdout(blocks: MemoryBlock[]): string {
  const sdkToolsMode = getSdkToolsMode();
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
