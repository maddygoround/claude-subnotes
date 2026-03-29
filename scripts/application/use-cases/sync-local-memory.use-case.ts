import type { LogFn } from '../../framework/hook-io.js';
import type {
  SyncLocalMemoryInputReader,
  SyncLocalMemoryStateGateway,
  SyncLocalMemoryUseCaseResult,
} from '../contracts/sync-local-memory.js';

export interface SyncLocalMemoryUseCaseDeps {
  inputReader: SyncLocalMemoryInputReader;
  stateGateway: SyncLocalMemoryStateGateway;
  log: LogFn;
}

export class SyncLocalMemoryUseCase {
  private readonly inputReader: SyncLocalMemoryInputReader;
  private readonly stateGateway: SyncLocalMemoryStateGateway;
  private readonly log: LogFn;

  constructor(deps: SyncLocalMemoryUseCaseDeps) {
    this.inputReader = deps.inputReader;
    this.stateGateway = deps.stateGateway;
    this.log = deps.log;
  }

  async execute(projectDir: string): Promise<SyncLocalMemoryUseCaseResult> {
    const hookInput = await this.inputReader.readInput();
    const cwd = hookInput?.cwd || projectDir;
    const sessionId = hookInput?.session_id;
    const mode = this.stateGateway.getMode(cwd);

    if (mode === 'off') {
      return { shouldOutput: false };
    }

    const state = sessionId
      ? this.stateGateway.loadSyncState(cwd, sessionId, this.log)
      : null;
    const lastBlockValues = state?.lastBlockValues || null;

    const memoryBlocks = this.stateGateway.loadLocalMemory(cwd, this.log);
    const foregroundMessages = this.stateGateway.fetchUnreadAgentMessages(
      cwd,
      this.log,
    );
    const changedBlocks = this.stateGateway.detectChangedBlocks(
      memoryBlocks,
      lastBlockValues,
    );

    this.stateGateway.syncClaudeMdFromMemory(cwd, memoryBlocks);

    if (state) {
      state.lastBlockValues = this.stateGateway.snapshotBlockValues(memoryBlocks);
    }

    const outputs: string[] = [];
    if (mode === 'full') {
      const isFirstPrompt = !lastBlockValues;

      if (isFirstPrompt) {
        outputs.push(this.stateGateway.formatAllBlocksForStdout(memoryBlocks, cwd));
      } else {
        const changedBlocksOutput = this.stateGateway.formatChangedBlocksAsXml(
          changedBlocks,
          lastBlockValues,
          true,
        );
        if (changedBlocksOutput) {
          outputs.push(changedBlocksOutput);
        }
      }
    }

    if (foregroundMessages.length > 0) {
      outputs.push(this.stateGateway.formatMessagesForHookContext(foregroundMessages));
      outputs.push(this.stateGateway.generateForegroundInstruction(foregroundMessages));
    }

    if (lastBlockValues && changedBlocks.length > 0) {
      outputs.push(
        `<instruction>Notes updated memory blocks since your last response (shown above). If this affects your answer, acknowledge it:\n\n---\n\n**Notes update** — [what changed and why it matters]\n\nOmit if not relevant to the current conversation.</instruction>`,
      );
    }

    if (state && sessionId) {
      this.stateGateway.saveSyncState(cwd, state, this.log);
    }

    if (outputs.length === 0) {
      return { shouldOutput: false };
    }

    const hookEventName =
      hookInput?.hook_event_name === 'SessionStart'
        ? 'SessionStart'
        : 'UserPromptSubmit';

    return {
      shouldOutput: true,
      output: JSON.stringify({
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName,
          additionalContext: outputs.join('\n\n'),
        },
      }),
    };
  }
}
