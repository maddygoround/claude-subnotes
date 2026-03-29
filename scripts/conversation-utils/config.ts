import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeJsonFileAtomic } from '../state_store.js';
import {
  parseSdkToolsMode,
  parseSubNotesMode,
} from '../framework/utils/sdk-tools-mode.js';
import {
  ensureDurableStateDir,
  getDurableStateDir,
} from './state-paths.js';

type ConfigLogFn = (message: string) => void;
const noopLog: ConfigLogFn = () => {};

export type SubNotesMode = 'whisper' | 'full' | 'off';
export type SdkToolsMode = 'read-only' | 'full' | 'off';

/**
 * Complete configuration for Claude Reflect.
 * All values are stored in `.subnotes/config.json`.
 * No settings come from environment variables.
 */
export interface ReflectConfig {
  // Core
  mode: SubNotesMode;
  sdkToolsMode: SdkToolsMode;
  architecture: 'continuous' | 'oneshot';
  autonomic: boolean;
  debug: boolean;

  // Worker tuning
  checkIntervalMs: number;
  minMessages: number;
  idleTimeoutMs: number;
  maxContinuations: number;

  // Autonomic tuning
  crystallizeInterval: number;
  minObservations: number;

  // API keys
  anthropicApiKey: string;
  anthropicModel: string;
  exaApiKey: string;

  // Project overrides
  projectDir: string | null;

  // Sentinel tuning
  sentinelThrashingThreshold: number;
  sentinelThrashingWindowMs: number;
  sentinelTestLoopThreshold: number;
  sentinelErrorCascadeThreshold: number;
  sentinelErrorCascadeWindowMs: number;
  sentinelOverwriteWindowMs: number;

  // Crystallizer tuning
  crystallizerMinClusterSize: number;
  crystallizerClusterWindowMs: number;
  crystallizerInitialConfidence: number;
  crystallizerConfidenceBump: number;
  crystallizerMaxConfidence: number;
  crystallizerModel: string;

  // Tuner sensitivity
  tunerIgnoreRateThreshold: number;
  tunerRetryRateThreshold: number;
  tunerOverrideRateThreshold: number;
  tunerOutcomeLookahead: number;
  tunerMaxUnresolvedAgeMs: number;
}

const DEFAULT_CONFIG: ReflectConfig = {
  mode: 'whisper',
  sdkToolsMode: 'read-only',
  architecture: 'continuous',
  autonomic: true,
  debug: false,
  checkIntervalMs: 1000,
  minMessages: 1,
  idleTimeoutMs: 1800000,
  maxContinuations: 2,
  crystallizeInterval: 10,
  minObservations: 5,
  anthropicApiKey: '',
  anthropicModel: 'claude-sonnet-4-6',
  exaApiKey: '',
  projectDir: null,
  // Sentinel defaults
  sentinelThrashingThreshold: 5,
  sentinelThrashingWindowMs: 10 * 60 * 1000,
  sentinelTestLoopThreshold: 3,
  sentinelErrorCascadeThreshold: 3,
  sentinelErrorCascadeWindowMs: 5 * 60 * 1000,
  sentinelOverwriteWindowMs: 60 * 1000,
  // Crystallizer defaults
  crystallizerMinClusterSize: 3,
  crystallizerClusterWindowMs: 15 * 60 * 1000,
  crystallizerInitialConfidence: 0.25,
  crystallizerConfidenceBump: 0.05,
  crystallizerMaxConfidence: 0.7,
  crystallizerModel: 'claude-haiku-3-5-20250815',
  // Tuner sensitivity defaults
  tunerIgnoreRateThreshold: 0.4,
  tunerRetryRateThreshold: 0.2,
  tunerOverrideRateThreshold: 0.1,
  tunerOutcomeLookahead: 10,
  tunerMaxUnresolvedAgeMs: 30 * 60 * 1000,
};

/** Per-process config cache — loaded once per cwd */
let _configCache: ReflectConfig | null = null;
let _configCacheDir: string | null = null;

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return fallback;
}

