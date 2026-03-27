#!/usr/bin/env npx tsx
/**
 * Stop Continuous Worker - Cleanup Script
 *
 * Gracefully stops the continuous worker process on session end.
 * Reads PID file, sends SIGTERM, and cleans up.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getTempStateDir } from './conversation_utils.js';

const TEMP_STATE_DIR = getTempStateDir();

/**
 * Find and stop all continuous worker processes for this session
 */
function stopContinuousWorkers(): void {
  if (!fs.existsSync(TEMP_STATE_DIR)) {
    // No temp directory = no workers running
    return;
  }

  const files = fs.readdirSync(TEMP_STATE_DIR);
  const pidFiles = files.filter(f => f.startsWith('continuous-worker-') && f.endsWith('.pid'));

  if (pidFiles.length === 0) {
    // No PID files = no workers to stop
    return;
  }

  for (const pidFile of pidFiles) {
    const pidFilePath = path.join(TEMP_STATE_DIR, pidFile);

    try {
      const pidStr = fs.readFileSync(pidFilePath, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);

      if (isNaN(pid)) {
        console.error(`Invalid PID in ${pidFile}: ${pidStr}`);
        fs.unlinkSync(pidFilePath); // Clean up invalid PID file
        continue;
      }

      // Check if process exists and send SIGTERM
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`✓ Sent SIGTERM to continuous worker (PID ${pid})`);

        // Give it a moment to clean up its own PID file
        setTimeout(() => {
          // If PID file still exists after 1 second, remove it manually
          if (fs.existsSync(pidFilePath)) {
            fs.unlinkSync(pidFilePath);
            console.log(`✓ Cleaned up PID file: ${pidFile}`);
          }
        }, 1000);

      } catch (killError: any) {
        if (killError.code === 'ESRCH') {
          // Process doesn't exist - just clean up the stale PID file
          fs.unlinkSync(pidFilePath);
          console.log(`✓ Removed stale PID file: ${pidFile}`);
        } else {
          throw killError;
        }
      }

    } catch (error) {
      console.error(`Error stopping worker from ${pidFile}:`, error);
      // Try to clean up the PID file anyway
      try {
        fs.unlinkSync(pidFilePath);
      } catch (unlinkError) {
        // Ignore cleanup errors
      }
    }
  }
}

// Run cleanup
try {
  stopContinuousWorkers();
} catch (error) {
  console.error('Error in stop_continuous_worker.ts:', error);
  process.exit(1);
}
