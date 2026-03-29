import { readHookInputStrict } from '../../framework/index.js';
import type {
  SessionStartHookInput,
  SessionStartInputReader,
} from '../contracts/session-start.js';

export class StdinSessionStartInputReader implements SessionStartInputReader {
  async readInput(): Promise<SessionStartHookInput> {
    return readHookInputStrict<SessionStartHookInput>();
  }
}
