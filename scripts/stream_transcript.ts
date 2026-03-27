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
  getSdkToolsMode,
  ensureContinuousWorker,
} from './conversation_utils.js';

interface StreamHookInput {
  session_id: string;
  cwd: string;
  prompt?: string;
  response?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  hook_event_name?: string;
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function main(): Promise<void> {
  const mode = getMode();
  if (mode === 'off') {
    process.exit(0);
  }

  const hookInput = await readHookInput<StreamHookInput>();

  try {
    if (!hookInput?.session_id || !hookInput?.cwd) {
      process.exit(0);
    }

    // Auto-heal: keep a worker running for this session even if it exited unexpectedly.
    ensureContinuousWorker(
      hookInput.session_id,
      hookInput.cwd,
      getSdkToolsMode(),
    );

    const eventName = hookInput.hook_event_name || 'Unknown';
    let role: 'user' | 'assistant' | 'system' = 'user';
    let content = '';

    if (eventName === 'UserPromptSubmit' && hookInput.prompt) {
      role = 'user';
      content = hookInput.prompt;
    } else if (eventName === 'PostToolUse') {
      role = 'system';
      const toolName = hookInput.tool_name || 'unknown_tool';
      const toolInput = hookInput.tool_input !== undefined
        ? safeStringify(hookInput.tool_input)
        : '(no tool input)';
      const toolResponse = hookInput.tool_response !== undefined
        ? safeStringify(hookInput.tool_response)
        : '(no tool response)';
      content =
        `<tool_event>\n` +
        `<name>${toolName}</name>\n` +
        `<input>\n${toolInput}\n</input>\n` +
        `<response>\n${toolResponse}\n</response>\n` +
        `</tool_event>`;
    } else if (hookInput.response) {
      role = 'assistant';
      content = hookInput.response;
    } else if (hookInput.prompt) {
      role = 'user';
      content = hookInput.prompt;
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
