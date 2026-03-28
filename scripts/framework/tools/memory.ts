import type { MemoryBlock } from '../../conversation_utils.js';
import {
  createToolResult,
  defineTool,
  type ToolExecutionResult,
  type ToolHandler,
} from './types.js';

const MAX_MEMORY_BLOCKS = 12;
const MAX_MEMORY_CHARS = 30000;

function getMemoryCharCount(blocks: MemoryBlock[]): number {
  return blocks.reduce((sum, block) => sum + (block.value || '').length, 0);
}

function validateMemoryLimits(blocks: MemoryBlock[]): void {
  if (blocks.length > MAX_MEMORY_BLOCKS) {
    throw new Error(
      `Memory block limit exceeded (${blocks.length}/${MAX_MEMORY_BLOCKS})`,
    );
  }
  const totalChars = getMemoryCharCount(blocks);
  if (totalChars > MAX_MEMORY_CHARS) {
    throw new Error(
      `Memory char limit exceeded (${totalChars}/${MAX_MEMORY_CHARS})`,
    );
  }
}

function parseLabel(pathOrLabel: unknown): string {
  const raw = String(pathOrLabel || '').trim();
  if (!raw) return '';

  let normalized = raw.replace(/^\/+/, '');
  normalized = normalized.replace(/^memories\//, '');
  normalized = normalized.replace(/^memory\//, '');
  normalized = normalized.replace(/^system\//, '');

  const parts = normalized.split('/').filter(Boolean);
  return (parts[parts.length - 1] || '').trim();
}

function findBlockOrThrow(memoryBlocks: MemoryBlock[], label: string): MemoryBlock {
  const block = memoryBlocks.find((b) => b.label === label);
  if (!block) {
    throw new Error(`Block "${label}" not found`);
  }
  return block;
}

interface MemoryMutationOutcome {
  result: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

function applyMemoryMutation(
  memoryBlocks: MemoryBlock[],
  mutate: () => MemoryMutationOutcome,
): ToolExecutionResult {
  const before = memoryBlocks.map((b) => ({ ...b }));
  try {
    const outcome = mutate();
    validateMemoryLimits(memoryBlocks);
    return createToolResult({
      result: outcome.result,
      summary: outcome.summary,
      metadata: outcome.metadata,
      memoryUpdated: true,
    });
  } catch (error) {
    memoryBlocks.splice(0, memoryBlocks.length, ...before);
    throw error;
  }
}

function executeMemoryReplace(
  input: Record<string, unknown>,
  memoryBlocks: MemoryBlock[],
): ToolExecutionResult {
  return applyMemoryMutation(memoryBlocks, () => {
    const label = parseLabel(input.label);
    const oldText = String(input.old_text ?? input.old_str ?? '');
    const newText = String(input.new_text ?? input.new_str ?? '');

    if (!label || !oldText) {
      throw new Error('memory_replace requires label and old_text/old_str');
    }

    const block = findBlockOrThrow(memoryBlocks, label);
    if (!block.value.includes(oldText)) {
      throw new Error(`old_text not found in "${label}"`);
    }

    block.value = block.value.replace(oldText, newText);
    return {
      result: `Successfully replaced text in ${label}`,
      summary: `Updated memory block ${label}`,
      metadata: {
        label,
        operation: 'replace',
      },
    };
  });
}

function executeMemoryInsert(
  input: Record<string, unknown>,
  memoryBlocks: MemoryBlock[],
): ToolExecutionResult {
  return applyMemoryMutation(memoryBlocks, () => {
    const label = parseLabel(input.label);
    const text = String(
      input.text_to_append ?? input.new_str ?? input.insert_text ?? '',
    );
    const insertLineRaw = Number(input.insert_line);
    const insertLine = Number.isFinite(insertLineRaw) ? insertLineRaw : -1;

    if (!label || !text.trim()) {
      throw new Error('memory_insert requires label and text');
    }

    const block = findBlockOrThrow(memoryBlocks, label);
    const lines = (block.value || '').split('\n');

    if (insertLine < 0 || insertLine >= lines.length) {
      lines.push(text);
    } else {
      lines.splice(insertLine + 1, 0, text);
    }

    block.value = lines.join('\n');
    return {
      result: `Successfully inserted text into ${label}`,
      summary: `Inserted new content into ${label}`,
      metadata: {
        label,
        operation: 'insert',
      },
    };
  });
}

function executeMemoryRethink(
  input: Record<string, unknown>,
  memoryBlocks: MemoryBlock[],
): ToolExecutionResult {
  return applyMemoryMutation(memoryBlocks, () => {
    const label = parseLabel(input.label);
    const newContent = String(input.new_content ?? input.new_memory ?? '');
    if (!label) {
      throw new Error('memory_rethink requires label');
    }
    const block = findBlockOrThrow(memoryBlocks, label);
    block.value = newContent;
    return {
      result: `Successfully rewrote ${label}`,
      summary: `Rewrote memory block ${label}`,
      metadata: {
        label,
        operation: 'rethink',
      },
    };
  });
}

function executeMemoryCommandTool(
  input: Record<string, unknown>,
  memoryBlocks: MemoryBlock[],
): ToolExecutionResult {
  const command = String(input.command || '').trim().toLowerCase();

  if (command === 'str_replace') {
    return executeMemoryReplace(
      {
        label: input.path,
        old_str: input.old_string,
        new_str: input.new_string,
      },
      memoryBlocks,
    );
  }

  if (command === 'insert') {
    return executeMemoryInsert(
      {
        label: input.path,
        new_str: input.insert_text,
        insert_line: input.insert_line,
      },
      memoryBlocks,
    );
  }

  if (command === 'create') {
    return applyMemoryMutation(memoryBlocks, () => {
      const label = parseLabel(input.path);
      if (!label) {
        throw new Error('memory create requires path');
      }
      if (memoryBlocks.some((b) => b.label === label)) {
        throw new Error(`Block "${label}" already exists`);
      }
      memoryBlocks.push({
        label,
        description: String(input.description ?? '').trim(),
        value: String(input.file_text ?? ''),
      });
      return {
        result: `Successfully created ${label}`,
        summary: `Created memory block ${label}`,
        metadata: {
          label,
          operation: 'create',
        },
      };
    });
  }

  if (command === 'delete') {
    return applyMemoryMutation(memoryBlocks, () => {
      const label = parseLabel(input.path);
      const idx = memoryBlocks.findIndex((b) => b.label === label);
      if (idx < 0) {
        throw new Error(`Block "${label}" not found`);
      }
      memoryBlocks.splice(idx, 1);
      return {
        result: `Successfully deleted ${label}`,
        summary: `Deleted memory block ${label}`,
        metadata: {
          label,
          operation: 'delete',
        },
      };
    });
  }

  if (command === 'rename') {
    return applyMemoryMutation(memoryBlocks, () => {
      const pathLabel = parseLabel(input.path);
      const oldLabel = parseLabel(input.old_path) || pathLabel;
      const newLabel = parseLabel(input.new_path);
      const description = String(input.description ?? '').trim();

      if (!oldLabel) {
        throw new Error('memory rename requires old_path or path');
      }
      const block = findBlockOrThrow(memoryBlocks, oldLabel);

      if (newLabel && newLabel !== oldLabel) {
        if (memoryBlocks.some((b) => b.label === newLabel)) {
          throw new Error(`Block "${newLabel}" already exists`);
        }
        block.label = newLabel;
      }
      if (description) {
        block.description = description;
      }

      const targetLabel =
        newLabel && newLabel !== oldLabel ? `${oldLabel} -> ${newLabel}` : oldLabel;

      return {
        result: `Successfully updated ${targetLabel}`,
        summary: `Renamed or updated memory block ${targetLabel}`,
        metadata: {
          label: newLabel || oldLabel,
          operation: 'rename',
        },
      };
    });
  }

  throw new Error(`Unsupported memory command: ${command}`);
}

const memoryToolDefinition = defineTool({
  name: 'memory',
  domain: 'memory',
  description:
    'Memory management tool with sub-commands: create, str_replace, insert, delete, rename.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      path: { type: 'string' },
      file_text: { type: 'string' },
      description: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      insert_line: { type: 'integer' },
      insert_text: { type: 'string' },
      old_path: { type: 'string' },
      new_path: { type: 'string' },
    },
    required: ['command'],
  },
  execute: (input, ctx) => executeMemoryCommandTool(input, ctx.memoryBlocks),
});

const memoryRethinkDefinition = defineTool({
  name: 'memory_rethink',
  domain: 'memory',
  description: 'Rewrite the entire content of a memory block.',
  input_schema: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      new_content: { type: 'string' },
      new_memory: { type: 'string' },
    },
    required: ['label'],
  },
  execute: (input, ctx) => executeMemoryRethink(input, ctx.memoryBlocks),
});

const memoryReplaceDefinition = defineTool({
  name: 'memory_replace',
  domain: 'memory',
  description: 'Replace a specific string in a memory block.',
  input_schema: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      old_text: { type: 'string' },
      new_text: { type: 'string' },
      old_str: { type: 'string' },
      new_str: { type: 'string' },
    },
    required: ['label'],
  },
  execute: (input, ctx) => executeMemoryReplace(input, ctx.memoryBlocks),
});

const memoryInsertDefinition = defineTool({
  name: 'memory_insert',
  domain: 'memory',
  description: 'Insert text into a memory block.',
  input_schema: {
    type: 'object',
    properties: {
      label: { type: 'string' },
      text_to_append: { type: 'string' },
      new_str: { type: 'string' },
      insert_line: { type: 'integer' },
      insert_text: { type: 'string' },
    },
    required: ['label'],
  },
  execute: (input, ctx) => executeMemoryInsert(input, ctx.memoryBlocks),
});

export function getMemoryToolHandlers(): ToolHandler[] {
  return [
    memoryToolDefinition,
    memoryRethinkDefinition,
    memoryReplaceDefinition,
    memoryInsertDefinition,
  ];
}
