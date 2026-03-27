#!/usr/bin/env tsx
/**
 * Stream Transcript Hook
 *
 * Appends transcript entries to the continuous transcript file.
 * Called by UserPromptSubmit and PostToolUse hooks to stream conversation data
 * to the continuous agent.
 */

import { readHookInput } from './framework/index.js';
import {
  appendTranscriptEntry,
  TranscriptEntry,
  getMode,
  getUpdateMode,
} from './conversation_utils.js';

interface StreamHookInput {
  session_id: string;
  cwd: string;
  prompt?: string;
  response?: string;
  hook_event_name?: string;
}

async function main(): Promise<void> {
  const mode = getMode();
  if (mode === 'off') {
    process.exit(0);
  }

  // Only run in continuous mode
  const hookInput = await readHookInput<StreamHookInput>();
  const cwd = hookInput?.cwd || process.cwd();
  const updateMode = getUpdateMode(cwd);
  if (updateMode !== 'continuous') {
    process.exit(0);
  }

  try {
    if (!hookInput?.session_id || !hookInput?.cwd) {
      process.exit(0);
    }

    // Determine role and content based on hook event
    let role: 'user' | 'assistant' | 'system' = 'user';
    let content = '';

    if (hookInput.prompt) {
      role = 'user';
      content = hookInput.prompt;
    } else if (hookInput.response) {
      role = 'assistant';
      content = hookInput.response;
    } else {
      // No content to stream
      process.exit(0);
    }

    const entry: TranscriptEntry = {
      timestamp: new Date().toISOString(),
      role,
      content,
    };

    appendTranscriptEntry(hookInput.cwd, hookInput.session_id, entry);
  } catch (error) {
    // Fail silently - don't break hooks
    console.error(`Error streaming transcript: ${error}`);
    process.exit(0);
  }
}

main();
