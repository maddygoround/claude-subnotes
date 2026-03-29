/**
 * Process-related helpers shared across worker/state modules.
 */

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // EPERM means the process exists but current user cannot signal it.
    return err.code === 'EPERM';
  }
}
