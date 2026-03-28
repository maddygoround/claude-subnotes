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
  formatMessagesForHookContext,
} from './framework/index.js';
import { getMode } from './conversation_utils.js';

const debug = createDebugLogger('stop-sync');

interface StopHookInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
}

async function main(): Promise<void> {
  const mode = getMode();
  if (mode === 'off') {
    process.exit(0);
  }

  try {
    const hookInput = await readHookInput<StopHookInput>();

    if (!hookInput?.cwd) {
      debug('Missing cwd, skipping');
      process.exit(0);
    }

    const unreadMessages = fetchUnreadAgentMessages(hookInput.cwd, debug);

    if (unreadMessages.length === 0) {
      debug('No unread messages, allowing stop');
      process.exit(0);
    }

    debug(`Found ${unreadMessages.length} unread message(s), blocking stop`);

    const formattedMessages = formatMessagesForHookContext(unreadMessages);

    const reason =
      `${formattedMessages}\n\n` +
      `<instruction>Subconscious sent you a thought above. Render it visibly in your response using this format:\n\n` +
      `---\n\n` +
      `**Subconscious thought** — [distilled key point from the message]\n\n` +
      `Keep it to one line — just the signal, not the full message.</instruction>`;

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
