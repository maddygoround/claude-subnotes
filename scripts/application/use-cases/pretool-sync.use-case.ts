import type { LogFn } from '../../framework/hook-io.js';
import type {
  HookAction,
  InterventionType,
} from '../../autonomic/types.js';
import type {
  PreToolAutonomicGateway,
  PreToolInputReader,
  PreToolStateGateway,
  PreToolUseCaseResult,
} from '../contracts/pretool-sync.js';

interface HookOutput {
  suppressOutput: boolean;
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    additionalContext?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    updatedInput?: Record<string, unknown>;
    systemMessage?: string;
  };
}

export interface PreToolSyncUseCaseDeps {
  inputReader: PreToolInputReader;
  stateGateway: PreToolStateGateway;
  autonomicGateway: PreToolAutonomicGateway;
  log: LogFn;
}

function buildTaggedContext(tagName: string, content: string): string {
  return `<${tagName}>\n${content}\n</${tagName}>`;
}

function buildPassOutput(context?: string): HookOutput {
  const output: HookOutput = {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
    },
  };
  if (context) {
    output.hookSpecificOutput.additionalContext = context;
  }
  return output;
}

function buildDenyOutput(message: string): HookOutput {
  return {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      systemMessage: buildTaggedContext('subconscious_block', message),
    },
  };
}

function buildAskOutput(message: string): HookOutput {
  return {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      systemMessage: buildTaggedContext('subconscious_ask', message),
    },
  };
}

function buildCorrectOutput(
  updatedInput: Record<string, unknown>,
  message: string,
): HookOutput {
  return {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput,
      additionalContext: buildTaggedContext('subconscious_correction', message),
    },
  };
}

export class PreToolSyncUseCase {
  private readonly inputReader: PreToolInputReader;
  private readonly stateGateway: PreToolStateGateway;
  private readonly autonomicGateway: PreToolAutonomicGateway;
  private readonly log: LogFn;

  constructor(deps: PreToolSyncUseCaseDeps) {
    this.inputReader = deps.inputReader;
    this.stateGateway = deps.stateGateway;
    this.autonomicGateway = deps.autonomicGateway;
    this.log = deps.log;
  }

