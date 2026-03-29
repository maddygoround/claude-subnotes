#!/usr/bin/env tsx
/**
 * Stream Transcript Hook
 *
 * Appends transcript entries to the continuous transcript file.
 * Called by UserPromptSubmit and PostToolUse hooks to stream conversation data
 * to the continuous agent.
 *
 * Also updates Sentinel state (System 5) on PostToolUse events
 * for real-time thrashing/loop detection.
 */

import { readHookInput } from './framework/index.js';
import {
  appendTranscriptEntry,
  TranscriptEntry,
  getMode,
  getSdkToolsMode,
  ensureContinuousWorker,
  isAutonomicEnabled,
  loadConfig,
  mirrorClaudeTranscript,
} from './conversation_utils.js';
import {
  loadSentinelState,
  updateSentinelState,
  saveSentinelState,
} from './framework/sentinel.js';

interface StreamHookInput {
  session_id: string;
  cwd: string;
  prompt?: string;
  response?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  transcript_path?: string;
  hook_event_name?: string;
}

function buildSentinelEventContent(warningTypes: string[]): string {
  const warnings = warningTypes
    .map((warningType) => `<warning>${warningType}</warning>`)
    .join('\n');

  return `<sentinel_event>\n${warnings}\n</sentinel_event>`;
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
  const hookInput = await readHookInput<StreamHookInput>();

  try {
    if (!hookInput?.session_id || !hookInput?.cwd) {
      process.exit(0);
    }

    const mode = getMode(hookInput.cwd);
    if (mode === 'off') {
      process.exit(0);
    }

    // Auto-heal: keep a worker running for this session even if it exited unexpectedly.
    ensureContinuousWorker(
      hookInput.session_id,
      hookInput.cwd,
      getSdkToolsMode(hookInput.cwd),
    );

    const eventName = hookInput.hook_event_name || 'Unknown';
    if (hookInput.transcript_path) {
      mirrorClaudeTranscript(
        hookInput.cwd,
        hookInput.session_id,
        hookInput.transcript_path,
      );
    } else {
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
    }

    // Update Sentinel state on PostToolUse events (System 5)
    if (
      eventName === 'PostToolUse' &&
      isAutonomicEnabled(hookInput.cwd) &&
      hookInput.tool_name
    ) {
      try {
        const config = loadConfig(hookInput.cwd);
        const sentinelState = loadSentinelState(hookInput.session_id);
        const pendingObservationWarnings = [
          ...(sentinelState.pending_observation_warnings || []),
        ];
        const updatedState = updateSentinelState(
          sentinelState,
          hookInput.tool_name,
          hookInput.tool_input,
          hookInput.tool_response,
          config,
        );
        updatedState.pending_observation_warnings = [];
        saveSentinelState(hookInput.session_id, updatedState);

        if (pendingObservationWarnings.length > 0) {
          appendTranscriptEntry(hookInput.cwd, hookInput.session_id, {
            timestamp: new Date().toISOString(),
            role: 'system',
            content: buildSentinelEventContent(pendingObservationWarnings),
          });
        }
      } catch {
        // Sentinel updates are best-effort — never break the hook
      }
    }
  } catch (error) {
    // Fail silently - don't break hooks
    console.error(`Error streaming transcript: ${error}`);
    process.exit(0);
  }
}

main();
