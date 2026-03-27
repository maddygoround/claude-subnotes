/**
 * Hook I/O Framework
 *
 * Consolidated I/O boilerplate shared across all hook scripts:
 * - stdin JSON reader
 * - File logger (timestamped)
 * - Debug logger (gated on SUBNOTES_DEBUG)
 * - TTY writer
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ============================================
// Hook Input Reader
// ============================================

export interface BaseHookInput {
  session_id: string;
  cwd: string;
  hook_event_name?: string;
}

/**
 * Read hook input from stdin as JSON.
 * Generic — callers can extend BaseHookInput with extra fields.
 *
 * @param timeoutMs  Max wait time for stdin (default 100ms)
 * @returns Parsed input or null if stdin is empty/unparseable
 */
export async function readHookInput<T extends BaseHookInput>(
  timeoutMs: number = 100,
): Promise<T | null> {
  return new Promise((resolve) => {
    let input = '';
    const rl = readline.createInterface({ input: process.stdin });

    rl.on('line', (line) => {
      input += line;
    });

    rl.on('close', () => {
      if (!input.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(input) as T);
      } catch {
        resolve(null);
      }
    });

    setTimeout(() => {
      rl.close();
    }, timeoutMs);
  });
}

/**
 * Blocking stdin reader variant used by hooks that need full stdin
 * (session_start, send_messages_to_local).
 * Does not use a timeout — waits for stdin EOF.
 */
export async function readHookInputStrict<T extends BaseHookInput>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data) as T);
      } catch (e) {
        reject(new Error(`Failed to parse hook input: ${e}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

// ============================================
// Logging
// ============================================

export type LogFn = (message: string) => void;

/** No-op logger for optional log parameters */
export const noopLog: LogFn = () => {};

/**
 * Create a file logger that writes timestamped lines to the given path.
 * Ensures the parent directory exists on first write.
 */
export function createFileLogger(logFile: string): LogFn {
  let dirEnsured = false;

  return (message: string): void => {
    if (!dirEnsured) {
      const dir = fs.mkdirSync(
        path.dirname(logFile),
        { recursive: true },
      );
      dirEnsured = true;
    }
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
  };
}

/**
 * Create a debug logger gated on SUBNOTES_DEBUG=1.
 * Writes to stderr with a prefix.
 */
export function createDebugLogger(prefix: string): LogFn {
  const enabled = process.env.SUBNOTES_DEBUG === '1';
  if (!enabled) return noopLog;

  return (...args: unknown[]): void => {
    console.error(`[${prefix} debug]`, ...args);
  };
}

// ============================================
// TTY Output
// ============================================

/**
 * Open /dev/tty for direct user-visible output.
 * Returns a write function and a close function.
 * Falls back to no-ops if TTY is unavailable.
 */
export function openTty(): { write: (text: string) => void; close: () => void } {
  let tty: fs.WriteStream | null = null;
  try {
    tty = fs.createWriteStream('/dev/tty');
  } catch {
    // TTY not available
  }

  return {
    write: (text: string) => {
      if (tty) tty.write(text);
    },
    close: () => {
      if (tty) tty.end();
    },
  };
}
