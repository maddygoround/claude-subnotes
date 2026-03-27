#!/usr/bin/env npx tsx
/**
 * Send Messages to Local Background Worker
 *
 * Sends Claude Code conversation messages to the local subconscious agent.
 * Designed to run as a Claude Code Stop hook.
 *
 * Hook Input (via stdin):
 *   - session_id: Current session ID
 *   - transcript_path: Path to conversation JSONL file
 *   - stop_hook_active: Whether stop hook is already active
 *
 * Exit Codes:
 *   0 - Success
 *   1 - Non-blocking error
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  readHookInputStrict,
  createFileLogger,
} from './framework/index.js';
import {
  loadSyncState,
  saveSyncState,
  getSyncStateFile,
  spawnSilentWorker,
  getMode,
  getTempStateDir,
  getSdkToolsMode,
} from './conversation_utils.js';
import {
  readTranscript,
  formatMessagesForLetta,
} from './transcript_utils.js';
import * as fs from 'fs';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const TEMP_STATE_DIR = getTempStateDir();
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_messages_local.log');
const log = createFileLogger(LOG_FILE);

interface StopHookInput {
  session_id: string;
  transcript_path: string;
  stop_hook_active?: boolean;
  cwd: string;
  hook_event_name?: string;
}

async function main(): Promise<void> {
  log('='.repeat(60));
  log('send_messages_to_local.ts started');

  const mode = getMode();
  log(`Mode: ${mode}`);
  if (mode === 'off') {
    log('Mode is off, exiting');
    process.exit(0);
  }

  try {
    log('Reading hook input from stdin...');
    const hookInput = await readHookInputStrict<StopHookInput>();

    if (hookInput.stop_hook_active) {
      log('Stop hook already active, exiting to prevent loop');
      process.exit(0);
    }

    log(`Reading transcript from: ${hookInput.transcript_path}`);
    const messages = await readTranscript(hookInput.transcript_path, log);

    if (messages.length === 0) {
      log('No messages found, exiting');
      process.exit(0);
    }

    const state = loadSyncState(hookInput.cwd, hookInput.session_id, log);
    const newMessages = formatMessagesForLetta(
      messages,
      state.lastProcessedIndex,
      log,
    );

    if (newMessages.length === 0) {
      log('No new messages to send looking at lastProcessedIndex');
      process.exit(0);
    }

    saveSyncState(hookInput.cwd, state, log);

    const transcriptEntries = newMessages
      .map((m) => {
        const role =
          m.role === 'user'
            ? 'user'
            : m.role === 'assistant'
              ? 'claude_code'
              : 'system';
        const escaped = m.text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        return `<message role="${role}">\n${escaped}\n</message>`;
      })
      .join('\n');

    const userMessage = `<claude_code_session_update>
<session_id>${hookInput.session_id}</session_id>

<transcript>
${transcriptEntries}
</transcript>

<instructions>
You may provide commentary or guidance for Claude Code. Your response will be added to Claude's context window on the next prompt. Use this to:
- Offer observations about the user's work
- Provide reminders or context from your memory
- Suggest approaches or flag potential issues

Also, actively update your memory blocks if you observe patterns, useful context, or completed tasks.
</instructions>
</claude_code_session_update>`;

    const sdkToolsMode = getSdkToolsMode();
    const payloadFile = path.join(
      TEMP_STATE_DIR,
      `payload-${hookInput.session_id}-${Date.now()}.json`,
    );
    const stateFile = getSyncStateFile(hookInput.cwd, hookInput.session_id);

    const agentPayload = {
      sessionId: hookInput.session_id,
      message: userMessage,
      stateFile,
      newLastProcessedIndex: messages.length - 1,
      cwd: hookInput.cwd,
      sdkToolsMode,
    };
    fs.writeFileSync(payloadFile, JSON.stringify(agentPayload), 'utf-8');
    log(`Wrote local agent payload to ${payloadFile}`);

    const workerScript = path.join(__dirname, 'send_worker_local.ts');
    const child = spawnSilentWorker(workerScript, payloadFile, hookInput.cwd);
    log(`Spawned local worker (PID: ${child.pid})`);

    log('Hook completed (worker running in background)');
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    console.error(
      `Error sending messages to local worker: ${errorMessage}`,
    );
    process.exit(1);
  }
}

main();
