#!/usr/bin/env tsx
/**
 * PreToolUse Gating Layer
 *
 * This is the subconscious's enforcement point. Every tool call passes
 * through here before executing. The hook can:
 *
 * 1. PASS — no intervention, existing memory/message sync only
 * 2. WHISPER / INSIGHT — inject advisory context (additionalContext)
 * 3. ASK — request user confirmation (permissionDecision: "ask")
 * 4. DENY — block the tool call (permissionDecision: "deny")
 * 5. CORRECT — modify tool input (updatedInput)
 *
 * Systems involved:
 * - System 5 (Sentinel): Real-time counter-based warnings
 * - System 2 (Reflex Matcher): Pattern-based rule matching
 * - System 3 (Intervention Tracker): Records every intervention
 *
 * PERFORMANCE: Must complete in < 5 seconds (hook timeout).
 * No LLM calls. All reads are fast local JSON.
 */

import {
  readHookInput,
  createDebugLogger,
  detectChangedBlocks,
  formatChangedBlocksAsXml,
  snapshotBlockValues,
  fetchUnreadAgentMessages,
  formatMessagesForHookContext,
  generateForegroundInstruction,
} from './framework/index.js';
import {
  loadSyncState,
  saveSyncState,
  loadLocalMemory,
  getMode,
  isAutonomicEnabled,
  loadConfig,
} from './conversation_utils.js';
import {
  loadSentinelState,
  checkSentinelTriggers,
  recordSentinelWarnings,
  saveSentinelState,
  formatSentinelWarnings,
} from './framework/sentinel.js';
import {
  loadReflexRules,
  loadMetaConfig,
  matchReflexRules,
  recordRuleFired,
  saveReflexRules,
  appendIntervention,
  createInterventionRecord,
} from './autonomic/index.js';
import type { HookAction, InterventionType } from './autonomic/types.js';

const debug = createDebugLogger('pretool');

interface PreToolInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
}

// ============================================
// Hook Output Builders
// ============================================

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

