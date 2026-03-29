#!/usr/bin/env npx tsx
/**
 * Stop Continuous Worker - Cleanup Script
 *
 * Thin script entrypoint for SessionEnd worker teardown.
 */

import * as path from 'path';
import { createFileLogger } from './framework/index.js';
import { getTempStateDir } from './conversation_utils.js';
import { createStopContinuousWorkerUseCase } from './application/composition/stop-continuous-worker-composition.js';

const LOG_FILE = path.join(getTempStateDir(), 'stop_continuous_worker.log');
const log = createFileLogger(LOG_FILE);

async function main(): Promise<void> {
  try {
    const useCase = createStopContinuousWorkerUseCase(log);
    await useCase.execute();
  } catch (error) {
    log(`Fatal error in stop_continuous_worker.ts: ${String(error)}`);
    process.exit(1);
  }
}

main();
