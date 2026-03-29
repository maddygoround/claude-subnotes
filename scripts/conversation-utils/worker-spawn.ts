import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx';

export function spawnSilentWorker(
  workerScript: string,
  payloadFile: string,
  cwd: string,
): ChildProcess {
  const isWindows = process.platform === 'win32';
  let child: ChildProcess;

  if (isWindows) {
    const silentLauncher = path.join(__dirname, '..', '..', 'hooks', 'silent-launcher.exe');
    const tsxCli = path.join(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const workerEnv = { ...process.env };
    delete workerEnv.SL_STDIN_FILE;
    delete workerEnv.SL_STDOUT_FILE;
    if (fs.existsSync(silentLauncher) && fs.existsSync(tsxCli)) {
      child = spawn(silentLauncher, ['node', tsxCli, workerScript, payloadFile], {
        detached: true,
        stdio: 'ignore',
        cwd,
        env: workerEnv,
        windowsHide: true,
      });
    } else if (fs.existsSync(tsxCli)) {
      child = spawn(process.execPath, [tsxCli, workerScript, payloadFile], {
        stdio: 'ignore',
        cwd,
        env: workerEnv,
        windowsHide: true,
      });
    } else {
      child = spawn(NPX_CMD, ['tsx', workerScript, payloadFile], {
        stdio: 'ignore',
        cwd,
        env: workerEnv,
        shell: true,
        windowsHide: true,
      });
    }
  } else {
    child = spawn(NPX_CMD, ['tsx', workerScript, payloadFile], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
  }
  child.unref();
  return child;
}
