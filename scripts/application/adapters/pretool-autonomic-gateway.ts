import type { LogFn } from '../../framework/hook-io.js';
import type {
  HookAction,
  InterventionRecord,
  InterventionType,
  MetaConfig,
  ReflexRule,
  SentinelState,
  SentinelWarning,
} from '../../autonomic/types.js';
import type { ReflectConfig } from '../../conversation_utils.js';
import {
  loadSentinelState,
  checkSentinelTriggers,
  recordSentinelWarnings,
  queueSentinelWarningsForObservation,
  saveSentinelState,
  formatSentinelWarnings,
} from '../../framework/sentinel.js';
import {
  appendIntervention,
  createInterventionRecord,
  loadMetaConfig,
  loadReflexRules,
  matchReflexRules,
  recordRuleFired,
  saveReflexRules,
} from '../../autonomic/index.js';
import type {
  PreToolAutonomicGateway,
} from '../contracts/pretool-sync.js';

export class DefaultPreToolAutonomicGateway
implements PreToolAutonomicGateway {
  loadSentinelState(sessionId: string): SentinelState {
    return loadSentinelState(sessionId);
  }

  checkSentinelTriggers(
    state: SentinelState,
    config: ReflectConfig,
    currentToolName?: string,
    currentToolInput?: unknown,
  ): SentinelWarning[] {
    return checkSentinelTriggers(
      state,
      config,
      currentToolName,
      currentToolInput,
    );
  }

  recordSentinelWarnings(
    state: SentinelState,
    warnings: SentinelWarning[],
  ): SentinelState {
    return recordSentinelWarnings(state, warnings);
  }

  queueSentinelWarningsForObservation(
    state: SentinelState,
    warnings: SentinelWarning[],
  ): SentinelState {
    return queueSentinelWarningsForObservation(state, warnings);
  }

  saveSentinelState(sessionId: string, state: SentinelState): void {
    saveSentinelState(sessionId, state);
  }

  formatSentinelWarnings(warnings: SentinelWarning[]): string {
    return formatSentinelWarnings(warnings);
  }

  loadReflexRules(cwd: string, log: LogFn): ReflexRule[] {
    return loadReflexRules(cwd, log);
  }

  loadMetaConfig(cwd: string, log: LogFn): MetaConfig {
    return loadMetaConfig(cwd, log);
  }

  matchReflexRules(
    toolName: string,
    toolInput: unknown,
    rules: ReflexRule[],
    metaConfig: MetaConfig,
    log: LogFn,
  ): HookAction {
    return matchReflexRules(toolName, toolInput, rules, metaConfig, log);
  }

  recordRuleFired(rule: ReflexRule): ReflexRule {
    return recordRuleFired(rule);
  }

  saveReflexRules(cwd: string, rules: ReflexRule[], log: LogFn): void {
    saveReflexRules(cwd, rules, log);
  }

  createInterventionRecord(
    type: InterventionType,
    toolName: string,
    toolInput: unknown,
    interventionContent: string,
    reflexId: string | null = null,
  ): InterventionRecord {
    return createInterventionRecord(
      type,
      toolName,
      toolInput,
      interventionContent,
      reflexId,
    );
  }

  appendIntervention(cwd: string, record: InterventionRecord, log: LogFn): void {
    appendIntervention(cwd, record, log);
  }
}
