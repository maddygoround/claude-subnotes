import * as os from 'os';
import type { HomeDirectoryProvider } from '../contracts/session-start.js';

export class ProcessHomeDirectoryProvider implements HomeDirectoryProvider {
  getHomeDirectory(): string {
    return process.env.HOME || os.homedir();
  }
}
