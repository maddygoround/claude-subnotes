import type { LogFn } from '../../framework/hook-io.js';
import type { AgentMessage } from '../../framework/agent-messages.js';
import type {
  MemoryBlock,
  ReflectConfig,
  SubNotesMode,
  SyncState,
} from '../../conversation_utils.js';
import type {
  HookAction,
  InterventionRecord,
  InterventionType,
  MetaConfig,
  ReflexRule,
  SentinelState,
  SentinelWarning,
} from '../../autonomic/types.js';

export interface PreToolHookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
}

export interface PreToolInputReader {
  readInput(): Promise<PreToolHookInput | null>;
}

export interface PreToolStateGateway {
  getMode(cwd: string): SubNotesMode;
  loadSyncState(cwd: string, sessionId: string, log: LogFn): SyncState;
  saveSyncState(cwd: string, state: SyncState, log: LogFn): void;
  loadLocalMemory(cwd: string, log: LogFn): MemoryBlock[];
  detectChangedBlocks(
    currentBlocks: MemoryBlock[],
    lastBlockValues: { [label: string]: string } | null,
  ): MemoryBlock[];
  formatChangedBlocksAsXml(
    changedBlocks: MemoryBlock[],
    lastBlockValues: { [label: string]: string } | null,
    wrapInUpdateTag?: boolean,
  ): string;
  snapshotBlockValues(blocks: MemoryBlock[]): { [label: string]: string };
  fetchUnreadAgentMessages(cwd: string, log: LogFn): AgentMessage[];
  formatMessagesForHookContext(messages: AgentMessage[]): string;
  generateForegroundInstruction(messages: AgentMessage[]): string;
  isAutonomicEnabled(cwd: string): boolean;
  loadConfig(cwd: string): ReflectConfig;
}

export interface PreToolAutonomicGateway {
  loadSentinelState(sessionId: string): SentinelState;
  checkSentinelTriggers(
    state: SentinelState,
    config: ReflectConfig,
    currentToolName?: string,
    currentToolInput?: unknown,
  ): SentinelWarning[];
  recordSentinelWarnings(
    state: SentinelState,
    warnings: SentinelWarning[],
  ): SentinelState;
  queueSentinelWarningsForObservation(
    state: SentinelState,
    warnings: SentinelWarning[],
  ): SentinelState;
  saveSentinelState(sessionId: string, state: SentinelState): void;
  formatSentinelWarnings(warnings: SentinelWarning[]): string;
  loadReflexRules(cwd: string, log: LogFn): ReflexRule[];
  loadMetaConfig(cwd: string, log: LogFn): MetaConfig;
  matchReflexRules(
    toolName: string,
    toolInput: unknown,
    rules: ReflexRule[],
    metaConfig: MetaConfig,
    log: LogFn,
  ): HookAction;
  recordRuleFired(rule: ReflexRule): ReflexRule;
  saveReflexRules(cwd: string, rules: ReflexRule[], log: LogFn): void;
  createInterventionRecord(
    type: InterventionType,
    toolName: string,
    toolInput: unknown,
    interventionContent: string,
    reflexId?: string | null,
  ): InterventionRecord;
  appendIntervention(cwd: string, record: InterventionRecord, log: LogFn): void;
}

export interface PreToolUseCaseResult {
  shouldOutput: boolean;
  output?: string;
}
