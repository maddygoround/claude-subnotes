#!/usr/bin/env npx tsx
/**
 * Stop Continuous Worker - Cleanup Script
 *
 * Stops the continuous worker for the current session.
 * Reads hook input, resolves session PID file, sends SIGTERM, and cleans up.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readHookInputStrict } from './framework/index.js';
import {
  getContinuousWorkerPidFile,
  getTempStateDir,
} from './conversation_utils.js';

/**
 * Hook input fields we care about.
 */
interface StopHookInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
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

    try {
      const pidStr = fs.readFileSync(pidFilePath, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);

      if (isNaN(pid)) {
        fs.unlinkSync(pidFilePath);
        continue;
      }

      process.kill(pid, 'SIGTERM');
      console.log(`Stopped continuous worker for session ${sessionId} (PID ${pid})`);
    } catch (error: unknown) {
      const killError = error as { code?: string };
      if (killError.code !== 'ESRCH') {
        console.error(`Error stopping continuous worker for session ${sessionId}:`, error);
      }
    } finally {
      if (fs.existsSync(pidFilePath)) {
        fs.unlinkSync(pidFilePath);
      }
    }
  }
}

async function main(): Promise<void> {
  const hookInput = await readHookInputStrict<StopHookInput>();
  stopContinuousWorker(hookInput.session_id, hookInput.cwd);
}

main().catch((error) => {
  console.error('Error in stop_continuous_worker.ts:', error);
  process.exit(1);
});
