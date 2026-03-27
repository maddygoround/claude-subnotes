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
  fetchUnreadAgentMessages,
  formatMessagesForStdout,
  formatMessagesForHookContext,
  type AgentMessage,
} from './agent-messages.js';

export {
  runAgentLoop,
  getMemoryTools,
  executeMemoryTool,
  type AgentLoopConfig,
  type AgentLoopResult,
} from './agent-loop.js';
