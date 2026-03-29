import type {
  LogFn,
  MemoryBlock,
  SdkToolsMode,
  SubNotesMode,
  SyncState,
} from '../../conversation_utils.js';
import {
  cleanSubNotesFromClaudeMd,
  ensureConfigFile,
  ensureContinuousWorker,
  getMode,
  getSdkToolsMode,
  loadConfig,
  loadLocalMemory,
  saveSyncState,
  syncClaudeMdFromMemory,
} from '../../conversation_utils.js';
import type {
  SessionStartStateGateway,
} from '../contracts/session-start.js';

export class ConversationUtilsSessionStartStateGateway
implements SessionStartStateGateway {
  getMode(cwd: string): SubNotesMode {
    return getMode(cwd);
  }

  loadLocalMemory(cwd: string, log: LogFn): MemoryBlock[] {
    return loadLocalMemory(cwd, log);
  }

  syncClaudeMdFromMemory(cwd: string, blocks: MemoryBlock[]): void {
    syncClaudeMdFromMemory(cwd, blocks);
  }

  ensureConfigFile(cwd: string, log: LogFn): void {
    ensureConfigFile(cwd, log);
  }

  loadConfig(cwd: string): unknown {
    return loadConfig(cwd);
  }

  saveSyncState(cwd: string, state: SyncState, log: LogFn): void {
    saveSyncState(cwd, state, log);
  }

  getSdkToolsMode(cwd: string): SdkToolsMode {
    return getSdkToolsMode(cwd);
  }

  ensureContinuousWorker(
    sessionId: string,
    cwd: string,
    sdkToolsMode: SdkToolsMode,
    log: LogFn,
  ) {
    return ensureContinuousWorker(sessionId, cwd, sdkToolsMode, log);
  }

  cleanSubNotesFromClaudeMd(projectDir: string): void {
    cleanSubNotesFromClaudeMd(projectDir);
  }
}
