#!/usr/bin/env tsx
/**
 * Stream Transcript Hook
 *
 * Thin script entrypoint for transcript ingestion and sentinel side-effects.
 */

import { createStreamTranscriptUseCase } from './application/composition/stream-transcript-composition.js';

async function main(): Promise<void> {
  try {
    const useCase = createStreamTranscriptUseCase();
    await useCase.execute();
  } catch (error) {
    // Fail silently - don't break hooks
    console.error(`Error streaming transcript: ${error}`);
    process.exit(0);
  }
}

main();
