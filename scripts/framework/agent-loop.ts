/**
 * Agent Loop Framework
 *
 * Shared Anthropic SDK agentic loop used by both background workers
 * (send_worker_local and send_worker_continuous).
 *
 * Consolidates:
 * - Memory tool definitions (memory_replace, memory_insert, memory_rethink, read_file)
 * - Tool execution dispatch
 * - The multi-step agent loop with system prompt + tool calling
 */

import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import type { MemoryBlock } from '../conversation_utils.js';
import type { LogFn } from './hook-io.js';
import { noopLog } from './hook-io.js';

// ============================================
// Types
// ============================================

export interface AgentLoopConfig {
  /** Working directory for file reading tools */
  cwd: string;
  /** Controls which SDK tools are available */
  sdkToolsMode: 'read-only' | 'full' | 'off';
  /** Builds the system prompt (called each step so memory is fresh) */
  systemPromptBuilder: () => string;
  /** The user message to send to the agent */
  userMessage: string;
  /** Max agentic steps (default 5) */
  maxSteps?: number;
  /** Max tokens per response (default 1500) */
  maxTokens?: number;
  /** Logger function */
  log?: LogFn;
}

export interface AgentLoopResult {
  /** Whether any memory blocks were updated */
  memoriesUpdated: boolean;
  /** Concatenated text responses from the agent */
  assistantResponse: string;
  /** The memory blocks (potentially mutated by tool calls) */
  memoryBlocks: MemoryBlock[];
}

// ============================================
// Tool Definitions
// ============================================

/**
 * Get the set of tools available to the agent.
 */
export function getMemoryTools(
  sdkToolsMode: 'read-only' | 'full' | 'off',
): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [
    {
      name: 'memory_replace',
      description: 'Replace a string in a memory block. Good for small updates.',
      input_schema: {
        type: 'object' as const,
        properties: {
          label: {
            type: 'string',
            description: 'Label of the memory block (e.g. user_preferences)',
          },
          old_text: {
            type: 'string',
            description: 'Exact string to be replaced',
          },
          new_text: {
            type: 'string',
            description: 'String to replace it with',
          },
        },
        required: ['label', 'old_text', 'new_text'],
      },
    },
    {
      name: 'memory_insert',
      description: 'Append text to a memory block.',
      input_schema: {
        type: 'object' as const,
        properties: {
          label: { type: 'string' },
          text_to_append: {
            type: 'string',
            description: 'Text to add to the end of the block',
          },
        },
        required: ['label', 'text_to_append'],
      },
    },
    {
      name: 'memory_rethink',
      description: 'Rewrite the entire content of a memory block. Use carefully.',
      input_schema: {
        type: 'object' as const,
        properties: {
          label: { type: 'string' },
          new_content: {
            type: 'string',
            description: 'The complete new content for the memory block',
          },
        },
        required: ['label', 'new_content'],
      },
    },
  ];

  if (sdkToolsMode !== 'off') {
    tools.push({
      name: 'read_file',
      description: 'Read a file from the repository.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to the file to read',
          },
        },
        required: ['path'],
      },
    });
  }

  return tools;
}

// ============================================
// Tool Execution
// ============================================

/**
 * Execute a single tool call against the memory blocks.
 * Returns the result string and whether memory was mutated.
 */
export function executeMemoryTool(
  name: string,
  input: any,
  memoryBlocks: MemoryBlock[],
  cwd: string,
): { result: string; memoryUpdated: boolean } {
  try {
    if (name === 'memory_replace') {
      const block = memoryBlocks.find((b) => b.label === input.label);
      if (!block) throw new Error(`Block ${input.label} not found`);
      if (!block.value.includes(input.old_text))
        throw new Error(`old_text not found in block`);
      block.value = block.value.replace(input.old_text, input.new_text);
      return { result: `Successfully replaced text in ${input.label}`, memoryUpdated: true };
    }

    if (name === 'memory_insert') {
      const block = memoryBlocks.find((b) => b.label === input.label);
      if (!block) throw new Error(`Block ${input.label} not found`);
      block.value = `${block.value}\n${input.text_to_append}`;
      return { result: `Successfully appended text to ${input.label}`, memoryUpdated: true };
    }

    if (name === 'memory_rethink') {
      const block = memoryBlocks.find((b) => b.label === input.label);
      if (!block) throw new Error(`Block ${input.label} not found`);
      block.value = input.new_content;
      return { result: `Successfully rewrote ${input.label}`, memoryUpdated: true };
    }

    if (name === 'read_file') {
      const fullPath = path.resolve(cwd, input.path);
      if (!fullPath.startsWith(cwd))
        throw new Error('Path outside cwd is not allowed');
      const data = fs.readFileSync(fullPath, 'utf8');
      const truncated = data.length > 4000
        ? data.substring(0, 4000) + '\n...[truncated]'
        : data;
      return { result: `File content:\n${truncated}`, memoryUpdated: false };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { result: `Error: ${errMsg}`, memoryUpdated: false };
  }
}

// ============================================
// Agent Loop
// ============================================

/**
 * Run the multi-step agentic loop.
 *
 * 1. Send user message with system prompt
 * 2. If the model calls tools, execute them and loop
 * 3. Stop when no tool calls or maxSteps reached
 */
export async function runAgentLoop(
  config: AgentLoopConfig,
  memoryBlocks: MemoryBlock[],
): Promise<AgentLoopResult> {
  const {
    cwd,
    sdkToolsMode,
    systemPromptBuilder,
    userMessage,
    maxSteps = 5,
    maxTokens = 1500,
    log = noopLog,
  } = config;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log('ERROR: ANTHROPIC_API_KEY is not set');
    return { memoriesUpdated: false, assistantResponse: '', memoryBlocks };
  }

  const client = new Anthropic({ apiKey });
  const tools = getMemoryTools(sdkToolsMode);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  let assistantResponse = '';
  let memoriesUpdated = false;

  for (let step = 0; step < maxSteps; step++) {
    log(`Step ${step + 1}: Calling Anthropic`);

    try {
      const response = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
        max_tokens: maxTokens,
        system: systemPromptBuilder(),
        tools,
        messages,
      });

      const nextMessage: Anthropic.MessageParam = {
        role: 'assistant',
        content: response.content,
      };
      messages.push(nextMessage);

      // Extract text and tool calls
      const toolCalls: Anthropic.ContentBlock[] = [];
      for (const block of response.content) {
        if (block.type === 'text') {
          assistantResponse += block.text;
          log(`Agent: ${block.text.substring(0, 200)}...`);
        } else if (block.type === 'tool_use') {
          toolCalls.push(block);
        }
      }

      // No tools → done
      if (toolCalls.length === 0) {
        log('No more tool calls. Exiting agent loop.');
        break;
      }

      // Execute tools and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tc of toolCalls) {
        if (tc.type !== 'tool_use') continue;
        log(`Executing tool: ${tc.name}`);

        const { result, memoryUpdated } = executeMemoryTool(
          tc.name,
          tc.input,
          memoryBlocks,
          cwd,
        );

        if (memoryUpdated) memoriesUpdated = true;

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: result,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    } catch (apiError) {
      log(`Anthropic API Error: ${apiError}`);
      break;
    }
  }

  return { memoriesUpdated, assistantResponse, memoryBlocks };
}
