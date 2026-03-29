import { readHookInputStrict } from '../../framework/index.js';
import type {
  StopContinuousWorkerHookInput,
  StopContinuousWorkerInputReader,
} from '../contracts/stop-continuous-worker.js';

export class StdinStopContinuousWorkerInputReader
implements StopContinuousWorkerInputReader {
  async readInput(): Promise<StopContinuousWorkerHookInput> {
    return readHookInputStrict<StopContinuousWorkerHookInput>();
  }
}
