import type { LogFn } from '../../framework/hook-io.js';

export interface StopContinuousWorkerHookInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
  reason?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

export interface StopContinuousWorkerInputReader {
  readInput(): Promise<StopContinuousWorkerHookInput>;
}

export interface StopContinuousWorkerGateway {
  getContinuousWorkerPidFile(sessionId: string, cwd: string): string;
  getTempStateDir(): string;
  cleanupStaleContinuousWorkerArtifacts(log: LogFn): void;
}
