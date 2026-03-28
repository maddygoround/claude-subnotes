import * as fs from 'fs';
import * as path from 'path';

export type StoreLogFn = (message: string) => void;

export interface LockOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  staleMs?: number;
  log?: StoreLogFn;
}

export interface JsonFileOptions<T> extends LockOptions {
  defaultValue: T;
}

interface LockMetadata {
  pid: number;
  createdAt: string;
}

const DEFAULT_LOCK_TIMEOUT_MS = 1500;
const DEFAULT_LOCK_RETRY_DELAY_MS = 25;
const DEFAULT_LOCK_STALE_MS = 15000;
const DEFAULT_FILE_MODE = 0o600;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sleepMs(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === 'EPERM';
  }
}

function safeUnlink(filePath: string, log?: StoreLogFn): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      log?.(`Failed to remove ${path.basename(filePath)}: ${error}`);
    }
    return false;
  }
}

function writeLockMetadata(fd: number): void {
  const metadata: LockMetadata = {
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(fd, JSON.stringify(metadata), 'utf-8');
  fs.fsyncSync(fd);
}

function tryBreakStaleLock(
  lockFile: string,
  staleMs: number,
  log?: StoreLogFn,
): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockFile);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === 'ENOENT';
  }

  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs < staleMs) {
    return false;
  }

  try {
    const raw = fs.readFileSync(lockFile, 'utf-8').trim();
    if (raw) {
      const metadata = JSON.parse(raw) as Partial<LockMetadata>;
      if (
        typeof metadata.pid === 'number' &&
        metadata.pid > 0 &&
        isProcessRunning(metadata.pid)
      ) {
        return false;
      }
    }
  } catch (error) {
    log?.(`Failed to inspect stale lock ${path.basename(lockFile)}: ${error}`);
  }

  const removed = safeUnlink(lockFile, log);
  if (removed) {
    log?.(`Removed stale lock ${path.basename(lockFile)}`);
  }
  return removed;
}

function renameAtomic(tempPath: string, finalPath: string): void {
  try {
    fs.renameSync(tempPath, finalPath);
    return;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (
      process.platform === 'win32' &&
      (err.code === 'EEXIST' || err.code === 'EPERM')
    ) {
      safeUnlink(finalPath);
      fs.renameSync(tempPath, finalPath);
      return;
    }
    throw error;
  }
}

function writeTextFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tempFile = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = fs.openSync(tempFile, 'w', DEFAULT_FILE_MODE);
  try {
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    renameAtomic(tempFile, filePath);
  } catch (error) {
    safeUnlink(tempFile);
    throw error;
  }
}

export function withProcessLock<T>(
  lockFile: string,
  fn: () => T,
  options: LockOptions = {},
): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const log = options.log;
  const deadline = Date.now() + timeoutMs;

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  while (true) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockFile, 'wx', DEFAULT_FILE_MODE);
      writeLockMetadata(fd);
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        safeUnlink(lockFile, log);
      }
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close errors while cleaning up a failed lock attempt.
        }
      }

      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }

      if (tryBreakStaleLock(lockFile, staleMs, log)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for lock ${path.basename(lockFile)}`,
        );
      }

      sleepMs(retryDelayMs);
    }
  }
}

export function readJsonFileWithFallback<T>(
  filePath: string,
  defaultValue: T,
  log?: StoreLogFn,
): T {
  const candidates = [filePath, `${filePath}.bak`];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    try {
      const data = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as T;
      if (candidate !== filePath) {
        log?.(
          `Recovered ${path.basename(filePath)} from backup ${path.basename(candidate)}`,
        );
      }
      return data;
    } catch (error) {
      log?.(`Failed to parse ${path.basename(candidate)}: ${error}`);
    }
  }

  return cloneJsonValue(defaultValue);
}

export function writeJsonFileAtomic<T>(
  filePath: string,
  value: T,
  log?: StoreLogFn,
): void {
  const serialized = JSON.stringify(value, null, 2);
  writeTextFileAtomic(filePath, serialized);

  try {
    writeTextFileAtomic(`${filePath}.bak`, serialized);
  } catch (error) {
    log?.(`Failed to refresh backup for ${path.basename(filePath)}: ${error}`);
  }
}

export function updateJsonFile<T, R>(
  filePath: string,
  options: JsonFileOptions<T>,
  mutator: (current: T) => { next: T; result: R },
): R {
  const lockFile = `${filePath}.lock`;
  return withProcessLock(
    lockFile,
    () => {
      const current = readJsonFileWithFallback(
        filePath,
        options.defaultValue,
        options.log,
      );
      const { next, result } = mutator(current);
      writeJsonFileAtomic(filePath, next, options.log);
      return result;
    },
    options,
  );
}
