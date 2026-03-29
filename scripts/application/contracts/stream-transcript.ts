import type { ReflectConfig, TranscriptEntry } from '../../conversation_utils.js';
import type { SentinelState } from '../../autonomic/types.js';

export interface StreamTranscriptHookInput {
  session_id: string;
  cwd: string;
  prompt?: string;
  response?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  transcript_path?: string;
  hook_event_name?: string;
}

export interface StreamTranscriptInputReader {
  readInput(): Promise<StreamTranscriptHookInput | null>;
}

export interface StreamTranscriptStateGateway {
  getMode(cwd: string): 'whisper' | 'full' | 'off';
  getSdkToolsMode(cwd: string): 'read-only' | 'full' | 'off';
  ensureContinuousWorker(
    sessionId: string,
    cwd: string,
    sdkToolsMode: 'read-only' | 'full' | 'off',
  ): unknown;
  mirrorClaudeTranscript(cwd: string, sessionId: string, transcriptPath: string): number;
  appendTranscriptEntry(cwd: string, sessionId: string, entry: TranscriptEntry): void;
  isAutonomicEnabled(cwd: string): boolean;
  loadConfig(cwd: string): ReflectConfig;
}

export interface StreamTranscriptSentinelGateway {
  loadSentinelState(sessionId: string): SentinelState;
  updateSentinelState(
    state: SentinelState,
    toolName: string,
    toolInput: unknown,
    toolResponse: unknown,
    config: ReflectConfig,
  ): SentinelState;
  saveSentinelState(sessionId: string, state: SentinelState): void;
}
