#!/usr/bin/env tsx
/**
 * PreToolUse Memory Sync Script
 *
 * Lightweight hook that checks for local SubNotes changes mid-workflow.
 * Runs before each tool use to inject any new memory changes.
 */

import {
  readHookInput,
  createDebugLogger,
  detectChangedBlocks,
  formatChangedBlocksAsXml,
  snapshotBlockValues,
  fetchUnreadAgentMessages,
  formatMessagesForHookContext,
  generateForegroundInstruction,
} from './framework/index.js';
import {
  loadSyncState,
  saveSyncState,
  loadLocalMemory,
  getMode,
} from './conversation_utils.js';

const debug = createDebugLogger('pretool');

interface PreToolInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
}

async function main(): Promise<void> {
  const mode = getMode();
  if (mode === 'off') {
    process.exit(0);
  }

  try {
    const hookInput = await readHookInput<PreToolInput>();

    if (!hookInput?.session_id || !hookInput?.cwd) {
      debug('Missing session_id or cwd, skipping');
      process.exit(0);
    }

    debug(`PreToolUse for tool: ${hookInput.tool_name}`);

    // Load state
    const state = loadSyncState(hookInput.cwd, hookInput.session_id);

    if (!state.lastBlockValues) {
      debug('No previous state, skipping');
      process.exit(0);
    }

    // Load local memory and detect changes
    const blocks = loadLocalMemory(hookInput.cwd, debug);
    const changedBlocks = detectChangedBlocks(blocks, state.lastBlockValues);
    const unreadMessages = fetchUnreadAgentMessages(hookInput.cwd, debug);

    debug(`Changed blocks: ${changedBlocks.length}`);
    debug(`Unread messages: ${unreadMessages.length}`);

    if (changedBlocks.length === 0 && unreadMessages.length === 0) {
      debug('No updates or messages, exiting silently');
      process.exit(0);
    }

    const updateSections: string[] = [];

    if (changedBlocks.length > 0) {
      // Format output (without the comment header — pretool uses compact format)
      const memoryUpdate = formatChangedBlocksAsXml(
        changedBlocks,
        state.lastBlockValues,
        false,
      );
      updateSections.push(memoryUpdate);
    }

    if (unreadMessages.length > 0) {
      const whisperUpdate =
        `<subnotes_message_update>\n` +
        `${formatMessagesForHookContext(unreadMessages)}\n` +
        `</subnotes_message_update>`;
      updateSections.push(whisperUpdate);
    }

    // Update state
    state.lastBlockValues = snapshotBlockValues(blocks);
    saveSyncState(hookInput.cwd, state);

    const subnotes_update =
      `<subnotes_update>\n` +
      `${updateSections.join('\n\n')}\n` +
      `</subnotes_update>`;

    const contextParts = [subnotes_update];

    if (unreadMessages.length > 0) {
      contextParts.push(generateForegroundInstruction(unreadMessages));
    }

    if (changedBlocks.length > 0) {
      contextParts.push(
        `<instruction>Notes updated memory mid-session (shown above). If this is relevant to your current task, surface it:\n\n---\n\n**Notes update** — [one-line summary of what changed and why it matters]\n\nOmit if not relevant to the current tool call.</instruction>`,
      );
    }

    const contextWithInstruction = contextParts.join('\n\n');

    const output: Record<string, unknown> = {
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: contextWithInstruction,
      },
    };

    console.log(JSON.stringify(output));
  } catch (error) {
    debug(`Error: ${error}`);
    process.exit(0);
  }
}

main();
