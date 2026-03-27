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

    debug(`Changed blocks: ${changedBlocks.length}`);

    if (changedBlocks.length === 0) {
      debug('No updates, exiting silently');
      process.exit(0);
    }

    // Format output (without the comment header — pretool uses compact format)
    const additionalContext = formatChangedBlocksAsXml(
      changedBlocks,
      state.lastBlockValues,
      false,
    );

    // Update state
    state.lastBlockValues = snapshotBlockValues(blocks);
    saveSyncState(hookInput.cwd, state);

    const contextWithInstruction = `<subnotes_update>\n${additionalContext}\n</subnotes_update>`;

    const output: Record<string, unknown> = {
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
