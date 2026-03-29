import type {
  MemoryBlock,
  SyncState,
} from '../../conversation_utils.js';

export function cloneMemoryBlock(block: MemoryBlock): MemoryBlock {
  return {
    label: block.label,
    description: block.description,
    value: block.value,
  };
}

export function cloneMemoryBlocks(blocks: MemoryBlock[]): MemoryBlock[] {
  return blocks.map(cloneMemoryBlock);
}

function isMemoryBlock(value: unknown): value is MemoryBlock {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<MemoryBlock>;
  return (
    typeof candidate.label === 'string' &&
    typeof candidate.description === 'string' &&
    typeof candidate.value === 'string'
  );
}

export function coerceMemoryBlocks(data: unknown): MemoryBlock[] | null {
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const blocks = data.filter(isMemoryBlock).map(cloneMemoryBlock);
  return blocks.length > 0 ? blocks : null;
}

export function parseSyncStateData(
  data: unknown,
  fallbackSessionId: string,
): SyncState | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const candidate = data as Partial<SyncState>;
  if (typeof candidate.lastProcessedIndex !== 'number') {
    return null;
  }

  const parsed: SyncState = {
    lastProcessedIndex: candidate.lastProcessedIndex,
    sessionId:
      typeof candidate.sessionId === 'string' && candidate.sessionId.trim()
        ? candidate.sessionId
        : fallbackSessionId,
  };

  if (
    candidate.lastBlockValues &&
    typeof candidate.lastBlockValues === 'object'
  ) {
    const entries = Object.entries(candidate.lastBlockValues).filter(
      ([label, value]) => typeof label === 'string' && typeof value === 'string',
    );
    if (entries.length > 0) {
      parsed.lastBlockValues = Object.fromEntries(entries);
    }
  }

  if (
    typeof candidate.lastSeenMessageId === 'string' &&
    candidate.lastSeenMessageId.trim()
  ) {
    parsed.lastSeenMessageId = candidate.lastSeenMessageId;
  }

  if (typeof candidate.lastMirroredTranscriptLine === 'number') {
    parsed.lastMirroredTranscriptLine = candidate.lastMirroredTranscriptLine;
  }

  if (
    candidate.pendingToolUses &&
    typeof candidate.pendingToolUses === 'object'
  ) {
    const pendingEntries = Object.entries(candidate.pendingToolUses)
      .filter(([toolUseId, value]) => {
        if (!toolUseId || !value || typeof value !== 'object') {
          return false;
        }
        const candidateValue = value as {
          name?: unknown;
          input?: unknown;
          timestamp?: unknown;
        };
        return (
          typeof candidateValue.name === 'string' &&
          typeof candidateValue.timestamp === 'string'
        );
      })
      .map(([toolUseId, value]) => {
        const candidateValue = value as {
          name: string;
          input?: unknown;
          timestamp: string;
        };
        return [
          toolUseId,
          {
            name: candidateValue.name,
            input: candidateValue.input,
            timestamp: candidateValue.timestamp,
          },
        ] as const;
      });

    if (pendingEntries.length > 0) {
      parsed.pendingToolUses = Object.fromEntries(pendingEntries);
    }
  }

  return parsed;
}

function diffMemoryBlocks(
  baseBlocks: MemoryBlock[],
  updatedBlocks: MemoryBlock[],
): { touchedLabels: Set<string>; deletedLabels: Set<string> } {
  const baseByLabel = new Map(baseBlocks.map((block) => [block.label, block]));
  const updatedByLabel = new Map(
    updatedBlocks.map((block) => [block.label, block]),
  );
  const touchedLabels = new Set<string>();
  const deletedLabels = new Set<string>();
  const labels = new Set([
    ...baseByLabel.keys(),
    ...updatedByLabel.keys(),
  ]);

  for (const label of labels) {
    const before = baseByLabel.get(label);
    const after = updatedByLabel.get(label);

    if (!before && after) {
      touchedLabels.add(label);
      continue;
    }

    if (before && !after) {
      deletedLabels.add(label);
      continue;
    }

    if (
      before &&
      after &&
      (before.description !== after.description || before.value !== after.value)
    ) {
      touchedLabels.add(label);
    }
  }

  return { touchedLabels, deletedLabels };
}

export function mergeMemoryBlocks(
  currentBlocks: MemoryBlock[],
  baseBlocks: MemoryBlock[],
  updatedBlocks: MemoryBlock[],
): MemoryBlock[] {
  const { touchedLabels, deletedLabels } = diffMemoryBlocks(
    baseBlocks,
    updatedBlocks,
  );

  if (touchedLabels.size === 0 && deletedLabels.size === 0) {
    return cloneMemoryBlocks(currentBlocks);
  }

  const updatedByLabel = new Map(
    updatedBlocks.map((block) => [block.label, cloneMemoryBlock(block)]),
  );
  const merged: MemoryBlock[] = [];
  const seenLabels = new Set<string>();

  for (const block of currentBlocks) {
    if (deletedLabels.has(block.label)) {
      continue;
    }

    if (touchedLabels.has(block.label)) {
      const replacement = updatedByLabel.get(block.label);
      if (replacement) {
        merged.push(replacement);
        seenLabels.add(block.label);
      }
      continue;
    }

    merged.push(cloneMemoryBlock(block));
    seenLabels.add(block.label);
  }

  for (const block of updatedBlocks) {
    if (!touchedLabels.has(block.label) || seenLabels.has(block.label)) {
      continue;
    }
    merged.push(cloneMemoryBlock(block));
    seenLabels.add(block.label);
  }

  return merged;
}
