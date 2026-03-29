import type { LogFn } from '../../framework/hook-io.js';
import type {
  StopSyncInputReader,
  StopSyncStateGateway,
  StopSyncUseCaseResult,
} from '../contracts/stop-sync.js';

export interface StopSyncUseCaseDeps {
  inputReader: StopSyncInputReader;
  stateGateway: StopSyncStateGateway;
  log: LogFn;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class StopSyncUseCase {
  private readonly inputReader: StopSyncInputReader;
  private readonly stateGateway: StopSyncStateGateway;
  private readonly log: LogFn;

  constructor(deps: StopSyncUseCaseDeps) {
    this.inputReader = deps.inputReader;
    this.stateGateway = deps.stateGateway;
    this.log = deps.log;
  }

  async execute(): Promise<StopSyncUseCaseResult> {
    try {
      const hookInput = await this.inputReader.readInput();

      if (!hookInput?.cwd) {
        this.log('Missing cwd, skipping');
        return { shouldOutput: false };
      }

      const mode = this.stateGateway.getMode(hookInput.cwd);
      if (mode === 'off') {
        return { shouldOutput: false };
      }

      if (hookInput.session_id && hookInput.transcript_path) {
        this.stateGateway.ensureContinuousWorker(
          hookInput.session_id,
          hookInput.cwd,
          this.stateGateway.getSdkToolsMode(hookInput.cwd),
        );
        this.stateGateway.mirrorClaudeTranscript(
          hookInput.cwd,
          hookInput.session_id,
          hookInput.transcript_path,
        );
      }

      let foregroundPreview = this.stateGateway.peekUnreadAgentMessages(
        hookInput.cwd,
        this.log,
      );
      if (foregroundPreview.length === 0 && hookInput.transcript_path) {
        for (let attempt = 0; attempt < 4; attempt++) {
          await sleep(300);
          foregroundPreview = this.stateGateway.peekUnreadAgentMessages(
            hookInput.cwd,
            this.log,
          );
          if (foregroundPreview.length > 0) {
            break;
          }
        }
      }

      if (foregroundPreview.length === 0) {
        this.log('No foreground messages, allowing stop');
        return { shouldOutput: false };
      }

      const foregroundMessages = this.stateGateway.fetchUnreadAgentMessages(
        hookInput.cwd,
        this.log,
      );
      if (foregroundMessages.length === 0) {
        this.log('Foreground preview was stale, allowing stop');
        return { shouldOutput: false };
      }

      this.log(
        `Found ${foregroundMessages.length} foreground message(s), blocking stop`,
      );

      const formattedMessages = this.stateGateway.formatMessagesForHookContext(
        foregroundMessages,
      );
      const reason =
        `${formattedMessages}\n\n` +
        `${this.stateGateway.generateForegroundInstruction(foregroundMessages)}`;

      return {
        shouldOutput: true,
        output: JSON.stringify({
          decision: 'block',
          reason,
        }),
      };
    } catch (error) {
      this.log(`Error: ${error}`);
      return { shouldOutput: false };
    }
  }
}
