import * as fs from 'fs';

/**
 * Read and validate a PID from disk.
 *
 * Returns null when the PID cannot be read or is invalid.
 */
export function readPidFromFile(
  pidFilePath: string,
  onReadError?: (error: unknown) => void,
): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFilePath, 'utf-8').trim(), 10);
    return Number.isNaN(pid) || pid <= 0 ? null : pid;
  } catch (error) {
    onReadError?.(error);
    return null;
  }
}
