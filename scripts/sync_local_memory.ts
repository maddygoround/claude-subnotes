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
  formatAllBlocksForStdout,
  syncClaudeMdFromMemory,
  getMode,
} from './conversation_utils.js';

const debug = createDebugLogger('sync');

interface SyncHookInput {
  session_id: string;
  cwd: string;
  prompt?: string;
  hook_event_name?: 'SessionStart' | 'UserPromptSubmit';
}

async function main(): Promise<void> {
  const projectDir = process.cwd();

  try {
    const hookInput = await readHookInput<SyncHookInput>();
    const cwd = hookInput?.cwd || projectDir;
    const sessionId = hookInput?.session_id;
    const mode = getMode(cwd);

    if (mode === 'off') {
      process.exit(0);
    }

    let state = sessionId ? loadSyncState(cwd, sessionId) : null;
    const lastBlockValues = state?.lastBlockValues || null;

    const memoryBlocks = loadLocalMemory(cwd);
    const foregroundMessages = fetchUnreadAgentMessages(cwd, debug);

    const changedBlocks = detectChangedBlocks(memoryBlocks, lastBlockValues);

    syncClaudeMdFromMemory(cwd, memoryBlocks);

    // Update state snapshot
    if (state) {
      state.lastBlockValues = snapshotBlockValues(memoryBlocks);
    }

    const outputs: string[] = [];
    if (mode === 'full') {
      const isFirstPrompt = !lastBlockValues;

      if (isFirstPrompt) {
        outputs.push(formatAllBlocksForStdout(memoryBlocks, cwd));
      } else {
        const changedBlocksOutput = formatChangedBlocksAsXml(
          changedBlocks,
          lastBlockValues,
          true,
        );
        if (changedBlocksOutput) {
          outputs.push(changedBlocksOutput);
        }
      }
    }

    if (foregroundMessages.length > 0) {
      outputs.push(formatMessagesForHookContext(foregroundMessages));
      outputs.push(generateForegroundInstruction(foregroundMessages));
    }

    if (lastBlockValues && changedBlocks.length > 0) {
      outputs.push(
        `<instruction>Notes updated memory blocks since your last response (shown above). If this affects your answer, acknowledge it:\n\n---\n\n**Notes update** — [what changed and why it matters]\n\nOmit if not relevant to the current conversation.</instruction>`,
      );
    }

    if (outputs.length > 0) {
      const hookEventName =
        hookInput?.hook_event_name === 'SessionStart'
          ? 'SessionStart'
          : 'UserPromptSubmit';
      const output: Record<string, unknown> = {
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName,
          additionalContext: outputs.join('\n\n'),
        },
      };

      console.log(JSON.stringify(output));
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
