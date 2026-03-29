import { readHookInput } from '../../framework/index.js';
import type {
  SyncLocalMemoryHookInput,
  SyncLocalMemoryInputReader,
} from '../contracts/sync-local-memory.js';

export class StdinSyncLocalMemoryInputReader
implements SyncLocalMemoryInputReader {
  async readInput(): Promise<SyncLocalMemoryHookInput | null> {
    return readHookInput<SyncLocalMemoryHookInput>();
  }
}
