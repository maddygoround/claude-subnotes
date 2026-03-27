#!/usr/bin/env tsx
/**
 * Toggle SubNotes Update Mode
 *
 * Switches between continuous and on-stop modes.
 * Updates config file and manages worker lifecycle.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDurableStateDir, ensureContinuousWorker, getSdkToolsMode } from './conversation_utils.js';

interface Config {
  updateMode: 'continuous' | 'on-stop';
}

function getCurrentMode(cwd: string): 'continuous' | 'on-stop' {
  const configPath = path.join(getDurableStateDir(cwd), 'config.json');

  // Try config file first
  if (fs.existsSync(configPath)) {
    try {
      const config: Config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.updateMode || 'on-stop';
    } catch (e) {
      // Fall through to env var
    }
  }

  // Fall back to environment variable
  const envMode = process.env.SUBNOTES_UPDATE_MODE;
  if (envMode === 'continuous') {
    return 'continuous';
  }

  return 'on-stop';
}

function updateConfig(cwd: string, mode: 'continuous' | 'on-stop'): void {
  const configPath = path.join(getDurableStateDir(cwd), 'config.json');
  const config: Config = { updateMode: mode };

  // Ensure directory exists
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function stopContinuousWorker(cwd: string): boolean {
  const pidPath = path.join(getDurableStateDir(cwd), 'continuous-agent.pid');

  if (!fs.existsSync(pidPath)) {
    return false;
  }

  try {
    const pidContent = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(pidContent);

    if (isNaN(pid)) {
      fs.unlinkSync(pidPath);
      return false;
    }

    // Try to kill the process (use SIGKILL for npm wrapper)
    process.kill(pid, 'SIGKILL');

    // Remove PID file
    fs.unlinkSync(pidPath);

    return true;
  } catch (e) {
    // Process might already be dead
    if (fs.existsSync(pidPath)) {
      fs.unlinkSync(pidPath);
    }
    return false;
  }
}

function startContinuousWorker(cwd: string): number | null {
  const sessionId = process.env.SESSION_ID || `manual-${Date.now()}`;
  const sdkTools = getSdkToolsMode();

  const worker = ensureContinuousWorker(sessionId, cwd, sdkTools);
  return worker?.pid || null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const targetMode = args[0] as 'continuous' | 'on-stop' | undefined;
  const cwd = process.cwd();

  // Determine current and target modes
  const currentMode = getCurrentMode(cwd);
  const newMode = targetMode || (currentMode === 'continuous' ? 'on-stop' : 'continuous');

  // Validate target mode
  if (targetMode && !['continuous', 'on-stop'].includes(targetMode)) {
    console.error(`Invalid mode: ${targetMode}`);
    console.error('Usage: toggle_mode.ts [continuous|on-stop]');
    process.exit(1);
  }

  // Check if already in target mode
  if (currentMode === newMode) {
    console.log(`Already in ${newMode} mode.`);
    process.exit(0);
  }

  console.log(`\n🔄 Switching SubNotes mode: ${currentMode} → ${newMode}\n`);

  // Update configuration
  updateConfig(cwd, newMode);

  // Handle worker lifecycle
  if (newMode === 'continuous') {
    console.log('Starting continuous worker...');
    const pid = startContinuousWorker(cwd);

    if (pid) {
      console.log(`✓ Continuous mode enabled`);
      console.log(`  Worker PID: ${pid}`);
      console.log(`  Polling interval: ${process.env.SUBNOTES_CHECK_INTERVAL || '5000'}ms`);
      console.log(`\n📝 Real-time updates active:`);
      console.log(`  - Transcript streaming to .subnotes/transcript-*.jsonl`);
      console.log(`  - Memory updates during conversation`);
      console.log(`  - PreToolUse hook will inject frequent updates`);
    } else {
      console.log(`✓ Continuous mode enabled (worker already running)`);
    }
  } else {
    console.log('Stopping continuous worker...');
    const stopped = stopContinuousWorker(cwd);

    console.log(`✓ On-stop mode enabled`);
    if (stopped) {
      console.log(`  Continuous worker stopped`);
    }
    console.log(`\n📝 Post-session processing active:`);
    console.log(`  - Agent processes after conversation ends`);
    console.log(`  - Memory ready for next session`);
    console.log(`  - More efficient, less real-time`);
  }

  console.log(`\n💾 Configuration saved to .subnotes/config.json\n`);
}

main().catch(error => {
  console.error('Error toggling mode:', error);
  process.exit(1);
});
