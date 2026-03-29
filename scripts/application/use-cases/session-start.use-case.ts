import type { LogFn } from '../../framework/hook-io.js';
import type {
  HomeDirectoryProvider,
  SessionStartInputReader,
  SessionStartStateGateway,
} from '../contracts/session-start.js';

export interface SessionStartUseCaseDeps {
  inputReader: SessionStartInputReader;
  stateGateway: SessionStartStateGateway;
  homeDirectoryProvider: HomeDirectoryProvider;
  log: LogFn;
}

export class SessionStartUseCase {
  private readonly inputReader: SessionStartInputReader;
  private readonly stateGateway: SessionStartStateGateway;
  private readonly homeDirectoryProvider: HomeDirectoryProvider;
  private readonly log: LogFn;

  constructor(deps: SessionStartUseCaseDeps) {
    this.inputReader = deps.inputReader;
    this.stateGateway = deps.stateGateway;
    this.homeDirectoryProvider = deps.homeDirectoryProvider;
    this.log = deps.log;
  }

  async execute(): Promise<void> {
    this.log('='.repeat(60));
    this.log('session_start.ts started');

    const hookInput = await this.inputReader.readInput();
    this.log(`Hook input: session_id=${hookInput.session_id}, cwd=${hookInput.cwd}`);

    const mode = this.stateGateway.getMode(hookInput.cwd);
    this.log(`Mode: ${mode}`);
    if (mode === 'off') {
      this.log('Mode is off, exiting');
      return;
    }

    const memoryBlocks = this.stateGateway.loadLocalMemory(hookInput.cwd, this.log);
    this.stateGateway.syncClaudeMdFromMemory(hookInput.cwd, memoryBlocks);

    this.stateGateway.ensureConfigFile(hookInput.cwd, this.log);
    this.stateGateway.loadConfig(hookInput.cwd);

    this.stateGateway.saveSyncState(
      hookInput.cwd,
      {
        sessionId: hookInput.session_id,
        lastProcessedIndex: -1,
      },
      this.log,
    );

    const sdkToolsMode = this.stateGateway.getSdkToolsMode(hookInput.cwd);
    const worker = this.stateGateway.ensureContinuousWorker(
      hookInput.session_id,
      hookInput.cwd,
      sdkToolsMode,
      this.log,
    );
    if (worker) {
      this.log(`Spawned continuous worker (PID: ${worker.pid})`);
    } else {
      this.log('Continuous worker already running');
    }

    const homeDir = this.homeDirectoryProvider.getHomeDirectory();
    if (homeDir !== hookInput.cwd) {
      this.log('Cleaning up legacy global ~/.claude/CLAUDE.md content...');
      this.stateGateway.cleanSubNotesFromClaudeMd(homeDir);
    }

    this.log('Project CLAUDE.md synced from .subnotes');
    this.log('Completed successfully');
  }
}
