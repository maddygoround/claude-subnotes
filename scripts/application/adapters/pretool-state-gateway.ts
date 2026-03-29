import type { LogFn } from '../../framework/hook-io.js';
import type { AgentMessage } from '../../framework/agent-messages.js';
import type {
  MemoryBlock,
  ReflectConfig,
  SubNotesMode,
  SyncState,
} from '../../conversation_utils.js';
import {
  getMode,
  isAutonomicEnabled,
  loadConfig,
  loadLocalMemory,
  loadSyncState,
  saveSyncState,
} from '../../conversation_utils.js';
import {
  detectChangedBlocks,
  formatChangedBlocksAsXml,
  snapshotBlockValues,
  fetchUnreadAgentMessages,
  formatMessagesForHookContext,
  generateForegroundInstruction,
} from '../../framework/index.js';
import type {
  PreToolStateGateway,
} from '../contracts/pretool-sync.js';

export class ConversationPreToolStateGateway implements PreToolStateGateway {
  getMode(cwd: string): SubNotesMode {
    return getMode(cwd);
  }

  loadSyncState(cwd: string, sessionId: string, log: LogFn): SyncState {
    return loadSyncState(cwd, sessionId, log);
  }

  saveSyncState(cwd: string, state: SyncState, log: LogFn): void {
    saveSyncState(cwd, state, log);
  }

  loadLocalMemory(cwd: string, log: LogFn): MemoryBlock[] {
    return loadLocalMemory(cwd, log);
  }

  detectChangedBlocks(
    currentBlocks: MemoryBlock[],
    lastBlockValues: { [label: string]: string } | null,
  ): MemoryBlock[] {
    return detectChangedBlocks(currentBlocks, lastBlockValues);
  }

  formatChangedBlocksAsXml(
    changedBlocks: MemoryBlock[],
    lastBlockValues: { [label: string]: string } | null,
    wrapInUpdateTag: boolean = true,
  ): string {
    return formatChangedBlocksAsXml(
      changedBlocks,
      lastBlockValues,
      wrapInUpdateTag,
    );
  }

  snapshotBlockValues(blocks: MemoryBlock[]): { [label: string]: string } {
    return snapshotBlockValues(blocks);
  }

  fetchUnreadAgentMessages(cwd: string, log: LogFn): AgentMessage[] {
    return fetchUnreadAgentMessages(cwd, log);
  }

  formatMessagesForHookContext(messages: AgentMessage[]): string {
    return formatMessagesForHookContext(messages);
  }

  generateForegroundInstruction(messages: AgentMessage[]): string {
    return generateForegroundInstruction(messages);
  }

  isAutonomicEnabled(cwd: string): boolean {
    return isAutonomicEnabled(cwd);
  }

  loadConfig(cwd: string): ReflectConfig {
    return loadConfig(cwd);
  }
}
