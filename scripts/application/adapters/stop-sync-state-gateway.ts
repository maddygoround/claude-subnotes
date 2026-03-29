import type { LogFn } from '../../framework/hook-io.js';
import type { AgentMessage } from '../../framework/agent-messages.js';
import type { SdkToolsMode, SubNotesMode } from '../../conversation_utils.js';
import {
  ensureContinuousWorker,
  getMode,
  getSdkToolsMode,
  mirrorClaudeTranscript,
} from '../../conversation_utils.js';
import {
  fetchUnreadAgentMessages,
  formatMessagesForHookContext,
  generateForegroundInstruction,
  peekUnreadAgentMessages,
} from '../../framework/index.js';
import type { StopSyncStateGateway } from '../contracts/stop-sync.js';

export class DefaultStopSyncStateGateway implements StopSyncStateGateway {
  getMode(cwd: string): SubNotesMode {
    return getMode(cwd);
  }

  getSdkToolsMode(cwd: string): SdkToolsMode {
    return getSdkToolsMode(cwd);
  }

  ensureContinuousWorker(
    sessionId: string,
    cwd: string,
    sdkToolsMode: SdkToolsMode,
  ): unknown {
    return ensureContinuousWorker(sessionId, cwd, sdkToolsMode);
  }

  mirrorClaudeTranscript(
    cwd: string,
    sessionId: string,
    transcriptPath: string,
  ): number {
    return mirrorClaudeTranscript(cwd, sessionId, transcriptPath);
  }

  peekUnreadAgentMessages(cwd: string, log: LogFn): AgentMessage[] {
    return peekUnreadAgentMessages(cwd, log);
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
}
