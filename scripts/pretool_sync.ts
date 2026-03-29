#!/usr/bin/env tsx
/**
 * PreToolUse Gating Layer
 *
 * Thin script entrypoint:
 * - resolves the use-case from composition
 * - executes it
 * - writes hook output when needed
 */

import { createDebugLogger } from './framework/index.js';
import { createPreToolSyncUseCase } from './application/composition/pretool-sync-composition.js';

const debug = createDebugLogger('pretool');

async function main(): Promise<void> {
  try {
    const useCase = createPreToolSyncUseCase(debug);
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
