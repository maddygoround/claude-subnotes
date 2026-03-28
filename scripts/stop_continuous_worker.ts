#!/usr/bin/env npx tsx
/**
 * Stop Continuous Worker - Cleanup Script
 *
 * Stops the continuous worker for the current session.
 * Reads hook input, resolves session PID file, sends SIGTERM, and cleans up.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  readHookInputStrict,
  createFileLogger,
} from './framework/index.js';
import {
  getContinuousWorkerPidFile,
  getTempStateDir,
  cleanupStaleContinuousWorkerArtifacts,
} from './conversation_utils.js';

/**
 * Hook input fields we care about.
 */
interface StopHookInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
  reason?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

const LOG_FILE = path.join(getTempStateDir(), 'stop_continuous_worker.log');
const log = createFileLogger(LOG_FILE);

function readPidFile(pidFilePath: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFilePath, 'utf-8').trim(), 10);
    return Number.isNaN(pid) || pid <= 0 ? null : pid;
  } catch {
    return null;
  }
}

function removePidFileIfMatches(
  pidFilePath: string,
  expectedPid: number,
): void {
  if (!fs.existsSync(pidFilePath)) {
    return;
  }

  const currentPid = readPidFile(pidFilePath);
  if (currentPid === null) {
    fs.unlinkSync(pidFilePath);
    log(`Removed unreadable PID file: ${pidFilePath}`);
    return;
  }

  if (currentPid !== expectedPid) {
    log(
      `Skipping PID file removal for ${pidFilePath}; ownership moved to PID ${currentPid}`,
    );
    return;
  }

  fs.unlinkSync(pidFilePath);
  log(`Removed PID file: ${pidFilePath}`);
}

function shouldStopOnHook(input: StopHookInput): boolean {
  // We only terminate workers on explicit SessionEnd events.
  if (input.hook_event_name !== 'SessionEnd') {
    log(
      `Ignoring hook event ${String(input.hook_event_name || 'unknown')} (expected SessionEnd)`,
    );
    return false;
  }
  return true;
}

function stopContinuousWorker(sessionId: string, cwd: string): void {
  const pidFilePaths = [
    getContinuousWorkerPidFile(sessionId, cwd),
    path.join(getTempStateDir(), `continuous-worker-${sessionId}.pid`),
  ];

  for (const pidFilePath of pidFilePaths) {
    if (!fs.existsSync(pidFilePath)) {
      continue;
    }

    let pid: number | null = null;
    try {
      pid = readPidFile(pidFilePath);

      if (pid === null) {
        fs.unlinkSync(pidFilePath);
        log(`Removed invalid PID file: ${pidFilePath}`);
        continue;
      }

      process.kill(pid, 'SIGTERM');
      log(`Stopped continuous worker for session ${sessionId} (PID ${pid})`);
    } catch (error: unknown) {
      const killError = error as { code?: string };
      if (killError.code !== 'ESRCH') {
        log(`Error stopping continuous worker for session ${sessionId}: ${String(error)}`);
      }
    } finally {
      if (pid !== null) {
        removePidFileIfMatches(pidFilePath, pid);
      }
    }
  }
}

async function main(): Promise<void> {
  log('='.repeat(60));
  const hookInput = await readHookInputStrict<StopHookInput>();
  log(
    `Hook input received: event=${String(
      hookInput.hook_event_name || 'unknown',
    )}, reason=${String(hookInput.reason || 'n/a')}`,
  );

  if (!shouldStopOnHook(hookInput)) {
    return;
  }

  const sessionId = hookInput.session_id;
  const cwd = hookInput.cwd;
  if (!sessionId || !cwd) {
    log('Missing session_id or cwd in SessionEnd hook input; skipping stop');
    return;
  }

  stopContinuousWorker(sessionId, cwd);
  cleanupStaleContinuousWorkerArtifacts(log);
}

main().catch((error) => {
  log(`Fatal error in stop_continuous_worker.ts: ${String(error)}`);
  process.exit(1);
});
