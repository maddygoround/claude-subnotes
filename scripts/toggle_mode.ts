#!/usr/bin/env tsx
/**
 * Continuous Architecture Config Helper
 *
 * SubNotes now uses continuous updates as the only timing model.
 * This script keeps compatibility with older workflows by normalizing config.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDurableStateDir, getSdkToolsMode } from './conversation_utils.js';

interface Config {
  architecture?: string;
  updateMode?: string;
  sdkToolsMode?: 'read-only' | 'full' | 'off';
}

function normalizeConfig(cwd: string): Config {
  const configPath = path.join(getDurableStateDir(cwd), 'config.json');
  let existing: Config = {};

  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      existing = {};
    }
  }

  return {
    ...existing,
    architecture: 'continuous',
    sdkToolsMode: existing.sdkToolsMode || getSdkToolsMode(),
  };
}

function saveConfig(cwd: string, config: Config): void {
  const configPath = path.join(getDurableStateDir(cwd), 'config.json');
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] !== 'continuous') {
    console.error('Update timing modes are deprecated. SubNotes runs in continuous mode only.');
    console.error('Usage: toggle_mode.ts [continuous]');
    process.exit(1);
  }

  const cwd = process.cwd();
  const config = normalizeConfig(cwd);
  saveConfig(cwd, config);

  console.log('SubNotes update architecture: continuous (fixed)');
  console.log('Visibility mode still uses SUBNOTES_MODE: whisper | full | off');
}

main().catch((error) => {
  console.error('Error normalizing mode config:', error);
  process.exit(1);
});
