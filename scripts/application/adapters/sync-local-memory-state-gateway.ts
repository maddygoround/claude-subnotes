import type { LogFn } from '../../framework/hook-io.js';
import type { AgentMessage } from '../../framework/agent-messages.js';
import type {
  MemoryBlock,
  SubNotesMode,
  SyncState,
} from '../../conversation_utils.js';
import {
  formatAllBlocksForStdout,
  getMode,
  loadLocalMemory,
  loadSyncState,
  saveSyncState,
  syncClaudeMdFromMemory,
} from '../../conversation_utils.js';
import {
  detectChangedBlocks,
  fetchUnreadAgentMessages,
  formatChangedBlocksAsXml,
  formatMessagesForHookContext,
  generateForegroundInstruction,
  snapshotBlockValues,
} from '../../framework/index.js';
import type {
  SyncLocalMemoryStateGateway,
} from '../contracts/sync-local-memory.js';

export class DefaultSyncLocalMemoryStateGateway
implements SyncLocalMemoryStateGateway {
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

  fetchUnreadAgentMessages(cwd: string, log: LogFn): AgentMessage[] {
    return fetchUnreadAgentMessages(cwd, log);
  }

  detectChangedBlocks(
    currentBlocks: MemoryBlock[],
    lastBlockValues: { [label: string]: string } | null,
  ): MemoryBlock[] {
    return detectChangedBlocks(currentBlocks, lastBlockValues);
  }

  syncClaudeMdFromMemory(cwd: string, blocks: MemoryBlock[]): void {
    syncClaudeMdFromMemory(cwd, blocks);
  }

  snapshotBlockValues(blocks: MemoryBlock[]): { [label: string]: string } {
    return snapshotBlockValues(blocks);
  }

  formatAllBlocksForStdout(blocks: MemoryBlock[], cwd?: string): string {
    return formatAllBlocksForStdout(blocks, cwd);
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

  formatMessagesForHookContext(messages: AgentMessage[]): string {
    return formatMessagesForHookContext(messages);
  }

  generateForegroundInstruction(messages: AgentMessage[]): string {
    return generateForegroundInstruction(messages);
  }
}
