import { stringifyUnknown } from './serialization.js';

export interface ParsedTranscriptEntry {
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ClaudeTranscriptContentBlock {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
}

interface ClaudeTranscriptRecord {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: ClaudeTranscriptContentBlock[] | unknown;
  };
}

type ParseLogFn = (message: string) => void;
const noopLog: ParseLogFn = () => {};

function collectTextBlocks(blocks: ClaudeTranscriptContentBlock[]): string[] {
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text) {
        parts.push(text);
      }
      continue;
    }

    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const thinking = block.thinking.trim();
      if (thinking) {
        parts.push(`<thinking>\n${thinking}\n</thinking>`);
      }
    }
  }

  return parts;
}

function extractToolResultText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return stringifyUnknown(item);
        }

        const block = item as { type?: unknown; text?: unknown };
        if (block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }

        return stringifyUnknown(item);
      })
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length > 0) {
      return parts.join('\n\n');
    }
  }

  return stringifyUnknown(value);
}

function buildToolEventContent(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
): string {
  return (
    `<tool_event>\n` +
    `<name>${toolName}</name>\n` +
    `<input>\n${stringifyUnknown(toolInput)}\n</input>\n` +
    `<response>\n${extractToolResultText(toolResponse)}\n</response>\n` +
    `</tool_event>`
  );
}

export function parseClaudeTranscriptEntries(
  lines: string[],
  startIndex: number,
  pendingToolUses: Record<
    string,
    {
      name: string;
      input: unknown;
      timestamp: string;
    }
  >,
  fallbackTimestamp: string,
  log: ParseLogFn = noopLog,
): { entries: ParsedTranscriptEntry[]; latestLineIndex: number } {
  const entries: ParsedTranscriptEntry[] = [];
  let latestLineIndex = startIndex;

  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    latestLineIndex = index;

    let record: ClaudeTranscriptRecord;
    try {
      record = JSON.parse(line) as ClaudeTranscriptRecord;
    } catch (error) {
      log(`Failed to parse Claude transcript line ${index}: ${error}`);
      continue;
    }

    if (!record || (record.type !== 'user' && record.type !== 'assistant')) {
      continue;
    }

    const blocks = Array.isArray(record.message?.content)
      ? record.message.content
      : [];
    const timestamp =
      typeof record.timestamp === 'string' && record.timestamp
        ? record.timestamp
        : fallbackTimestamp;

    if (record.type === 'assistant') {
      const assistantParts = collectTextBlocks(blocks);
      if (assistantParts.length > 0) {
        entries.push({
          timestamp,
          role: 'assistant',
          content: assistantParts.join('\n\n'),
        });
      }

      for (const block of blocks) {
        if (
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string'
        ) {
          pendingToolUses[block.id] = {
            name: block.name,
            input: block.input,
            timestamp,
          };
        }
      }

      continue;
    }

    const userTextParts = blocks
      .filter(
        (block): block is ClaudeTranscriptContentBlock =>
          block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => {
        const text = block.text;
        return typeof text === 'string' ? text.trim() : '';
      })
      .filter(Boolean);

    if (userTextParts.length > 0) {
      entries.push({
        timestamp,
        role: 'user',
        content: userTextParts.join('\n\n'),
      });
    }

    for (const block of blocks) {
      if (
        block.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string'
      ) {
        continue;
      }

      const pending =
        pendingToolUses[block.tool_use_id] || {
          name: 'unknown_tool',
          input: '(missing tool input)',
          timestamp,
        };

      entries.push({
        timestamp,
        role: 'system',
        content: buildToolEventContent(
          pending.name,
          pending.input,
          block.content ?? '(no tool response)',
        ),
      });

      delete pendingToolUses[block.tool_use_id];
    }
  }

  return { entries, latestLineIndex };
}
