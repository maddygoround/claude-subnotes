import type { LogFn } from '../../framework/hook-io.js';
import type { AgentMessage } from '../../framework/agent-messages.js';
import type {
  MemoryBlock,
  SubNotesMode,
  SyncState,
} from '../../conversation_utils.js';

export interface SyncLocalMemoryHookInput {
  session_id: string;
  cwd: string;
  prompt?: string;
  hook_event_name?: 'SessionStart' | 'UserPromptSubmit';
}

export interface SyncLocalMemoryInputReader {
  readInput(): Promise<SyncLocalMemoryHookInput | null>;
}

export interface SyncLocalMemoryStateGateway {
  getMode(cwd: string): SubNotesMode;
  loadSyncState(cwd: string, sessionId: string, log: LogFn): SyncState;
  saveSyncState(cwd: string, state: SyncState, log: LogFn): void;
  loadLocalMemory(cwd: string, log: LogFn): MemoryBlock[];
  fetchUnreadAgentMessages(cwd: string, log: LogFn): AgentMessage[];
  detectChangedBlocks(
    currentBlocks: MemoryBlock[],
    lastBlockValues: { [label: string]: string } | null,
  ): MemoryBlock[];
  syncClaudeMdFromMemory(cwd: string, blocks: MemoryBlock[]): void;
  snapshotBlockValues(blocks: MemoryBlock[]): { [label: string]: string };
  formatAllBlocksForStdout(blocks: MemoryBlock[], cwd?: string): string;
  formatChangedBlocksAsXml(
    changedBlocks: MemoryBlock[],
    lastBlockValues: { [label: string]: string } | null,
    wrapInUpdateTag?: boolean,
  ): string;
  formatMessagesForHookContext(messages: AgentMessage[]): string;
  generateForegroundInstruction(messages: AgentMessage[]): string;
}

export interface SyncLocalMemoryUseCaseResult {
  shouldOutput: boolean;
  output?: string;
}
