import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

function getCanonicalRepoPath(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    const realPath = fs.realpathSync.native
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
    return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  } catch {
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

export function getRepoNamespace(cwd: string): string {
  const canonical = getCanonicalRepoPath(cwd);
  return createHash('sha1').update(canonical).digest('hex').slice(0, 12);
}

function getLegacySharedStateDir(cwd: string): string {
  // SUBNOTES_HOME is the only value that stays as an env var -
  // it determines where the config file itself lives.
  const sharedHome = process.env.SUBNOTES_HOME;
  const base = sharedHome || cwd;
  return path.join(base, '.subnotes');
}

export function getDurableStateDir(cwd: string): string {
  // SUBNOTES_HOME is the only value read from env -
  // it determines the root location of all state including config.json.
  const sharedHome = process.env.SUBNOTES_HOME;
  if (!sharedHome) {
    return path.join(cwd, '.subnotes');
  }

  const namespace = getRepoNamespace(cwd);
  return path.join(sharedHome, '.subnotes', namespace);
}

export function getSyncStateFile(cwd: string, sessionId: string): string {
  const namespace = getRepoNamespace(cwd);
  return path.join(getDurableStateDir(cwd), `session-${namespace}-${sessionId}.json`);
}

export function getLegacySyncStateFile(cwd: string, sessionId: string): string {
  return path.join(getLegacySharedStateDir(cwd), `session-${sessionId}.json`);
}

export function getMemoryFile(cwd: string): string {
  return path.join(getDurableStateDir(cwd), 'memory.json');
}

export function ensureDurableStateDir(cwd: string): void {
  const dir = getDurableStateDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
