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
  fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
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
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      log(`Loaded state: lastProcessedIndex=${state.lastProcessedIndex}`);
      return state;
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
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  log(`Saved state: lastProcessedIndex=${state.lastProcessedIndex}`);
}

const DEFAULT_MEMORY_BLOCKS: MemoryBlock[] = [
  {
    label: 'core_directives',
    description: 'Primary role and behavioral guidelines',
    value: 'ROLE: The Subconscious — a persistent agent that whispers to Claude Code.\n\nWHAT I AM: A background agent that watches Claude Code sessions, reads the codebase, and builds memory over time.\n\nKeep guidance concise. Update memory when observing habits.'
  },
  {
    label: 'guidance',
    description: 'Active guidance for the next Claude Code session.',
    value: '(No active guidance. Write here when there\'s something genuinely useful for the next session.)'
  },
  {
    label: 'pending_items',
    description: 'Unfinished work, explicit TODOs, follow-up items mentioned across sessions.',
    value: '(No pending items. Populated when sessions end mid-task or user mentions follow-ups.)'
  },
  {
    label: 'project_context',
    description: 'Active project knowledge: what the codebase does, architecture decisions, known gotchas, key files.',
    value: '(No project context yet. Populated as sessions reveal codebase details.)'
  },
  {
    label: 'session_patterns',
    description: 'Recurring behaviors, time-based patterns, common struggles.',
    value: '(No patterns observed yet. Populated after multiple sessions.)'
  },
  {
    label: 'user_preferences',
    description: 'Learned coding style, tool preferences, and communication style.',
    value: '(No user preferences yet. Populated as sessions reveal coding style, tool choices, and communication preferences.)'
  }
];

export function loadLocalMemory(cwd: string, log: LogFn = noopLog): MemoryBlock[] {
  const memoryFile = getMemoryFile(cwd);
  if (fs.existsSync(memoryFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
      if (Array.isArray(data) && data.length > 0 && data[0].label) {
        log(`Loaded memory blocks from disk`);
        return data as MemoryBlock[];
      }
    } catch (e) {
      log(`Failed to load memory blocks: ${e}`);
    }
  }
  log(`Initializing default memory blocks`);
  ensureDurableStateDir(cwd);
  fs.writeFileSync(memoryFile, JSON.stringify(DEFAULT_MEMORY_BLOCKS, null, 2), 'utf-8');
  return DEFAULT_MEMORY_BLOCKS;
}

export function saveLocalMemory(cwd: string, blocks: MemoryBlock[], log: LogFn = noopLog): void {
  ensureDurableStateDir(cwd);
  const memoryFile = getMemoryFile(cwd);
  fs.writeFileSync(memoryFile, JSON.stringify(blocks, null, 2), 'utf-8');
  log(`Saved memory blocks to disk`);
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
**Claude's SubNotes**

This agent maintains persistent memory across your sessions. It observes your conversations asynchronously and provides guidance via <subnotes_message> (injected before each user prompt). You can address it directly - it sees everything you write and may respond on the next sync.

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
SubNotes agent is watching this session and whispering guidance.
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

function getLegacyContinuousWorkerPidFile(sessionId: string): string {
  return path.join(getTempStateDir(), `continuous-worker-${sessionId}.pid`);
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
  const pidFiles = [
    getContinuousWorkerPidFile(sessionId, cwd),
    getLegacyContinuousWorkerPidFile(sessionId),
  ];

  for (const pidFile of pidFiles) {
    if (!fs.existsSync(pidFile)) {
      continue;
    }

    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);

      // Check if process is actually running
      process.kill(pid, 0); // Signal 0 checks if process exists without killing it
      return true;
    } catch (error) {
      // Process doesn't exist or permission error; continue checking others.
    }
  }

  return false;
}

/**
 * Spawn continuous worker if not already running
 */
export function ensureContinuousWorker(
  sessionId: string,
  cwd: string,
  sdkToolsMode: 'read-only' | 'full' | 'off'
): ChildProcess | null {
  // Check if already running
  if (isContinuousAgentRunning(sessionId, cwd)) {
    return null;
  }

  // Create payload
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
  const payloadFile = path.join(tempDir, `continuous-payload-${namespace}-${sessionId}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload));

  const workerScript = path.join(__dirname, 'send_worker_continuous.ts');
  return spawnSilentWorker(workerScript, payloadFile, cwd);
}
