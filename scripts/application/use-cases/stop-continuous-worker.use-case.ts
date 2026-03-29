import * as fs from 'fs';
import * as path from 'path';
import type { LogFn } from '../../framework/hook-io.js';
import { readPidFromFile } from '../../framework/utils/pid.js';
import type {
  StopContinuousWorkerGateway,
  StopContinuousWorkerHookInput,
  StopContinuousWorkerInputReader,
} from '../contracts/stop-continuous-worker.js';

export interface StopContinuousWorkerUseCaseDeps {
  inputReader: StopContinuousWorkerInputReader;
  gateway: StopContinuousWorkerGateway;
  log: LogFn;
}

function shouldStopOnHook(input: StopContinuousWorkerHookInput, log: LogFn): boolean {
  if (input.hook_event_name !== 'SessionEnd') {
    log(
      `Ignoring hook event ${String(input.hook_event_name || 'unknown')} (expected SessionEnd)`,
    );
    return false;
  }
  return true;
}

export class StopContinuousWorkerUseCase {
  private readonly inputReader: StopContinuousWorkerInputReader;
  private readonly gateway: StopContinuousWorkerGateway;
  private readonly log: LogFn;

  constructor(deps: StopContinuousWorkerUseCaseDeps) {
    this.inputReader = deps.inputReader;
    this.gateway = deps.gateway;
    this.log = deps.log;
  }

  private removePidFileIfMatches(
    pidFilePath: string,
    expectedPid: number,
  ): void {
    if (!fs.existsSync(pidFilePath)) {
      return;
    }

    const currentPid = readPidFromFile(pidFilePath);
    if (currentPid === null) {
      fs.unlinkSync(pidFilePath);
      this.log(`Removed unreadable PID file: ${pidFilePath}`);
      return;
    }

    if (currentPid !== expectedPid) {
      this.log(
        `Skipping PID file removal for ${pidFilePath}; ownership moved to PID ${currentPid}`,
      );
      return;
    }

    fs.unlinkSync(pidFilePath);
    this.log(`Removed PID file: ${pidFilePath}`);
  }

  private stopContinuousWorker(sessionId: string, cwd: string): void {
    const tempStateDir = this.gateway.getTempStateDir();
    const pidFilePaths = [
      this.gateway.getContinuousWorkerPidFile(sessionId, cwd),
      path.join(tempStateDir, `continuous-worker-${sessionId}.pid`),
    ];

    for (const pidFilePath of pidFilePaths) {
      if (!fs.existsSync(pidFilePath)) {
        continue;
      }

      let pid: number | null = null;
      try {
        pid = readPidFromFile(pidFilePath);

        if (pid === null) {
          fs.unlinkSync(pidFilePath);
          this.log(`Removed invalid PID file: ${pidFilePath}`);
          continue;
        }

        process.kill(pid, 'SIGTERM');
        this.log(`Stopped continuous worker for session ${sessionId} (PID ${pid})`);
      } catch (error: unknown) {
        const killError = error as { code?: string };
        if (killError.code !== 'ESRCH') {
          this.log(
            `Error stopping continuous worker for session ${sessionId}: ${String(error)}`,
          );
        }
      } finally {
        if (pid !== null) {
          this.removePidFileIfMatches(pidFilePath, pid);
        }
      }
    }
  }

  async execute(): Promise<void> {
    this.log('='.repeat(60));
    const hookInput = await this.inputReader.readInput();
    this.log(
      `Hook input received: event=${String(
        hookInput.hook_event_name || 'unknown',
      )}, reason=${String(hookInput.reason || 'n/a')}`,
    );

    if (!shouldStopOnHook(hookInput, this.log)) {
      return;
    }

    const sessionId = hookInput.session_id;
    const cwd = hookInput.cwd;
    if (!sessionId || !cwd) {
      this.log('Missing session_id or cwd in SessionEnd hook input; skipping stop');
      return;
    }

    this.stopContinuousWorker(sessionId, cwd);
    this.gateway.cleanupStaleContinuousWorkerArtifacts(this.log);
  }
}
