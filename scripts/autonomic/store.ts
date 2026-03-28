/**
 * Autonomic Data Store
 *
 * JSON file-based storage for all autonomic data:
 * - Pattern records (System 1)
 * - Reflex rules (System 2)
 * - Intervention records (System 3)
 * - Meta-config (System 4)
 * - Observation log (append-only JSONL)
 *
 * All reads/writes use state_store.ts atomic operations for safety.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  readJsonFileWithFallback,
  writeJsonFileAtomic,
  withProcessLock,
} from '../state_store.js';
import { getDurableStateDir } from '../conversation_utils.js';
import type {
  PatternRecord,
  ReflexRule,
  InterventionRecord,
  MetaConfig,
  ObservationEntry,
  LogFn,
} from './types.js';
import { DEFAULT_META_CONFIG } from './types.js';

// ============================================
// Directory Management
// ============================================

const AUTONOMIC_DIR = 'autonomic';
const PATTERNS_FILE = 'patterns.json';
const REFLEXES_FILE = 'reflexes.json';
const INTERVENTIONS_FILE = 'interventions.json';
const META_CONFIG_FILE = 'meta-config.json';
const OBSERVATIONS_FILE = 'observations.jsonl';

const noopLog: LogFn = () => {};

/**
 * Get the autonomic data directory path.
 */
export function getAutonomicDir(cwd: string): string {
  return path.join(getDurableStateDir(cwd), AUTONOMIC_DIR);
}

/**
 * Ensure the autonomic data directory exists.
 */
