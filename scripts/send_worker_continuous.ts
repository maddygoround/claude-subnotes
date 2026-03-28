#!/usr/bin/env npx tsx
/**
 * Continuous Background Worker - Long-Running Subconscious Agent
 *
 * Unlike the legacy one-shot worker pattern, this worker runs
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
import { withProcessLock } from './state_store.js';
import {
  loadLocalMemory,
  saveLocalMemory,
  MemoryBlock,
  SdkToolsMode,
  getTempStateDir,
  getContinuousTranscriptPath,
  getContinuousWorkerPidFile,
  getSubconsciousSystemPrompt,
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

interface TranscriptReadResult {
  newEntries: TranscriptEntry[];
  latestIndex: number;
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
): TranscriptReadResult {
  if (!fs.existsSync(transcriptPath)) {
    return { newEntries: [], latestIndex: -1 };
  }

  const content = fs.readFileSync(transcriptPath, 'utf-8').trim();
  if (!content) {
    return { newEntries: [], latestIndex: -1 };
  }

  const lines = content.split('\n');
  const newEntries: TranscriptEntry[] = [];
  const latestIndex = lines.length - 1;

  for (let i = lastProcessedIndex + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      newEntries.push(JSON.parse(lines[i]));
    } catch (e) {
      log(`Failed to parse transcript line ${i}: ${e}`);
    }
  }

  return { newEntries, latestIndex };
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

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === 'EPERM';
  }
}

function readPidFile(pidFile: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    return Number.isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

function claimPidFile(sessionId: string, cwd: string): boolean {
  const pidFile = getPidFilePath(sessionId, cwd);
  return withProcessLock(
    `${pidFile}.claim.lock`,
    () => {
      const existingPid = readPidFile(pidFile);
      if (existingPid !== null && isProcessRunning(existingPid)) {
        log(
          `Another continuous worker already owns ${pidFile} (PID: ${existingPid}), exiting duplicate worker`,
        );
        return false;
      }

      if (fs.existsSync(pidFile)) {
        try {
          fs.unlinkSync(pidFile);
          log(`Removed stale PID file before claiming: ${pidFile}`);
        } catch (unlinkError) {
          const unlinkErr = unlinkError as NodeJS.ErrnoException;
          if (unlinkErr.code !== 'ENOENT') {
            throw unlinkError;
          }
        }
      }

      fs.writeFileSync(pidFile, `${process.pid}\n`, { flag: 'wx' });
      log(`Claimed PID file: ${pidFile} (PID: ${process.pid})`);
      return true;
    },
    {
      log,
      timeoutMs: 1500,
      staleMs: 15000,
    },
  );
}

function cleanupPidFile(sessionId: string, cwd: string): void {
  const pidFile = getPidFilePath(sessionId, cwd);
  if (!fs.existsSync(pidFile)) {
    return;
  }

  const currentPid = readPidFile(pidFile);
  if (currentPid === null) {
    fs.unlinkSync(pidFile);
    log(`Removed unreadable PID file during cleanup: ${pidFile}`);
    return;
  }

  if (currentPid !== process.pid) {
    log(
      `Skipping PID cleanup for ${pidFile}; ownership moved to PID ${currentPid}`,
    );
    return;
  }

  fs.unlinkSync(pidFile);
  log(`Cleaned up PID file: ${pidFile}`);
}

// ============================================
// Continuation Thought Extraction
// ============================================

interface ContinuationResult {
  text: string;
  continuationReason: string | null;
}

function extractContinuationThought(response: string): ContinuationResult {
  const match = response.match(/<continue_thought>([\s\S]*?)<\/continue_thought>/);
  if (!match) {
    return { text: response, continuationReason: null };
  }
  const continuationReason = match[1].trim();
  const text = response.replace(/<continue_thought>[\s\S]*?<\/continue_thought>/g, '').trim();
  return { text, continuationReason };
}

// ============================================
// System Prompt
// ============================================

function getSdkToolsCapabilityLine(sdkToolsMode: SdkToolsMode): string {
  if (sdkToolsMode === 'full') {
    return 'Tool access mode: full (memory tools + local file reading tools).';
  }
  if (sdkToolsMode === 'off') {
    return 'Tool access mode: off (no file-reading tools; memory tools only).';
  }
  return 'Tool access mode: read-only (memory tools + safe local file reading tools).';
}

function buildSystemPrompt(
  memoryBlocks: MemoryBlock[],
  cwd: string,
  sdkToolsMode: SdkToolsMode,
): string {
  const fallbackSystemPrompt =
    `You are the Subconscious — a persistent agent that whispers to Claude Code.\n\n` +
    `You process transcript updates asynchronously. Use memory blocks to track user preferences, session patterns, project context, pending items, and guidance.\n\n` +
    `Be concise, observational, and useful.`;

  const basePrompt = getSubconsciousSystemPrompt(cwd, fallbackSystemPrompt, log);

  let prompt =
    `${basePrompt}\n\n` +
    `<runtime_context>\n` +
    `You are receiving incremental transcript updates between Claude tool calls and prompts.\n` +
    `${getSdkToolsCapabilityLine(sdkToolsMode)}\n` +
    `You are the subconscious layer, not the foreground assistant.\n` +
    `Do not ask the user questions directly and do not invent visible subagents.\n` +
    `If clarification is needed, frame it as a suggestion for Claude Code or provide a fallback assumption.\n` +
    `If you have a sub-question or follow-up thought that needs resolution before concluding, emit it as <continue_thought>your question or follow-up here</continue_thought> anywhere in your response — the worker will re-invoke you with that as the next input (max 2 continuations). Omit the tag when your thought is complete.\n` +
    `Tool results may include subconscious signals such as clarification_needed, assumption, risk, and boundary. Use them as internal scaffolding for your reasoning.\n` +
    `Update memory only when it adds durable value.\n` +
    `</runtime_context>\n\n` +
    `<response_guidelines>\n` +
    `When you have thoughts or advice for Claude Code, enclose them in one of the following XML tags:\n` +
    `- <reflect>...</reflect>: Use for general observations, noting patterns, summarizing a successful workflow, or updating memory context. This is the default quiet observation.\n` +
    `- <steer>...</steer>: Use when Claude is taking a slightly suboptimal path, violating a project convention, or about to make a minor mistake (but isn't completely stuck). Gently nudges Claude onto the right path.\n` +
    `- <insight>...</insight>: Use ONLY as a high-priority loop breaker when Claude is looping on the same failing error message, entirely misunderstanding the root cause, or pursuing an impossible approach.\n` +
    `You may emit multiple tags if necessary. Only the contents within these tags will be delivered to Claude.\n` +
    `</response_guidelines>\n\n` +
    `Your current memory blocks:\n\n`;

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
  let lastSeenTranscriptIndex = -1;
  let lastActivityAt = Date.now();

  const checkInterval = parseInt(
    process.env.SUBNOTES_CHECK_INTERVAL || '1000',
    10,
  );
  const minMessages = parseInt(
    process.env.SUBNOTES_MIN_MESSAGES || '1',
    10,
  );
  const idleTimeoutMs = parseInt(
    process.env.SUBNOTES_IDLE_TIMEOUT || '1800000',
    10,
  );

  log('Starting continuous loop...');
  log(`Check interval: ${checkInterval}ms`);
  log(`Min messages before processing: ${minMessages}`);
  if (idleTimeoutMs > 0) {
    log(`Idle timeout: ${idleTimeoutMs}ms`);
  } else {
    log('Idle timeout: disabled');
  }
  log(`Transcript path: ${transcriptPath}`);

  while (!shouldExit) {
    try {
      const { newEntries, latestIndex } = readNewTranscriptEntries(
        transcriptPath,
        lastProcessedIndex,
      );

      if (latestIndex !== lastSeenTranscriptIndex) {
        lastSeenTranscriptIndex = latestIndex;
        lastActivityAt = Date.now();
      }

      if (newEntries.length >= minMessages) {
        log(`Processing ${newEntries.length} new transcript entries...`);

        let memoryBlocks = loadLocalMemory(payload.cwd, log);
        let baseMemoryBlocks = memoryBlocks.map((block) => ({ ...block }));

        const transcriptText = formatTranscriptForAgent(newEntries);
        const maxContinuations = parseInt(
          process.env.SUBNOTES_MAX_CONTINUATIONS || '2',
          10,
        );

        let currentUserMessage = `${transcriptText}

Process these new messages. Update memory blocks if you observe patterns, preferences, or important context. Write to guidance only if you have something useful to surface.`;
        let finalResponse = '';

        for (let continuation = 0; continuation <= maxContinuations; continuation++) {
          const result = await runAgentLoop(
            {
              cwd: payload.cwd,
              sdkToolsMode: payload.sdkToolsMode,
              systemPromptBuilder: () =>
                buildSystemPrompt(memoryBlocks, payload.cwd, payload.sdkToolsMode),
              userMessage: currentUserMessage,
              log,
            },
            memoryBlocks,
          );

          memoryBlocks = result.memoryBlocks;

          if (result.memoriesUpdated) {
            saveLocalMemory(payload.cwd, memoryBlocks, log, {
              baseBlocks: baseMemoryBlocks,
            });
            baseMemoryBlocks = memoryBlocks.map((block) => ({ ...block }));
            log('✓ Saved updated memory blocks');
          }

          const { text: cleanResponse, continuationReason } =
            extractContinuationThought(result.assistantResponse);
          finalResponse = cleanResponse;

          if (!continuationReason || continuation >= maxContinuations) {
            if (continuationReason && continuation >= maxContinuations) {
              log(`↩ Max continuations reached (${maxContinuations}), concluding thought`);
            }
            break;
          }

          log(`↩ Self-continuing thought (${continuation + 1}/${maxContinuations}): ${continuationReason.slice(0, 120)}`);
          currentUserMessage = `Continuing your own thought from the previous cycle:\n\n"${continuationReason}"\n\nResolve this and conclude. If still unresolved and essential, you may continue once more.`;
        }

        if (finalResponse.trim()) {
          const typeRegex = /<(reflect|steer|insight)>([\s\S]*?)<\/\1>/g;
          let match;
          let foundAny = false;
          
          while ((match = typeRegex.exec(finalResponse)) !== null) {
            foundAny = true;
            const msgType = match[1] as 'reflect' | 'steer' | 'insight';
            const msgContent = match[2].trim();
            if (msgContent) {
              appendAgentMessage(payload.cwd, msgContent, log, msgType);
              log(`✓ Appended agent message of type <${msgType}>`);
            }
          }
          
          // Fallback if the agent ignores the prompt instructions and just dumps plain text
          if (!foundAny && finalResponse.trim()) {
            appendAgentMessage(payload.cwd, finalResponse.trim(), log, 'reflect');
            log('✓ Appended fallback agent message (no tags found)');
          }
        }

        lastProcessedIndex = latestIndex;
        log(`✓ Processed up to index ${lastProcessedIndex}`);
      }

      if (
        idleTimeoutMs > 0 &&
        Date.now() - lastActivityAt >= idleTimeoutMs
      ) {
        log(
          `Idle timeout reached (${idleTimeoutMs}ms without transcript changes), exiting worker`,
        );
        break;
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

    if (!claimPidFile(payload.sessionId, payload.cwd)) {
      if (fs.existsSync(payloadFile)) {
        fs.unlinkSync(payloadFile);
      }
      log('Duplicate worker exited before processing payload');
      return;
    }

    // Ensure cleanup on exit
    process.on('exit', () => cleanupPidFile(payload.sessionId, payload.cwd));

    // Start continuous processing
    await continuousLoop(payload);

    // Cleanup
    if (fs.existsSync(payloadFile)) {
      fs.unlinkSync(payloadFile);
      log('Cleaned up payload file');
    }
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
