#!/usr/bin/env tsx
/**
 * Local Memory Sync Script
 *
 * Thin script entrypoint for memory/context sync hook behavior.
 */

import { createDebugLogger } from './framework/index.js';
import { createSyncLocalMemoryUseCase } from './application/composition/sync-local-memory-composition.js';

const debug = createDebugLogger('sync');

async function main(): Promise<void> {
  const projectDir = process.cwd();

  try {
    const useCase = createSyncLocalMemoryUseCase(debug);
    const result = await useCase.execute(projectDir);
    if (result.shouldOutput && result.output) {
      console.log(result.output);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    console.error(`Error syncing local memory: ${errorMessage}`);
    process.exit(1);
  }
}

main();
