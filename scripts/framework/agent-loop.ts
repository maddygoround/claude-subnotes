/**
 * Agent Loop Framework
 *
 * Shared Anthropic SDK agentic loop used by background workers.
 * Tool execution is delegated to per-tool handlers under ./tools.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MemoryBlock, SdkToolsMode } from '../conversation_utils.js';
import type { LogFn } from './hook-io.js';
import { noopLog } from './hook-io.js';
import { executeToolByName, getToolDefinitions } from './tools/index.js';
import {
  createToolResult,
  formatToolResultForAgent,
  riskSignal,
  type ToolExecutionResult,
} from './tools/types.js';

// ============================================
// Types
// ============================================

export interface AgentLoopConfig {
  cwd: string;
  sdkToolsMode: SdkToolsMode;
  systemPromptBuilder: () => string;
  userMessage: string;
  maxSteps?: number;
  maxTokens?: number;
  log?: LogFn;
}

export interface AgentLoopResult {
  memoriesUpdated: boolean;
  assistantResponse: string;
  memoryBlocks: MemoryBlock[];
}

// ============================================
// Tool Definitions (backward-compatible export)
// ============================================

export function getMemoryTools(
  sdkToolsMode: SdkToolsMode,
): Anthropic.Tool[] {
  return getToolDefinitions(sdkToolsMode);
}

export async function executeMemoryTool(
  name: string,
  input: Record<string, unknown>,
  memoryBlocks: MemoryBlock[],
  cwd: string,
  sdkToolsMode: SdkToolsMode = 'read-only',
  log: LogFn = noopLog,
): Promise<ToolExecutionResult> {
  try {
    return await executeToolByName(
      sdkToolsMode,
      name,
      input,
      { cwd, sdkToolsMode, memoryBlocks, log, agentRole: 'subconscious' },
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      ...createToolResult({
        result: `Error: ${errMsg}`,
        summary: `Tool ${name} failed`,
        isError: true,
        signals: [
          riskSignal(`Tool ${name} could not complete successfully.`, {
            confidence: 'high',
            priority: 'medium',
            recommendedAction:
              'Treat this tool result as incomplete and choose a safer follow-up step.',
          }),
        ],
        metadata: {
          errorMessage: errMsg,
        },
      }),
      toolName: name,
      domain: 'subconscious',
    };
  }
}

// ============================================
// Agent Loop
// ============================================

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
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system: systemPromptBuilder(),
        tools,
        messages,
      });

      messages.push({
        role: 'assistant',
        content: response.content,
      });

      const toolCalls: Anthropic.ContentBlock[] = [];
      for (const block of response.content) {
        if (block.type === 'text') {
          assistantResponse += block.text;
          log(`Agent: ${block.text.substring(0, 200)}...`);
        } else if (block.type === 'tool_use') {
          toolCalls.push(block);
        }
      }

      if (toolCalls.length === 0) {
        log('No more tool calls. Exiting agent loop.');
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tc of toolCalls) {
        if (tc.type !== 'tool_use') continue;
        log(`Executing tool: ${tc.name}`);

        const execution = await executeMemoryTool(
          tc.name,
          tc.input as Record<string, unknown>,
          memoryBlocks,
          cwd,
          sdkToolsMode,
          log,
        );

        if (execution.summary) {
          log(`Tool summary (${tc.name}): ${execution.summary}`);
        }
        for (const signal of execution.signals) {
          log(
            `Tool signal (${tc.name}/${signal.kind}): ${signal.message}`,
          );
        }

        if (execution.memoryUpdated) {
          memoriesUpdated = true;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          is_error: execution.isError,
          content: formatToolResultForAgent(execution),
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
