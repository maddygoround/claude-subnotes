#!/usr/bin/env npx tsx
/**
 * Local background worker that acts as the Subconscious agent.
 * Powered by Anthropic SDK via the framework agent loop.
 *
 * Spawned by send_messages_to_local.ts as a detached process.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  createFileLogger,
  runAgentLoop,
  appendAgentMessage,
} from './framework/index.js';
import {
  loadLocalMemory,
  saveLocalMemory,
  MemoryBlock,
  getTempStateDir,
} from './conversation_utils.js';

const TEMP_STATE_DIR = getTempStateDir();
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_worker_local.log');
const log = createFileLogger(LOG_FILE);

interface LocalPayload {
  sessionId: string;
  message: string;
  stateFile: string;
  newLastProcessedIndex: number;
  cwd: string;
  sdkToolsMode: 'read-only' | 'full' | 'off';
}

/**
 * Build the system prompt from current memory blocks.
 */
function buildSystemPrompt(memoryBlocks: MemoryBlock[]): string {
  let prompt =
    "You are Subconscious, a persistent agent that whispers to Claude Code and maintains ongoing memory blocks across sessions.\n\n";
  prompt += "Your current memory blocks:\n\n";
  for (const block of memoryBlocks) {
    prompt += `<${block.label} description="${block.description}">\n${block.value}\n</${block.label}>\n\n`;
  }
  return prompt;
}

async function main(): Promise<void> {
  const payloadFile = process.argv[2];

  if (!payloadFile) {
    log('ERROR: No payload file specified');
    process.exit(1);
  }

  log('='.repeat(60));
  log(`Local Worker started with payload: ${payloadFile}`);

  try {
    if (!fs.existsSync(payloadFile)) {
      log(`ERROR: Payload file not found: ${payloadFile}`);
      process.exit(1);
    }

    const payload: LocalPayload = JSON.parse(
      fs.readFileSync(payloadFile, 'utf-8'),
    );
    log(`Loaded payload for session ${payload.sessionId}`);

    let memoryBlocks = loadLocalMemory(payload.cwd);

    const result = await runAgentLoop(
      {
        cwd: payload.cwd,
        sdkToolsMode: payload.sdkToolsMode,
        systemPromptBuilder: () => buildSystemPrompt(memoryBlocks),
        userMessage: payload.message,
        log,
      },
      memoryBlocks,
    );

    memoryBlocks = result.memoryBlocks;

    if (result.memoriesUpdated) {
      saveLocalMemory(payload.cwd, memoryBlocks);
      log('Saved updated memory blocks to disk');
    }

    if (result.assistantResponse.trim()) {
      appendAgentMessage(payload.cwd, result.assistantResponse, log);
    }

    // Update state file
    if (fs.existsSync(payload.stateFile)) {
      const state = JSON.parse(fs.readFileSync(payload.stateFile, 'utf-8'));
      state.lastProcessedIndex = payload.newLastProcessedIndex;
      fs.writeFileSync(
        payload.stateFile,
        JSON.stringify(state, null, 2),
      );
      log(
        `Updated state: lastProcessedIndex=${payload.newLastProcessedIndex}`,
      );
    }

    fs.unlinkSync(payloadFile);
    log('Cleaned up payload file');
    log('Local Worker completed successfully');
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
      log(`Stack: ${error.stack}`);
    }
    process.exit(1);
  }
}

main();
