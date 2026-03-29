import { readHookInput } from '../../framework/index.js';
import type {
  PreToolHookInput,
  PreToolInputReader,
} from '../contracts/pretool-sync.js';

export class StdinPreToolInputReader implements PreToolInputReader {
  async readInput(): Promise<PreToolHookInput | null> {
    return readHookInput<PreToolHookInput>();
  }
}
