import { readHookInput } from '../../framework/index.js';
import type {
  StopHookInput,
  StopSyncInputReader,
} from '../contracts/stop-sync.js';

export class StdinStopSyncInputReader implements StopSyncInputReader {
  async readInput(): Promise<StopHookInput | null> {
    return readHookInput<StopHookInput>();
  }
}
