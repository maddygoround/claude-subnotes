import type { LogFn } from '../../framework/hook-io.js';
import {
  cleanupStaleContinuousWorkerArtifacts,
  getContinuousWorkerPidFile,
  getTempStateDir,
} from '../../conversation_utils.js';
import type {
  StopContinuousWorkerGateway,
} from '../contracts/stop-continuous-worker.js';

export class DefaultStopContinuousWorkerGateway
implements StopContinuousWorkerGateway {
  getContinuousWorkerPidFile(sessionId: string, cwd: string): string {
    return getContinuousWorkerPidFile(sessionId, cwd);
  }

  getTempStateDir(): string {
    return getTempStateDir();
  }

  cleanupStaleContinuousWorkerArtifacts(log: LogFn): void {
    cleanupStaleContinuousWorkerArtifacts(log);
  }
}
