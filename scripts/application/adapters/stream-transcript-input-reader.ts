import { readHookInput } from '../../framework/index.js';
import type {
  StreamTranscriptHookInput,
  StreamTranscriptInputReader,
} from '../contracts/stream-transcript.js';

export class StdinStreamTranscriptInputReader
implements StreamTranscriptInputReader {
  async readInput(): Promise<StreamTranscriptHookInput | null> {
    return readHookInput<StreamTranscriptHookInput>();
  }
}
