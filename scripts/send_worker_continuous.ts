#!/usr/bin/env npx tsx
/**
 * Continuous Background Worker - Long-Running Subconscious Agent
 *
 * Unlike send_worker_local.ts (which runs once on Stop), this worker runs
 * continuously throughout the session, watching for new transcript entries
 * and updating memory in real-time.
 *
 * This enables PreToolUse to inject fresh analysis mid-conversation.
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
  getContinuousTranscriptPath,
  getContinuousWorkerPidFile,
} from './conversation_utils.js';

const TEMP_STATE_DIR = getTempStateDir();
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_worker_continuous.log');
const log = createFileLogger(LOG_FILE);

interface ContinuousPayload {
  sessionId: string;
  cwd: string;
  sdkToolsMode: 'read-only' | 'full' | 'off';
}

interface TranscriptEntry {
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// Graceful shutdown handling
let shouldExit = false;
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down gracefully...');
  shouldExit = true;
});
process.on('SIGINT', () => {
  log('Received SIGINT, shutting down gracefully...');
  shouldExit = true;
});

// ============================================
// Transcript Reading
// ============================================

function readNewTranscriptEntries(
  transcriptPath: string,
  lastProcessedIndex: number,
): TranscriptEntry[] {
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }

  const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n');
  const newEntries: TranscriptEntry[] = [];

  for (let i = lastProcessedIndex + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      newEntries.push(JSON.parse(lines[i]));
    } catch (e) {
      log(`Failed to parse transcript line ${i}: ${e}`);
    }
  }

  return newEntries;
}

function formatTranscriptForAgent(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return '';

  const messages = entries
    .map((entry, idx) => {
      const role = entry.role === 'user'
        ? 'User'
        : entry.role === 'assistant'
          ? 'Claude Code'
          : 'System';
      return `<message index="${idx}" role="${role}" timestamp="${entry.timestamp}">\n${entry.content}\n</message>`;
    })
    .join('\n\n');

  return `<transcript_update>\nNew messages since last check:\n\n${messages}\n</transcript_update>`;
}

// ============================================
// PID Management
// ============================================

function getPidFilePath(sessionId: string, cwd: string): string {
  return getContinuousWorkerPidFile(sessionId, cwd);
}

function writePidFile(sessionId: string, cwd: string): void {
  const pidFile = getPidFilePath(sessionId, cwd);
  fs.writeFileSync(pidFile, process.pid.toString());
  log(`Wrote PID file: ${pidFile} (PID: ${process.pid})`);
}

function cleanupPidFile(sessionId: string, cwd: string): void {
  const pidFile = getPidFilePath(sessionId, cwd);
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
    log(`Cleaned up PID file: ${pidFile}`);
  }
}

// ============================================
// System Prompt
// ============================================

function buildSystemPrompt(memoryBlocks: MemoryBlock[]): string {
  let prompt = `You are Subconscious, a continuous agent watching Claude Code sessions in real-time.

You receive incremental transcript updates and maintain memory blocks. Process new messages and update memory when you observe:
- User preferences or patterns
- Project context and architecture
- Pending items or unfinished work
- Important guidance for Claude Code

Keep updates concise. Only write to guidance when you have something genuinely useful.

Your current memory blocks:

`;
  for (const block of memoryBlocks) {
    prompt += `<${block.label} description="${block.description}">\n${block.value}\n</${block.label}>\n\n`;
  }
  return prompt;
}

// ============================================
// Main Continuous Loop
// ============================================

async function continuousLoop(payload: ContinuousPayload): Promise<void> {
  const transcriptPath = getContinuousTranscriptPath(
    payload.cwd,
    payload.sessionId,
  );
  let lastProcessedIndex = -1;

  const checkInterval = parseInt(
    process.env.SUBNOTES_CHECK_INTERVAL || '5000',
    10,
  );
  const minMessages = parseInt(
    process.env.SUBNOTES_MIN_MESSAGES || '1',
    10,
  );

  log('Starting continuous loop...');
  log(`Check interval: ${checkInterval}ms`);
  log(`Min messages before processing: ${minMessages}`);
  log(`Transcript path: ${transcriptPath}`);

  while (!shouldExit) {
    try {
      const newEntries = readNewTranscriptEntries(
        transcriptPath,
        lastProcessedIndex,
      );

      if (newEntries.length >= minMessages) {
        log(`Processing ${newEntries.length} new transcript entries...`);

        let memoryBlocks = loadLocalMemory(payload.cwd);

        const transcriptText = formatTranscriptForAgent(newEntries);
        const userMessage = `${transcriptText}

Process these new messages. Update memory blocks if you observe patterns, preferences, or important context. Write to guidance only if you have something useful to surface.`;

        const result = await runAgentLoop(
          {
            cwd: payload.cwd,
            sdkToolsMode: payload.sdkToolsMode,
            systemPromptBuilder: () => buildSystemPrompt(memoryBlocks),
            userMessage,
            log,
          },
          memoryBlocks,
        );

        memoryBlocks = result.memoryBlocks;

        if (result.memoriesUpdated) {
          saveLocalMemory(payload.cwd, memoryBlocks);
          log('✓ Saved updated memory blocks');
        }

        if (result.assistantResponse.trim()) {
          appendAgentMessage(
            payload.cwd,
            result.assistantResponse,
            log,
          );
          log('✓ Appended agent message');
        }

        lastProcessedIndex += newEntries.length;
        log(`✓ Processed up to index ${lastProcessedIndex}`);
      }

      // Sleep before next check
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    } catch (error) {
      log(`Error in continuous loop: ${error}`);
      await new Promise((resolve) =>
        setTimeout(resolve, checkInterval * 2),
      );
    }
  }

  log('Continuous loop exited gracefully');
}

async function main(): Promise<void> {
  const payloadFile = process.argv[2];

  if (!payloadFile) {
    log('ERROR: No payload file specified');
    process.exit(1);
  }

  log('='.repeat(60));
  log(`Continuous Worker started with payload: ${payloadFile}`);

  try {
    if (!fs.existsSync(payloadFile)) {
      log(`ERROR: Payload file not found: ${payloadFile}`);
      process.exit(1);
    }

    const payload: ContinuousPayload = JSON.parse(
      fs.readFileSync(payloadFile, 'utf-8'),
    );
    log(`Loaded payload for session ${payload.sessionId}`);

    // Write PID file for process management
    writePidFile(payload.sessionId, payload.cwd);

    // Ensure cleanup on exit
    process.on('exit', () => cleanupPidFile(payload.sessionId, payload.cwd));

    // Start continuous processing
    await continuousLoop(payload);

    // Cleanup
    fs.unlinkSync(payloadFile);
    log('Cleaned up payload file');
    log('Continuous Worker shut down successfully');
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
