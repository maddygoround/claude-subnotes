# Shared Utilities Map

This folder contains reusable helpers used by multiple components.

## Utility Files

- `xml.ts`
  - XML and regex escaping helpers.
- `sdk-tools-mode.ts`
  - Mode parsing and capability-line formatting.
- `file-paths.ts`
  - Tool-input file path extraction helpers.
- `conversation-state.ts`
  - Sync/memory state helpers (`parseSyncStateData`, cloning, merge helpers).
- `process.ts`
  - Process lifecycle helper (`isProcessRunning`).
- `pid.ts`
  - PID file parser (`readPidFromFile`).
- `transcript-parser.ts`
  - Claude transcript parsing helper (`parseClaudeTranscriptEntries`).
- `serialization.ts`
  - Safe value-to-string serializer (`stringifyUnknown`).
- `text.ts`
  - Shared truncation helper (`truncateText`).

## Current Consumers

- `process.ts`
  - `scripts/state_store.ts`
  - `scripts/conversation_utils.ts`
  - `scripts/send_worker_continuous.ts`
- `conversation-state.ts`
  - `scripts/conversation_utils.ts`
- `serialization.ts`
  - `scripts/application/use-cases/stream-transcript.use-case.ts`
  - `scripts/conversation_utils.ts`
- `pid.ts`
  - `scripts/conversation_utils.ts`
  - `scripts/send_worker_continuous.ts`
  - `scripts/application/use-cases/stop-continuous-worker.use-case.ts`
- `transcript-parser.ts`
  - `scripts/conversation_utils.ts`
- `text.ts`
  - `scripts/framework/tools/files.ts`
  - `scripts/framework/tools/conversation.ts`
  - `scripts/framework/tools/web.ts`
- `file-paths.ts`
  - `scripts/framework/sentinel.ts`
  - `scripts/autonomic/reflex-matcher.ts`
