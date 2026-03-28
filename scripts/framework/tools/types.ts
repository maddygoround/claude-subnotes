import Anthropic from '@anthropic-ai/sdk';
import type {
  MemoryBlock,
  SdkToolsMode,
} from '../../conversation_utils.js';
import type { LogFn } from '../hook-io.js';

export type ToolDomain =
  | 'memory'
  | 'conversation'
  | 'filesystem'
  | 'web'
  | 'subconscious';

export type ToolSignalKind =
  | 'insight'
  | 'risk'
  | 'assumption'
  | 'clarification_needed'
  | 'next_step'
  | 'boundary';

export type ToolSignalPriority = 'low' | 'medium' | 'high';
export type ToolSignalConfidence = 'low' | 'medium' | 'high';

export interface ToolSignal {
  kind: ToolSignalKind;
  message: string;
  priority?: ToolSignalPriority;
  confidence?: ToolSignalConfidence;
  suggestedQuestion?: string;
  fallbackAssumption?: string;
  recommendedAction?: string;
}

export interface ToolExecutionContext {
  cwd: string;
  sdkToolsMode: SdkToolsMode;
  memoryBlocks: MemoryBlock[];
  log?: LogFn;
  agentRole: 'subconscious';
}

export interface ToolExecutionResult {
  toolName?: string;
  domain?: ToolDomain;
  result: string;
  memoryUpdated: boolean;
  isError: boolean;
  summary?: string;
  signals: ToolSignal[];
  metadata: Record<string, unknown>;
}

export interface ToolHandler {
  definition: Anthropic.Tool;
  domain: ToolDomain;
  execute: (
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<ToolExecutionResult> | ToolExecutionResult;
}

interface ToolDefinitionInput {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  domain: ToolDomain;
  execute: (
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<ToolExecutionResult> | ToolExecutionResult;
}

interface ToolResultInit {
  result: string;
  memoryUpdated?: boolean;
  isError?: boolean;
  summary?: string;
  signals?: ToolSignal[];
  metadata?: Record<string, unknown>;
}

interface ToolSignalOptions {
  priority?: ToolSignalPriority;
  confidence?: ToolSignalConfidence;
  suggestedQuestion?: string;
  fallbackAssumption?: string;
  recommendedAction?: string;
}

export function defineTool(input: ToolDefinitionInput): ToolHandler {
  return {
    definition: {
      name: input.name,
      description: input.description,
      input_schema: input.input_schema,
    },
    domain: input.domain,
    execute: input.execute,
  };
}

export function createToolResult(input: ToolResultInit): ToolExecutionResult {
  return {
    result: String(input.result ?? ''),
    memoryUpdated: input.memoryUpdated ?? false,
    isError: input.isError ?? false,
    summary: input.summary,
    signals: input.signals ?? [],
    metadata: input.metadata ?? {},
  };
}

export function attachToolIdentity(
  result: ToolExecutionResult,
  handler: ToolHandler,
): ToolExecutionResult {
  return {
    ...result,
    toolName: handler.definition.name,
    domain: handler.domain,
  };
}

export function createSignal(
  kind: ToolSignalKind,
  message: string,
  options: ToolSignalOptions = {},
): ToolSignal {
  return {
    kind,
    message,
    ...options,
  };
}

export function insightSignal(
  message: string,
  options: ToolSignalOptions = {},
): ToolSignal {
  return createSignal('insight', message, options);
}

export function riskSignal(
  message: string,
  options: ToolSignalOptions = {},
): ToolSignal {
  return createSignal('risk', message, options);
}

export function assumptionSignal(
  message: string,
  fallbackAssumption: string,
  options: Omit<ToolSignalOptions, 'fallbackAssumption'> = {},
): ToolSignal {
  return createSignal('assumption', message, {
    ...options,
    fallbackAssumption,
  });
}

export function clarificationSignal(
  message: string,
  suggestedQuestion: string,
  fallbackAssumption?: string,
  options: Omit<ToolSignalOptions, 'suggestedQuestion' | 'fallbackAssumption'> = {},
): ToolSignal {
  return createSignal('clarification_needed', message, {
    ...options,
    suggestedQuestion,
    fallbackAssumption,
  });
}

export function nextStepSignal(
  message: string,
  recommendedAction: string,
  options: Omit<ToolSignalOptions, 'recommendedAction'> = {},
): ToolSignal {
  return createSignal('next_step', message, {
    ...options,
    recommendedAction,
  });
}

export function boundarySignal(
  message: string,
  options: ToolSignalOptions = {},
): ToolSignal {
  return createSignal('boundary', message, options);
}

function formatSignal(signal: ToolSignal): string[] {
  const confidence = signal.confidence ?? 'medium';
  const priority = signal.priority ?? 'medium';
  const headline = `- ${signal.kind} [priority=${priority}, confidence=${confidence}]: ${signal.message}`;
  const details = [headline];

  if (signal.suggestedQuestion) {
    details.push(`  Suggested question for Claude Code: ${signal.suggestedQuestion}`);
  }
  if (signal.fallbackAssumption) {
    details.push(`  Fallback assumption: ${signal.fallbackAssumption}`);
  }
  if (signal.recommendedAction) {
    details.push(`  Recommended action: ${signal.recommendedAction}`);
  }

  return details;
}

export function formatToolResultForAgent(
  result: ToolExecutionResult,
): string {
  const toolName = result.toolName ?? 'unknown';
  const domain = result.domain ?? 'subconscious';
  const lines = [`[Subconscious Tool Result: ${toolName}]`];

  lines.push(`Domain: ${domain}`);
  lines.push(`Status: ${result.isError ? 'error' : 'ok'}`);

  if (result.summary) {
    lines.push(`Summary: ${result.summary}`);
  }

  lines.push(`Memory updated: ${result.memoryUpdated ? 'yes' : 'no'}`);

  if (result.signals.length > 0) {
    lines.push('Signals:');
    for (const signal of result.signals) {
      lines.push(...formatSignal(signal));
    }
  }

  if (Object.keys(result.metadata).length > 0) {
    lines.push(`Metadata keys: ${Object.keys(result.metadata).join(', ')}`);
  }

  lines.push('');
  lines.push('Raw output:');
  lines.push(result.result.trim() || '(no output)');

  return lines.join('\n');
}
