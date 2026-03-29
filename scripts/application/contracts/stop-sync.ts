import type { LogFn } from '../../framework/hook-io.js';
import type { AgentMessage } from '../../framework/agent-messages.js';
import type { SubNotesMode, SdkToolsMode } from '../../conversation_utils.js';

export interface StopHookInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name?: string;
}

export interface StopSyncInputReader {
  readInput(): Promise<StopHookInput | null>;
}

export interface StopSyncStateGateway {
  getMode(cwd: string): SubNotesMode;
  getSdkToolsMode(cwd: string): SdkToolsMode;
  ensureContinuousWorker(
    sessionId: string,
    cwd: string,
    sdkToolsMode: SdkToolsMode,
  ): unknown;
  mirrorClaudeTranscript(cwd: string, sessionId: string, transcriptPath: string): number;
  peekUnreadAgentMessages(cwd: string, log: LogFn): AgentMessage[];
  fetchUnreadAgentMessages(cwd: string, log: LogFn): AgentMessage[];
  formatMessagesForHookContext(messages: AgentMessage[]): string;
  generateForegroundInstruction(messages: AgentMessage[]): string;
}

export interface StopSyncUseCaseResult {
  shouldOutput: boolean;
  output?: string;
}
