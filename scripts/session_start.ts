#!/usr/bin/env npx tsx
/**
 * Session Start Hook Script
 *
 * Runs when a new Claude Code session begins.
 * Initializes the SubNotes agent's local state and cleans up old CLAUDE.md sections.
 *
 * Hook Input (via stdin):
 *   - session_id: Current session ID
 *   - cwd: Current working directory
 *   - hook_event_name: "SessionStart"
 */

import * as os from 'os';
import * as path from 'path';
import {
  readHookInputStrict,
  createFileLogger,
} from './framework/index.js';
import {
  cleanSubNotesFromClaudeMd,
  getMode,
  getTempStateDir,
  getSdkToolsMode,
  saveSyncState,
  loadLocalMemory,
  ensureConfigFile,
  ensureContinuousWorker,
} from './conversation_utils.js';

// Configuration
const TEMP_STATE_DIR = getTempStateDir();
const LOG_FILE = path.join(TEMP_STATE_DIR, 'session_start.log');
const log = createFileLogger(LOG_FILE);

interface SessionStartInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
}

async function main(): Promise<void> {
  log('='.repeat(60));
  log('session_start.ts started');

  const mode = getMode();
  log(`Mode: ${mode}`);
  if (mode === 'off') {
    log('Mode is off, exiting');
    process.exit(0);
  }

  try {
    // Read hook input
    log('Reading hook input from stdin...');
    const hookInput = await readHookInputStrict<SessionStartInput>();
    log(`Hook input: session_id=${hookInput.session_id}, cwd=${hookInput.cwd}`);

    // Initialize or load local memory
    loadLocalMemory(hookInput.cwd, log);

    // Ensure config.json exists with defaults
    ensureConfigFile(hookInput.cwd, log);

    // Save initial session state
    saveSyncState(
      hookInput.cwd,
      {
        sessionId: hookInput.session_id,
        lastProcessedIndex: -1,
      },
      log,
    );

    // Start the continuous worker (single execution model).
    const sdkToolsMode = getSdkToolsMode();
    const worker = ensureContinuousWorker(
      hookInput.session_id,
      hookInput.cwd,
      sdkToolsMode,
      log,
    );
    if (worker) {
      log(`Spawned continuous worker (PID: ${worker.pid})`);
    } else {
      log('Continuous worker already running');
    }

    // Clean up any existing <letta> or <subnotes> section from CLAUDE.md
    log('Cleaning up any legacy CLAUDE.md content...');
    cleanSubNotesFromClaudeMd(hookInput.cwd);

    const homeDir = process.env.HOME || os.homedir();
    if (homeDir !== hookInput.cwd) {
      log('Cleaning up global ~/.claude/CLAUDE.md...');
      cleanSubNotesFromClaudeMd(homeDir);
    }
    log('CLAUDE.md cleanup done');

    log('Completed successfully');
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    process.exit(1);
  }
}

main();
