#!/usr/bin/env tsx
/**
 * Local Memory Sync Script
 *
 * Syncs local subconscious memory blocks into Claude Code's context.
 * Designed to run as a Claude Code UserPromptSubmit and SessionStart hook.
 *
 * Exit Codes:
 *   0 - Success
 *   1 - Non-blocking error (logged to stderr)
 */

import {
  readHookInput,
  createDebugLogger,
  openTty,
  detectChangedBlocks,
  formatChangedBlocksAsXml,
  snapshotBlockValues,
  fetchUnreadAgentMessages,
  formatMessagesForStdout,
} from './framework/index.js';
import {
  loadSyncState,
  saveSyncState,
  loadLocalMemory,
  formatAllBlocksForStdout,
  cleanSubNotesFromClaudeMd,
  getMode,
} from './conversation_utils.js';

const debug = createDebugLogger('sync');

interface SyncHookInput {
  session_id: string;
  cwd: string;
  prompt?: string;
}

async function main(): Promise<void> {
  const mode = getMode();
  if (mode === 'off') {
    process.exit(0);
  }

  const projectDir = process.cwd();

  try {
    const hookInput = await readHookInput<SyncHookInput>();
    const cwd = hookInput?.cwd || projectDir;
    const sessionId = hookInput?.session_id;

    let state = sessionId ? loadSyncState(cwd, sessionId) : null;
    const lastBlockValues = state?.lastBlockValues || null;

    const memoryBlocks = loadLocalMemory(cwd);
    const unreadMessages = fetchUnreadAgentMessages(cwd, debug);

    const changedBlocks = detectChangedBlocks(memoryBlocks, lastBlockValues);

    cleanSubNotesFromClaudeMd(cwd);

    // Update state snapshot
    if (state) {
      state.lastBlockValues = snapshotBlockValues(memoryBlocks);
    }

    const outputs: string[] = [];
    let injectedMemory = false;

    if (mode === 'full') {
      const isFirstPrompt = !lastBlockValues;

      if (isFirstPrompt) {
        outputs.push(formatAllBlocksForStdout(memoryBlocks));
        injectedMemory = true;
      } else {
        const changedBlocksOutput = formatChangedBlocksAsXml(
          changedBlocks,
          lastBlockValues,
          true,
        );
        if (changedBlocksOutput) {
          outputs.push(changedBlocksOutput);
          injectedMemory = true;
        }
      }
    }

    if (unreadMessages.length > 0) {
      outputs.push(formatMessagesForStdout(unreadMessages));
      outputs.push(
        `<instruction>SubNotes sent you a message above. Briefly acknowledge what SubNotes said - just a short note like "SubNotes: [key point]" so the user knows.</instruction>`,
      );
    }

    if (outputs.length > 0) {
      const tty = openTty();
      const parts: string[] = [];
      if (injectedMemory) {
        parts.push('memory');
      }
      if (unreadMessages.length > 0) {
        parts.push(`${unreadMessages.length} whisper${unreadMessages.length === 1 ? '' : 's'}`);
      }
      tty.write(`\x1b[2mSubNotes injected: ${parts.join(' + ')}\x1b[0m\n`);
      tty.close();
      console.log(outputs.join('\n\n'));
    }

    if (state && sessionId) {
      saveSyncState(cwd, state);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error(`Error syncing local memory: ${errorMessage}`);
    process.exit(1);
  }
}

main();