function parsePositiveFloat(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

/**
 * Load configuration from `.subnotes/config.json`.
 * Cached per-process for the lifetime of the script.
 * Falls back to defaults for any missing keys.
 */
export function loadConfig(cwd: string): ReflectConfig {
  if (_configCache && _configCacheDir === cwd) {
    return _configCache;
  }

  const configPath = path.join(getDurableStateDir(cwd), 'config.json');
  let fileData: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      fileData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // Corrupted config — use all defaults
      fileData = {};
    }
  }

  const config: ReflectConfig = {
    mode: parseSubNotesMode(fileData.mode),
    sdkToolsMode: parseSdkToolsMode(fileData.sdkToolsMode),
    architecture: fileData.architecture === 'oneshot' ? 'oneshot' : 'continuous',
    autonomic: fileData.autonomic !== false,
    debug: fileData.debug === true,
    checkIntervalMs: parsePositiveInt(fileData.checkIntervalMs, DEFAULT_CONFIG.checkIntervalMs),
    minMessages: parsePositiveInt(fileData.minMessages, DEFAULT_CONFIG.minMessages),
    idleTimeoutMs: parsePositiveInt(fileData.idleTimeoutMs, DEFAULT_CONFIG.idleTimeoutMs),
    maxContinuations: parsePositiveInt(fileData.maxContinuations, DEFAULT_CONFIG.maxContinuations),
    crystallizeInterval: parsePositiveInt(fileData.crystallizeInterval, DEFAULT_CONFIG.crystallizeInterval),
    minObservations: parsePositiveInt(fileData.minObservations, DEFAULT_CONFIG.minObservations),
    anthropicApiKey: typeof fileData.anthropicApiKey === 'string' && fileData.anthropicApiKey
      ? fileData.anthropicApiKey
      : (process.env.ANTHROPIC_API_KEY || DEFAULT_CONFIG.anthropicApiKey),
    anthropicModel: typeof fileData.anthropicModel === 'string' && fileData.anthropicModel ? fileData.anthropicModel : DEFAULT_CONFIG.anthropicModel,
    exaApiKey: typeof fileData.exaApiKey === 'string' && fileData.exaApiKey
      ? fileData.exaApiKey
      : (process.env.EXA_API_KEY || DEFAULT_CONFIG.exaApiKey),
    projectDir: typeof fileData.projectDir === 'string' && fileData.projectDir ? fileData.projectDir : null,
    // Sentinel
    sentinelThrashingThreshold: parsePositiveInt(fileData.sentinelThrashingThreshold, DEFAULT_CONFIG.sentinelThrashingThreshold),
    sentinelThrashingWindowMs: parsePositiveInt(fileData.sentinelThrashingWindowMs, DEFAULT_CONFIG.sentinelThrashingWindowMs),
    sentinelTestLoopThreshold: parsePositiveInt(fileData.sentinelTestLoopThreshold, DEFAULT_CONFIG.sentinelTestLoopThreshold),
    sentinelErrorCascadeThreshold: parsePositiveInt(fileData.sentinelErrorCascadeThreshold, DEFAULT_CONFIG.sentinelErrorCascadeThreshold),
    sentinelErrorCascadeWindowMs: parsePositiveInt(fileData.sentinelErrorCascadeWindowMs, DEFAULT_CONFIG.sentinelErrorCascadeWindowMs),
    sentinelOverwriteWindowMs: parsePositiveInt(fileData.sentinelOverwriteWindowMs, DEFAULT_CONFIG.sentinelOverwriteWindowMs),
    // Crystallizer
    crystallizerMinClusterSize: parsePositiveInt(fileData.crystallizerMinClusterSize, DEFAULT_CONFIG.crystallizerMinClusterSize),
    crystallizerClusterWindowMs: parsePositiveInt(fileData.crystallizerClusterWindowMs, DEFAULT_CONFIG.crystallizerClusterWindowMs),
    crystallizerInitialConfidence: parsePositiveFloat(fileData.crystallizerInitialConfidence, DEFAULT_CONFIG.crystallizerInitialConfidence),
    crystallizerConfidenceBump: parsePositiveFloat(fileData.crystallizerConfidenceBump, DEFAULT_CONFIG.crystallizerConfidenceBump),
    crystallizerMaxConfidence: parsePositiveFloat(fileData.crystallizerMaxConfidence, DEFAULT_CONFIG.crystallizerMaxConfidence),
    crystallizerModel: typeof fileData.crystallizerModel === 'string' && fileData.crystallizerModel ? fileData.crystallizerModel : DEFAULT_CONFIG.crystallizerModel,
    // Tuner
    tunerIgnoreRateThreshold: parsePositiveFloat(fileData.tunerIgnoreRateThreshold, DEFAULT_CONFIG.tunerIgnoreRateThreshold),
    tunerRetryRateThreshold: parsePositiveFloat(fileData.tunerRetryRateThreshold, DEFAULT_CONFIG.tunerRetryRateThreshold),
    tunerOverrideRateThreshold: parsePositiveFloat(fileData.tunerOverrideRateThreshold, DEFAULT_CONFIG.tunerOverrideRateThreshold),
    tunerOutcomeLookahead: parsePositiveInt(fileData.tunerOutcomeLookahead, DEFAULT_CONFIG.tunerOutcomeLookahead),
    tunerMaxUnresolvedAgeMs: parsePositiveInt(fileData.tunerMaxUnresolvedAgeMs, DEFAULT_CONFIG.tunerMaxUnresolvedAgeMs),
  };

  _configCache = config;
  _configCacheDir = cwd;
  return config;
}

