/**
 * Framework barrel export
 *
 * Re-exports all framework modules for convenient single-import usage.
 */

export {
  readHookInput,
  readHookInputStrict,
  createFileLogger,
  createDebugLogger,
  openTty,
  noopLog,
  type LogFn,
} from './hook-io.js';

export {
  detectChangedBlocks,
  computeDiff,
  formatChangedBlocksAsXml,
  snapshotBlockValues,
  type LineDiff,
} from './memory-diff.js';

export {
  appendAgentMessage,
  evaluateForegroundCandidate,
  fetchUnreadAgentMessages,
  loadAgentMessageHistory,
  peekUnreadAgentMessages,
  formatMessagesForStdout,
  formatMessagesForHookContext,
  generateForegroundInstruction,
  BASE_SURFACE_THRESHOLD,
  scoreOutcomeMomentum,
  type AgentMessage,
  type ForegroundCandidate,
  type ForegroundDecision,
  type ForegroundEvaluationContext,
  type ForegroundTranscriptEntry,
  type AgentMessageType,
} from './agent-messages.js';

export {
  runAgentLoop,
  getMemoryTools,
  executeMemoryTool,
  type AgentLoopConfig,
  type AgentLoopResult,
} from './agent-loop.js';