function buildTaggedContext(tagName: string, content: string): string {
  return `<${tagName}>\n${content}\n</${tagName}>`;
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

// ============================================
// Main Hook Logic
// ============================================

async function main(): Promise<void> {
  const mode = getMode();
  if (mode === 'off') {
    process.exit(0);
  }

  try {
    const hookInput = await readHookInput<PreToolInput>();

    if (!hookInput?.session_id || !hookInput?.cwd) {
      debug('Missing session_id or cwd, skipping');
      process.exit(0);
    }

    const toolName = hookInput.tool_name || 'unknown';
    debug(`PreToolUse for tool: ${toolName}`);

    // ========================================
    // Phase 1: Existing memory/message sync
    // ========================================

    const state = loadSyncState(hookInput.cwd, hookInput.session_id);

    if (!state.lastBlockValues) {
      debug('No previous state, skipping');
      process.exit(0);
    }

    const blocks = loadLocalMemory(hookInput.cwd, debug);
    const changedBlocks = detectChangedBlocks(blocks, state.lastBlockValues);
    const unreadMessages = fetchUnreadAgentMessages(hookInput.cwd, debug);

    debug(`Changed blocks: ${changedBlocks.length}`);
    debug(`Unread messages: ${unreadMessages.length}`);

    // Build the existing memory/message context sections
    const updateSections: string[] = [];

    if (changedBlocks.length > 0) {
      const memoryUpdate = formatChangedBlocksAsXml(
        changedBlocks,
        state.lastBlockValues,
        false,
      );
      updateSections.push(memoryUpdate);
    }

    if (unreadMessages.length > 0) {
      const whisperUpdate =
        `<subnotes_message_update>\n` +
        `${formatMessagesForHookContext(unreadMessages)}\n` +
        `</subnotes_message_update>`;
      updateSections.push(whisperUpdate);
    }

    // Update sync state
    state.lastBlockValues = snapshotBlockValues(blocks);
    saveSyncState(hookInput.cwd, state);

    // ========================================
    // Phase 2: Autonomic gating (Systems 2 + 5)
    // ========================================

    let autonomicAction: HookAction = { type: 'pass' };
    let sentinelContext = '';

    if (isAutonomicEnabled(hookInput.cwd)) {
      // === System 5: Sentinel checks ===
      try {
        const config = loadConfig(hookInput.cwd);
        const sentinelState = loadSentinelState(hookInput.session_id);
        const warnings = checkSentinelTriggers(
          sentinelState,
          config,
          toolName,
          hookInput.tool_input,
        );

        if (warnings.length > 0) {
          sentinelContext = formatSentinelWarnings(warnings);
          debug(`Sentinel warnings: ${warnings.length}`);

          // Record sentinel warnings
          const updatedSentinel = recordSentinelWarnings(sentinelState, warnings);
          saveSentinelState(hookInput.session_id, updatedSentinel);

          // Record sentinel interventions (System 3)
          for (const warning of warnings) {
            try {
              const record = createInterventionRecord(
                'sentinel' as InterventionType,
                toolName,
                hookInput.tool_input,
                warning.message,
                null,
              );
              appendIntervention(hookInput.cwd, record, debug);
            } catch {
              // Best-effort intervention recording
            }
          }
        }
      } catch (err) {
        debug(`Sentinel error (non-fatal): ${err}`);
      }

      // === System 2: Reflex rule matching ===
      try {
        const rules = loadReflexRules(hookInput.cwd, debug);
        if (rules.length > 0) {
          const metaConfig = loadMetaConfig(hookInput.cwd, debug);
          autonomicAction = matchReflexRules(
            toolName,
            hookInput.tool_input,
            rules,
            metaConfig,
            debug,
          );

          // If a rule matched, update its fired counter + record intervention
          if (autonomicAction.type !== 'pass' && autonomicAction.source_rule_id) {
            try {
              const allRules = loadReflexRules(hookInput.cwd, debug);
              const ruleIdx = allRules.findIndex(
                (r) => r.id === autonomicAction.source_rule_id,
              );
              if (ruleIdx >= 0) {
                allRules[ruleIdx] = recordRuleFired(allRules[ruleIdx]);
                saveReflexRules(hookInput.cwd, allRules, debug);
              }
            } catch {
              // Best-effort rule update
            }

            // Record reflex intervention (System 3)
            try {
              const interventionType = autonomicAction.type as InterventionType;
              const content =
                autonomicAction.message || autonomicAction.content || '';
              const record = createInterventionRecord(
                interventionType,
                toolName,
                hookInput.tool_input,
                content,
                autonomicAction.source_rule_id,
              );
              appendIntervention(hookInput.cwd, record, debug);
            } catch {
              // Best-effort intervention recording
            }
          }
        }
      } catch (err) {
        debug(`Reflex matching error (non-fatal): ${err}`);
      }
    }

    // ========================================
    // Phase 3: Build final output
    // ========================================

    // Priority: deny > ask > correct > soft advisory > pass
    if (autonomicAction.type === 'deny') {
      debug(`DENY: ${autonomicAction.message}`);
      console.log(JSON.stringify(buildDenyOutput(autonomicAction.message!)));
      return;
    }

    if (autonomicAction.type === 'ask') {
      debug(`ASK: ${autonomicAction.message}`);
      console.log(JSON.stringify(buildAskOutput(autonomicAction.message!)));
      return;
    }

    if (autonomicAction.type === 'correct' && autonomicAction.updatedInput) {
      debug(`CORRECT: ${autonomicAction.content}`);
      console.log(
        JSON.stringify(
          buildCorrectOutput(
            autonomicAction.updatedInput,
            autonomicAction.content || 'Input auto-corrected by subconscious',
          ),
        ),
      );
      return;
    }

    // Whisper / insight / pass — build context with memory changes + sentinel + reflex advisories
    const hasMemoryUpdates =
      changedBlocks.length > 0 || unreadMessages.length > 0;
    const hasInsight = autonomicAction.type === 'insight';
    const hasWhisper = autonomicAction.type === 'whisper';
    const hasSentinel = sentinelContext.length > 0;

    if (!hasMemoryUpdates && !hasInsight && !hasWhisper && !hasSentinel) {
      debug('No updates, advisories, or warnings — exiting silently');
      process.exit(0);
    }

    // Build combined context
    const contextParts: string[] = [];

    // Memory updates
    if (updateSections.length > 0) {
      contextParts.push(
        `<subnotes_update>\n${updateSections.join('\n\n')}\n</subnotes_update>`,
      );
    }

    // Sentinel warnings
    if (hasSentinel) {
      contextParts.push(sentinelContext);
    }

    // Reflex insight
    if (hasInsight && autonomicAction.content) {
      contextParts.push(
        buildTaggedContext('subconscious_insight', autonomicAction.content),
      );
    }

    // Reflex whisper
    if (hasWhisper && autonomicAction.content) {
      contextParts.push(
        buildTaggedContext('subconscious_whisper', autonomicAction.content),
      );
    }

    // Instructions for Claude
    if (unreadMessages.length > 0) {
      contextParts.push(generateForegroundInstruction(unreadMessages));
    }

    if (changedBlocks.length > 0) {
      contextParts.push(
        `<instruction>Notes updated memory mid-session (shown above). If this is relevant to your current task, surface it:\n\n---\n\n**Notes update** — [one-line summary of what changed and why it matters]\n\nOmit if not relevant to the current tool call.</instruction>`,
      );
    }

    const fullContext = contextParts.join('\n\n');
    console.log(JSON.stringify(buildPassOutput(fullContext)));
  } catch (error) {
    debug(`Error: ${error}`);
    process.exit(0);
  }
}

main();
