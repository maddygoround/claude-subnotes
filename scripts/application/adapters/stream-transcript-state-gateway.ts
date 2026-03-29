import type {
  ReflectConfig,
  TranscriptEntry,
} from '../../conversation_utils.js';
import {
  appendTranscriptEntry,
  ensureContinuousWorker,
  getMode,
  getSdkToolsMode,
  isAutonomicEnabled,
  loadConfig,
  mirrorClaudeTranscript,
} from '../../conversation_utils.js';
import type {
  StreamTranscriptStateGateway,
} from '../contracts/stream-transcript.js';

export class ConversationStreamTranscriptStateGateway
implements StreamTranscriptStateGateway {
  getMode(cwd: string): 'whisper' | 'full' | 'off' {
    return getMode(cwd);
  }

  getSdkToolsMode(cwd: string): 'read-only' | 'full' | 'off' {
    return getSdkToolsMode(cwd);
  }

  ensureContinuousWorker(
    sessionId: string,
    cwd: string,
    sdkToolsMode: 'read-only' | 'full' | 'off',
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

  appendTranscriptEntry(
    cwd: string,
    sessionId: string,
    entry: TranscriptEntry,
  ): void {
    appendTranscriptEntry(cwd, sessionId, entry);
  }

  isAutonomicEnabled(cwd: string): boolean {
    return isAutonomicEnabled(cwd);
  }

  loadConfig(cwd: string): ReflectConfig {
    return loadConfig(cwd);
  }
}
