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
  openTty,
  detectChangedBlocks,
  formatChangedBlocksAsXml,
  snapshotBlockValues,
  fetchUnreadAgentMessages,
  formatMessagesForHookContext,
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

    const contextWithInstruction =
      `<subnotes_update>\n` +
      `${updateSections.join('\n\n')}\n` +
      `</subnotes_update>`;

    const output: Record<string, unknown> = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: contextWithInstruction,
      },
    };

    const tty = openTty();
    const parts: string[] = [];
    if (changedBlocks.length > 0) {
      parts.push(`${changedBlocks.length} memory update${changedBlocks.length === 1 ? '' : 's'}`);
    }
    if (unreadMessages.length > 0) {
      parts.push(`${unreadMessages.length} whisper${unreadMessages.length === 1 ? '' : 's'}`);
    }
    tty.write(`\x1b[2mSubNotes injected before tool call: ${parts.join(' + ')}\x1b[0m\n`);
    tty.close();

    console.log(JSON.stringify(output));
  } catch (error) {
    debug(`Error: ${error}`);
    process.exit(0);
  }
}

main();
