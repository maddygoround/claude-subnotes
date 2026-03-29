import type { ReflectConfig } from '../../conversation_utils.js';
import type { SentinelState } from '../../autonomic/types.js';
import {
  loadSentinelState,
  saveSentinelState,
  updateSentinelState,
} from '../../framework/sentinel.js';
import type {
  StreamTranscriptSentinelGateway,
} from '../contracts/stream-transcript.js';

export class DefaultStreamTranscriptSentinelGateway
implements StreamTranscriptSentinelGateway {
  loadSentinelState(sessionId: string): SentinelState {
    return loadSentinelState(sessionId);
  }

  updateSentinelState(
    state: SentinelState,
    toolName: string,
    toolInput: unknown,
    toolResponse: unknown,
    config: ReflectConfig,
  ): SentinelState {
    return updateSentinelState(state, toolName, toolInput, toolResponse, config);
  }

  saveSentinelState(sessionId: string, state: SentinelState): void {
    saveSentinelState(sessionId, state);
  }
}
