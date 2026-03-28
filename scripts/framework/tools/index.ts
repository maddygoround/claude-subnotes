import Anthropic from '@anthropic-ai/sdk';
import type { SdkToolsMode } from '../../conversation_utils.js';
import { getConversationToolHandlers } from './conversation.js';
import { getFileToolHandlers } from './files.js';
import { getMemoryToolHandlers } from './memory.js';
import {
  attachToolIdentity,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolHandler,
} from './types.js';
import { getWebToolHandlers } from './web.js';

function buildToolHandlers(mode: SdkToolsMode): ToolHandler[] {
  const handlers: ToolHandler[] = [...getMemoryToolHandlers()];

  if (mode !== 'off') {
    handlers.push(...getConversationToolHandlers());
    handlers.push(...getWebToolHandlers());
    handlers.push(...getFileToolHandlers());
  }

  return handlers;
}

export function getToolDefinitions(mode: SdkToolsMode): Anthropic.Tool[] {
  return buildToolHandlers(mode).map((handler) => handler.definition);
}

export async function executeToolByName(
  mode: SdkToolsMode,
  name: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const handler = buildToolHandlers(mode).find(
    (candidate) => candidate.definition.name === name,
  );
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const result = await handler.execute(input, context);
  return attachToolIdentity(result, handler);
}
