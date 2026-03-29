import { stringifyUnknown } from '../../framework/utils/serialization.js';
import type {
  StreamTranscriptInputReader,
  StreamTranscriptSentinelGateway,
  StreamTranscriptStateGateway,
} from '../contracts/stream-transcript.js';

export interface StreamTranscriptUseCaseDeps {
  inputReader: StreamTranscriptInputReader;
  stateGateway: StreamTranscriptStateGateway;
  sentinelGateway: StreamTranscriptSentinelGateway;
}

function buildSentinelEventContent(warningTypes: string[]): string {
  const warnings = warningTypes
    .map((warningType) => `<warning>${warningType}</warning>`)
    .join('\n');

  return `<sentinel_event>\n${warnings}\n</sentinel_event>`;
}

export class StreamTranscriptUseCase {
  private readonly inputReader: StreamTranscriptInputReader;
  private readonly stateGateway: StreamTranscriptStateGateway;
  private readonly sentinelGateway: StreamTranscriptSentinelGateway;

  constructor(deps: StreamTranscriptUseCaseDeps) {
    this.inputReader = deps.inputReader;
    this.stateGateway = deps.stateGateway;
    this.sentinelGateway = deps.sentinelGateway;
  }

  async execute(): Promise<void> {
    const hookInput = await this.inputReader.readInput();

    if (!hookInput?.session_id || !hookInput?.cwd) {
      return;
    }

    const mode = this.stateGateway.getMode(hookInput.cwd);
    if (mode === 'off') {
      return;
    }

    this.stateGateway.ensureContinuousWorker(
      hookInput.session_id,
      hookInput.cwd,
      this.stateGateway.getSdkToolsMode(hookInput.cwd),
    );

    const eventName = hookInput.hook_event_name || 'Unknown';
    if (hookInput.transcript_path) {
      this.stateGateway.mirrorClaudeTranscript(
        hookInput.cwd,
        hookInput.session_id,
        hookInput.transcript_path,
      );
    } else {
      let role: 'user' | 'assistant' | 'system' = 'user';
      let content = '';

      if (eventName === 'UserPromptSubmit' && hookInput.prompt) {
        role = 'user';
        content = hookInput.prompt;
      } else if (eventName === 'PostToolUse') {
        role = 'system';
        const toolName = hookInput.tool_name || 'unknown_tool';
        const toolInput = hookInput.tool_input !== undefined
          ? stringifyUnknown(hookInput.tool_input)
          : '(no tool input)';
        const toolResponse = hookInput.tool_response !== undefined
          ? stringifyUnknown(hookInput.tool_response)
          : '(no tool response)';
        content =
          `<tool_event>\n` +
          `<name>${toolName}</name>\n` +
          `<input>\n${toolInput}\n</input>\n` +
          `<response>\n${toolResponse}\n</response>\n` +
          `</tool_event>`;
      } else if (hookInput.response) {
        role = 'assistant';
        content = hookInput.response;
      } else if (hookInput.prompt) {
        role = 'user';
        content = hookInput.prompt;
      } else {
        return;
      }

      this.stateGateway.appendTranscriptEntry(hookInput.cwd, hookInput.session_id, {
        timestamp: new Date().toISOString(),
        role,
        content,
      });
    }

    if (
      eventName === 'PostToolUse' &&
      this.stateGateway.isAutonomicEnabled(hookInput.cwd) &&
      hookInput.tool_name
    ) {
      try {
        const config = this.stateGateway.loadConfig(hookInput.cwd);
        const sentinelState = this.sentinelGateway.loadSentinelState(
          hookInput.session_id,
        );
        const pendingObservationWarnings = [
          ...(sentinelState.pending_observation_warnings || []),
        ];
        const updatedState = this.sentinelGateway.updateSentinelState(
          sentinelState,
          hookInput.tool_name,
          hookInput.tool_input,
          hookInput.tool_response,
          config,
        );
        updatedState.pending_observation_warnings = [];
        this.sentinelGateway.saveSentinelState(hookInput.session_id, updatedState);

        if (pendingObservationWarnings.length > 0) {
          this.stateGateway.appendTranscriptEntry(hookInput.cwd, hookInput.session_id, {
            timestamp: new Date().toISOString(),
            role: 'system',
            content: buildSentinelEventContent(pendingObservationWarnings),
          });
        }
      } catch {
        // Sentinel updates are best-effort — never break the hook
      }
    }
  }
}
