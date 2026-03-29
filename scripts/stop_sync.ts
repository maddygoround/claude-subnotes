#!/usr/bin/env npx tsx
/**
 * Stop Hook — Subconscious Thought Delivery
 *
 * Thin script entrypoint for stop-gating behavior.
 */

import { createDebugLogger } from './framework/index.js';
import { createStopSyncUseCase } from './application/composition/stop-sync-composition.js';

const debug = createDebugLogger('stop-sync');

async function main(): Promise<void> {
  try {
    const useCase = createStopSyncUseCase(debug);
    const result = await useCase.execute();
    if (result.shouldOutput && result.output) {
      console.log(result.output);
    }
  } catch (error) {
    debug(`Error: ${error}`);
    process.exit(0);
  }
}

main();