  async execute(): Promise<PreToolUseCaseResult> {
    try {
      const hookInput = await this.inputReader.readInput();

      if (!hookInput?.session_id || !hookInput?.cwd) {
        this.log('Missing session_id or cwd, skipping');
        return { shouldOutput: false };
      }

      const mode = this.stateGateway.getMode(hookInput.cwd);
      if (mode === 'off') {
        return { shouldOutput: false };
      }

      const toolName = hookInput.tool_name || 'unknown';
      this.log(`PreToolUse for tool: ${toolName}`);

      // ========================================
      // Phase 1: Existing memory/message sync
      // ========================================

      const state = this.stateGateway.loadSyncState(
        hookInput.cwd,
        hookInput.session_id,
        this.log,
      );

      if (!state.lastBlockValues) {
        this.log('No previous state, skipping');
        return { shouldOutput: false };
      }

      const blocks = this.stateGateway.loadLocalMemory(hookInput.cwd, this.log);
      const changedBlocks = this.stateGateway.detectChangedBlocks(
        blocks,
        state.lastBlockValues,
      );
      const foregroundMessages = this.stateGateway.fetchUnreadAgentMessages(
        hookInput.cwd,
        this.log,
      );

      this.log(`Changed blocks: ${changedBlocks.length}`);
      this.log(`Foreground messages: ${foregroundMessages.length}`);

      const updateSections: string[] = [];

      if (changedBlocks.length > 0) {
        const memoryUpdate = this.stateGateway.formatChangedBlocksAsXml(
          changedBlocks,
          state.lastBlockValues,
          false,
        );
        updateSections.push(memoryUpdate);
      }

      if (foregroundMessages.length > 0) {
        const whisperUpdate =
          `<subnotes_message_update>\n` +
          `${this.stateGateway.formatMessagesForHookContext(foregroundMessages)}\n` +
          `</subnotes_message_update>`;
        updateSections.push(whisperUpdate);
      }

      state.lastBlockValues = this.stateGateway.snapshotBlockValues(blocks);
      this.stateGateway.saveSyncState(hookInput.cwd, state, this.log);

      // ========================================
      // Phase 2: Autonomic gating (Systems 2 + 5)
      // ========================================

      let autonomicAction: HookAction = { type: 'pass' };
      let sentinelContext = '';

      if (this.stateGateway.isAutonomicEnabled(hookInput.cwd)) {
        // === System 5: Sentinel checks ===
        try {
          const config = this.stateGateway.loadConfig(hookInput.cwd);
          const sentinelState = this.autonomicGateway.loadSentinelState(
            hookInput.session_id,
          );
          const warnings = this.autonomicGateway.checkSentinelTriggers(
            sentinelState,
            config,
            toolName,
            hookInput.tool_input,
          );

          if (warnings.length > 0) {
            sentinelContext = this.autonomicGateway.formatSentinelWarnings(warnings);
            this.log(`Sentinel warnings: ${warnings.length}`);

            const updatedSentinel =
              this.autonomicGateway.queueSentinelWarningsForObservation(
                this.autonomicGateway.recordSentinelWarnings(
                  sentinelState,
                  warnings,
                ),
                warnings,
              );
            this.autonomicGateway.saveSentinelState(
              hookInput.session_id,
              updatedSentinel,
            );

            for (const warning of warnings) {
              try {
                const record = this.autonomicGateway.createInterventionRecord(
                  'sentinel' as InterventionType,
                  toolName,
                  hookInput.tool_input,
                  warning.message,
                  null,
                );
                this.autonomicGateway.appendIntervention(
                  hookInput.cwd,
                  record,
                  this.log,
                );
              } catch {
                // Best-effort intervention recording
              }
            }
          }
        } catch (err) {
          this.log(`Sentinel error (non-fatal): ${err}`);
        }

        // === System 2: Reflex rule matching ===
        try {
          const rules = this.autonomicGateway.loadReflexRules(
            hookInput.cwd,
            this.log,
          );
          if (rules.length > 0) {
            const metaConfig = this.autonomicGateway.loadMetaConfig(
              hookInput.cwd,
              this.log,
            );
            autonomicAction = this.autonomicGateway.matchReflexRules(
              toolName,
              hookInput.tool_input,
              rules,
              metaConfig,
              this.log,
            );

            if (autonomicAction.type !== 'pass' && autonomicAction.source_rule_id) {
              try {
                const allRules = this.autonomicGateway.loadReflexRules(
                  hookInput.cwd,
                  this.log,
                );
                const ruleIdx = allRules.findIndex(
                  (r) => r.id === autonomicAction.source_rule_id,
                );
                if (ruleIdx >= 0) {
                  allRules[ruleIdx] = this.autonomicGateway.recordRuleFired(
                    allRules[ruleIdx],
                  );
                  this.autonomicGateway.saveReflexRules(
                    hookInput.cwd,
                    allRules,
                    this.log,
                  );
                }
              } catch {
                // Best-effort rule update
              }

              try {
                const interventionType = autonomicAction.type as InterventionType;
                const content =
                  autonomicAction.message || autonomicAction.content || '';
                const record = this.autonomicGateway.createInterventionRecord(
                  interventionType,
                  toolName,
                  hookInput.tool_input,
                  content,
                  autonomicAction.source_rule_id,
                );
                this.autonomicGateway.appendIntervention(
                  hookInput.cwd,
                  record,
                  this.log,
                );
              } catch {
                // Best-effort intervention recording
              }
            }
          }
        } catch (err) {
          this.log(`Reflex matching error (non-fatal): ${err}`);
        }
      }

      // ========================================
      // Phase 3: Build final output
      // ========================================

      if (autonomicAction.type === 'deny') {
        this.log(`DENY: ${autonomicAction.message}`);
        return {
          shouldOutput: true,
          output: JSON.stringify(buildDenyOutput(autonomicAction.message!)),
        };
      }

      if (autonomicAction.type === 'ask') {
        this.log(`ASK: ${autonomicAction.message}`);
        return {
          shouldOutput: true,
          output: JSON.stringify(buildAskOutput(autonomicAction.message!)),
        };
      }

      if (autonomicAction.type === 'correct' && autonomicAction.updatedInput) {
        this.log(`CORRECT: ${autonomicAction.content}`);
        return {
          shouldOutput: true,
          output: JSON.stringify(
            buildCorrectOutput(
              autonomicAction.updatedInput,
              autonomicAction.content || 'Input auto-corrected by subconscious',
            ),
          ),
        };
      }

      const hasMemoryUpdates =
        changedBlocks.length > 0 || foregroundMessages.length > 0;
      const hasInsight = autonomicAction.type === 'insight';
      const hasWhisper = autonomicAction.type === 'whisper';
      const hasSentinel = sentinelContext.length > 0;

      if (!hasMemoryUpdates && !hasInsight && !hasWhisper && !hasSentinel) {
        this.log('No updates, advisories, or warnings — exiting silently');
        return { shouldOutput: false };
      }

      const contextParts: string[] = [];

      if (updateSections.length > 0) {
        contextParts.push(
          `<subnotes_update>\n${updateSections.join('\n\n')}\n</subnotes_update>`,
        );
      }

      if (hasSentinel) {
        contextParts.push(sentinelContext);
      }

      if (hasInsight && autonomicAction.content) {
        contextParts.push(
          buildTaggedContext('subconscious_insight', autonomicAction.content),
        );
      }

      if (hasWhisper && autonomicAction.content) {
        contextParts.push(
          buildTaggedContext('subconscious_whisper', autonomicAction.content),
        );
      }

      if (foregroundMessages.length > 0) {
        contextParts.push(
          this.stateGateway.generateForegroundInstruction(foregroundMessages),
        );
      }

      if (changedBlocks.length > 0) {
        contextParts.push(
          `<instruction>Notes updated memory mid-session (shown above). If this is relevant to your current task, surface it:\n\n---\n\n**Notes update** — [one-line summary of what changed and why it matters]\n\nOmit if not relevant to the current tool call.</instruction>`,
        );
      }

      const fullContext = contextParts.join('\n\n');
      return {
        shouldOutput: true,
        output: JSON.stringify(buildPassOutput(fullContext)),
      };
    } catch (error) {
      this.log(`Error: ${error}`);
      return { shouldOutput: false };
    }
  }
}
