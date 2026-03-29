#!/usr/bin/env npx tsx
/**
 * Stop Hook — Subconscious Thought Delivery
 *
 * Fires when Claude is about to stop responding. If the Subconscious has
 * posted an unread message, this hook blocks the stop and injects the
 * thought into the conversation, keeping the session alive until the
 * message is read.
 *
 * Once all messages are marked read, the hook exits silently and Claude
 * stops normally.
 *
 * Exit Codes:
 *   0 - No unread messages, allow stop
 *   0 - Unread messages found, output block decision (Claude continues)
 */

import {
  readHookInput,
  createDebugLogger,
  fetchUnreadAgentMessages,
  peekUnreadAgentMessages,
  formatMessagesForHookContext,
  generateForegroundInstruction,
} from './framework/index.js';
import {
  getMode,
  getSdkToolsMode,
  ensureContinuousWorker,
  mirrorClaudeTranscript,
} from './conversation_utils.js';

const debug = createDebugLogger('stop-sync');

interface StopHookInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  try {
    const hookInput = await readHookInput<StopHookInput>();

    if (!hookInput?.cwd) {
      debug('Missing cwd, skipping');
      process.exit(0);
    }

    const mode = getMode(hookInput.cwd);
    if (mode === 'off') {
      process.exit(0);
    }

    if (hookInput.session_id && hookInput.transcript_path) {
      ensureContinuousWorker(
        hookInput.session_id,
        hookInput.cwd,
        getSdkToolsMode(hookInput.cwd),
      );
      mirrorClaudeTranscript(
        hookInput.cwd,
        hookInput.session_id,
        hookInput.transcript_path,
      );
    }

    let foregroundPreview = peekUnreadAgentMessages(hookInput.cwd, debug);
    if (foregroundPreview.length === 0 && hookInput.transcript_path) {
      for (let attempt = 0; attempt < 4; attempt++) {
        await sleep(300);
        foregroundPreview = peekUnreadAgentMessages(hookInput.cwd, debug);
        if (foregroundPreview.length > 0) {
          break;
        }
      }
    }

    if (foregroundPreview.length === 0) {
      debug('No foreground messages, allowing stop');
      process.exit(0);
    }

    const foregroundMessages = fetchUnreadAgentMessages(hookInput.cwd, debug);
    if (foregroundMessages.length === 0) {
      debug('Foreground preview was stale, allowing stop');
      process.exit(0);
    }

    debug(`Found ${foregroundMessages.length} foreground message(s), blocking stop`);

    const formattedMessages = formatMessagesForHookContext(foregroundMessages);

    const reason = `${formattedMessages}\n\n${generateForegroundInstruction(foregroundMessages)}`;

    console.log(
      JSON.stringify({
        decision: 'block',
        reason,
      }),
    );
  } catch (error) {
    debug(`Error: ${error}`);
    process.exit(0);
  }
}

main();
