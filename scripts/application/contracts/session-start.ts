import type { ChildProcess } from 'child_process';
import type {
  LogFn,
  MemoryBlock,
  SdkToolsMode,
  SubNotesMode,
  SyncState,
} from '../../conversation_utils.js';

export interface SessionStartHookInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
}

export interface SessionStartInputReader {
  readInput(): Promise<SessionStartHookInput>;
}

export interface HomeDirectoryProvider {
  getHomeDirectory(): string;
}

export interface SessionStartStateGateway {
  getMode(cwd: string): SubNotesMode;
  loadLocalMemory(cwd: string, log: LogFn): MemoryBlock[];
  syncClaudeMdFromMemory(cwd: string, blocks: MemoryBlock[]): void;
  ensureConfigFile(cwd: string, log: LogFn): void;
  loadConfig(cwd: string): unknown;
  saveSyncState(cwd: string, state: SyncState, log: LogFn): void;
  getSdkToolsMode(cwd: string): SdkToolsMode;
  ensureContinuousWorker(
    sessionId: string,
    cwd: string,
    sdkToolsMode: SdkToolsMode,
    log: LogFn,
  ): ChildProcess | null;
  cleanSubNotesFromClaudeMd(projectDir: string): void;
}
