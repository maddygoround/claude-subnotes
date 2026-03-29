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

import * as path from 'path';
import { createFileLogger } from './framework/index.js';
import { getTempStateDir } from './conversation_utils.js';
import { createSessionStartUseCase } from './application/composition/session-start-composition.js';

// Configuration
const TEMP_STATE_DIR = getTempStateDir();
const LOG_FILE = path.join(TEMP_STATE_DIR, 'session_start.log');
const log = createFileLogger(LOG_FILE);

async function main(): Promise<void> {
  try {
    const useCase = createSessionStartUseCase(log);
    await useCase.execute();
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    process.exit(1);
  }
}

main();