export function ensureAutonomicDir(cwd: string): void {
  const dir = getAutonomicDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================
// Pattern Records
// ============================================

function getPatternsPath(cwd: string): string {
  return path.join(getAutonomicDir(cwd), PATTERNS_FILE);
}

/**
 * Load all pattern records.
 */
export function loadPatterns(cwd: string, log: LogFn = noopLog): PatternRecord[] {
  const filePath = getPatternsPath(cwd);
  const data = readJsonFileWithFallback<PatternRecord[]>(filePath, [], log);
  return Array.isArray(data) ? data : [];
}

/**
 * Save pattern records atomically.
 */
export function savePatterns(
  cwd: string,
  patterns: PatternRecord[],
  log: LogFn = noopLog,
): void {
  ensureAutonomicDir(cwd);
  const filePath = getPatternsPath(cwd);
  withProcessLock(
    `${filePath}.lock`,
    () => {
      writeJsonFileAtomic(filePath, patterns, log);
    },
    { log },
  );
}

// ============================================
// Reflex Rules
// ============================================

function getReflexesPath(cwd: string): string {
  return path.join(getAutonomicDir(cwd), REFLEXES_FILE);
}

/**
 * Load all reflex rules.
 * This is a HOT PATH — called on every PreToolUse hook.
 * Must be fast (< 5ms for typical rule counts).
 */
export function loadReflexRules(cwd: string, log: LogFn = noopLog): ReflexRule[] {
  const filePath = getReflexesPath(cwd);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const data = readJsonFileWithFallback<ReflexRule[]>(filePath, [], log);
  return Array.isArray(data) ? data.filter((r) => r.active) : [];
}

/**
 * Load all reflex rules including inactive ones (for the worker).
 */
export function loadAllReflexRules(cwd: string, log: LogFn = noopLog): ReflexRule[] {
  const filePath = getReflexesPath(cwd);
  const data = readJsonFileWithFallback<ReflexRule[]>(filePath, [], log);
  return Array.isArray(data) ? data : [];
}

/**
 * Save reflex rules atomically.
 */
export function saveReflexRules(
  cwd: string,
  rules: ReflexRule[],
  log: LogFn = noopLog,
): void {
  ensureAutonomicDir(cwd);
  const filePath = getReflexesPath(cwd);
  withProcessLock(
    `${filePath}.lock`,
    () => {
      writeJsonFileAtomic(filePath, rules, log);
    },
    { log },
  );
}

// ============================================
// Intervention Records
// ============================================

function getInterventionsPath(cwd: string): string {
  return path.join(getAutonomicDir(cwd), INTERVENTIONS_FILE);
}

/**
 * Load all intervention records.
 */
export function loadInterventions(
  cwd: string,
  log: LogFn = noopLog,
): InterventionRecord[] {
  const filePath = getInterventionsPath(cwd);
  const data = readJsonFileWithFallback<InterventionRecord[]>(filePath, [], log);
  return Array.isArray(data) ? data : [];
}

/**
 * Save intervention records atomically.
 */
export function saveInterventions(
  cwd: string,
  records: InterventionRecord[],
  log: LogFn = noopLog,
): void {
  ensureAutonomicDir(cwd);
  const filePath = getInterventionsPath(cwd);
  withProcessLock(
    `${filePath}.lock`,
    () => {
      writeJsonFileAtomic(filePath, records, log);
    },
    { log },
  );
}

/**
 * Append a single intervention record with locking.
 */
export function appendIntervention(
  cwd: string,
  record: InterventionRecord,
  log: LogFn = noopLog,
): void {
  ensureAutonomicDir(cwd);
  const filePath = getInterventionsPath(cwd);
  withProcessLock(
    `${filePath}.lock`,
    () => {
      const existing = readJsonFileWithFallback<InterventionRecord[]>(filePath, [], log);
      const records = Array.isArray(existing) ? existing : [];
      records.push(record);
      writeJsonFileAtomic(filePath, records, log);
    },
    { log },
  );
}

// ============================================
// Meta-Configuration
// ============================================

function getMetaConfigPath(cwd: string): string {
  return path.join(getAutonomicDir(cwd), META_CONFIG_FILE);
}

/**
 * Load meta-configuration with defaults.
 */
export function loadMetaConfig(cwd: string, log: LogFn = noopLog): MetaConfig {
  const filePath = getMetaConfigPath(cwd);
  const data = readJsonFileWithFallback<MetaConfig>(
    filePath,
    { ...DEFAULT_META_CONFIG, last_tuned: new Date().toISOString() },
    log,
  );

  // Ensure all fields exist with defaults
  return {
    thresholds: {
      ...DEFAULT_META_CONFIG.thresholds,
      ...(data.thresholds || {}),
    },
    communication_style: {
      ...DEFAULT_META_CONFIG.communication_style,
      ...(data.communication_style || {}),
    },
    prune_config: {
      ...DEFAULT_META_CONFIG.prune_config,
      ...(data.prune_config || {}),
    },
    last_tuned: data.last_tuned || new Date().toISOString(),
  };
}

/**
 * Save meta-configuration atomically.
 */
export function saveMetaConfig(
  cwd: string,
  config: MetaConfig,
  log: LogFn = noopLog,
): void {
  ensureAutonomicDir(cwd);
  const filePath = getMetaConfigPath(cwd);
  writeJsonFileAtomic(filePath, config, log);
}

// ============================================
// Observation Log (Append-Only JSONL)
// ============================================

function getObservationsPath(cwd: string): string {
  return path.join(getAutonomicDir(cwd), OBSERVATIONS_FILE);
}

/**
 * Append an observation entry to the log.
 */
export function appendObservation(
  cwd: string,
  entry: ObservationEntry,
  log: LogFn = noopLog,
): void {
  ensureAutonomicDir(cwd);
  const filePath = getObservationsPath(cwd);
  try {
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (error) {
    log(`Failed to append observation: ${error}`);
  }
}

/**
 * Load recent observations (last N entries).
 */
export function loadRecentObservations(
  cwd: string,
  maxEntries: number = 100,
  log: LogFn = noopLog,
): ObservationEntry[] {
  const filePath = getObservationsPath(cwd);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];

    const lines = content.split('\n');
    const startIdx = Math.max(0, lines.length - maxEntries);
    const entries: ObservationEntry[] = [];

    for (let i = startIdx; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        entries.push(JSON.parse(lines[i]));
      } catch (e) {
        log(`Failed to parse observation line ${i}: ${e}`);
      }
    }

    return entries;
  } catch (error) {
    log(`Failed to read observations: ${error}`);
    return [];
  }
}

/**
 * Truncate observation log to keep only the last N entries.
 * Used for periodic cleanup (7-day rolling window equivalent).
 */
export function truncateObservations(
  cwd: string,
  keepEntries: number = 1000,
  log: LogFn = noopLog,
): void {
  const filePath = getObservationsPath(cwd);
  if (!fs.existsSync(filePath)) return;

  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return;

    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length <= keepEntries) return;

    const kept = lines.slice(lines.length - keepEntries);
    fs.writeFileSync(filePath, kept.join('\n') + '\n', 'utf-8');
    log(`Truncated observations from ${lines.length} to ${keepEntries} entries`);
  } catch (error) {
    log(`Failed to truncate observations: ${error}`);
  }
}
