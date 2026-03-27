/**
 * Memory Diff Framework
 *
 * Shared memory block change detection and formatting.
 * Used by pretool_sync.ts and sync_local_memory.ts.
 */

import { MemoryBlock, escapeXmlContent } from '../conversation_utils.js';

// ============================================
// Change Detection
// ============================================

/**
 * Detect which memory blocks have changed since the last sync.
 * Returns an empty array if there's no previous state to compare against.
 */
export function detectChangedBlocks(
  currentBlocks: MemoryBlock[],
  lastBlockValues: { [label: string]: string } | null,
): MemoryBlock[] {
  if (!lastBlockValues) {
    return [];
  }

  return currentBlocks.filter((block) => {
    const previousValue = lastBlockValues[block.label];
    return previousValue === undefined || previousValue !== block.value;
  });
}

// ============================================
// Line-Level Diff
// ============================================

export interface LineDiff {
  added: string[];
  removed: string[];
}

/**
 * Compute a simple line-level diff between two strings.
 */
export function computeDiff(oldValue: string, newValue: string): LineDiff {
  const oldLines = oldValue.split('\n').map((l) => l.trim()).filter((l) => l);
  const newLines = newValue.split('\n').map((l) => l.trim()).filter((l) => l);

  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  return {
    added: newLines.filter((line) => !oldSet.has(line)),
    removed: oldLines.filter((line) => !newSet.has(line)),
  };
}

// ============================================
// Formatting
// ============================================

/**
 * Format changed blocks as XML for hook stdout output.
 * Used by both pretool_sync and sync_local_memory.
 *
 * @param changedBlocks  Blocks that have changed
 * @param lastBlockValues  Previous block values for diff computation
 * @param wrapInUpdateTag  If true, wraps output in <subnotes_memory_update> (used by sync_local_memory)
 */
export function formatChangedBlocksAsXml(
  changedBlocks: MemoryBlock[],
  lastBlockValues: { [label: string]: string } | null,
  wrapInUpdateTag: boolean = true,
): string {
  if (changedBlocks.length === 0) {
    return '';
  }

  const formatted = changedBlocks
    .map((block) => {
      const previousValue = lastBlockValues?.[block.label];

      // New block
      if (previousValue === undefined) {
        const escapedContent = escapeXmlContent(block.value || '');
        return `<${block.label} status="new">\n${escapedContent}\n</${block.label}>`;
      }

      // Modified block — compute diff
      const diff = computeDiff(previousValue, block.value || '');

      if (diff.added.length === 0 && diff.removed.length === 0) {
        const escapedContent = escapeXmlContent(block.value || '');
        return `<${block.label} status="modified">\n${escapedContent}\n</${block.label}>`;
      }

      const diffLines: string[] = [];
      for (const line of diff.removed) {
        diffLines.push(`- ${escapeXmlContent(line)}`);
      }
      for (const line of diff.added) {
        diffLines.push(`+ ${escapeXmlContent(line)}`);
      }

      return `<${block.label} status="modified">\n${diffLines.join('\n')}\n</${block.label}>`;
    })
    .join('\n');

  if (wrapInUpdateTag) {
    return `<subnotes_memory_update>\n<!-- Memory blocks updated since last prompt (showing diff) -->\n${formatted}\n</subnotes_memory_update>`;
  }

  return `<subnotes_memory_update>\n${formatted}\n</subnotes_memory_update>`;
}

/**
 * Snapshot current block values into a label→value map (for state persistence).
 */
export function snapshotBlockValues(
  blocks: MemoryBlock[],
): { [label: string]: string } {
  const snapshot: { [label: string]: string } = {};
  for (const block of blocks) {
    snapshot[block.label] = block.value;
  }
  return snapshot;
}