/** Invalidate config cache (useful after writing config). */
export function invalidateConfigCache(): void {
  _configCache = null;
  _configCacheDir = null;
}

/**
 * Get the current operating mode.
 */
export function getMode(cwd?: string): SubNotesMode {
  if (cwd) return loadConfig(cwd).mode;
  // Fallback for callers that don't have cwd — check cache first
  if (_configCache) return _configCache.mode;
  return 'whisper';
}

/**
 * Ensure config.json exists with all default values.
 * Creates the file if it doesn't exist.
 * Merges any missing keys into an existing config (non-destructive).
 */
export function ensureConfigFile(
  cwd: string,
  log: ConfigLogFn = noopLog,
): void {
  const configPath = path.join(getDurableStateDir(cwd), 'config.json');
  ensureDurableStateDir(cwd);

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      existing = {};
    }
  }

  // Merge defaults for any missing keys
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG, ...existing };
  // Remove null projectDir from output if not set
  if (merged.projectDir === null) {
    delete merged.projectDir;
  }
  // Remove empty API keys from output to keep the file clean
  if (!merged.anthropicApiKey) delete merged.anthropicApiKey;
  if (!merged.exaApiKey) delete merged.exaApiKey;

  writeJsonFileAtomic(configPath, merged, log);
  invalidateConfigCache();
  log(`Config file ensured at ${configPath}`);
}

/**
 * Get user-specific temp state directory.
 */
export function getTempStateDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
  return path.join(os.tmpdir(), `subnotes-sync-${uid}`);
}

export const SDK_TOOLS_READ_ONLY = [
  'Read',
  'Grep',
  'Glob',
  'web_search',
  'fetch_webpage',
];
export const SDK_TOOLS_BLOCKED = [
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
];

export function getSdkToolsMode(cwd?: string): SdkToolsMode {
  if (cwd) return loadConfig(cwd).sdkToolsMode;
  if (_configCache) return _configCache.sdkToolsMode;
  return 'read-only';
}

/**
 * Check if the autonomic subconscious is enabled.
 * Controlled by `autonomic` field in config.json (default: true).
 */
export function isAutonomicEnabled(cwd?: string): boolean {
  if (cwd) return loadConfig(cwd).autonomic;
  if (_configCache) return _configCache.autonomic;
  return true;
}
