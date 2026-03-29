# Conversation Utilities Modules

`scripts/conversation_utils.ts` is now a facade that re-exports focused modules from this folder.

## Modules

- `config.ts`
  - Config schema/types and config loading helpers.
  - Mode/access helpers: `getMode`, `getSdkToolsMode`, `isAutonomicEnabled`.
- `state-paths.ts`
  - Durable/legacy state path resolution and namespace helpers.
- `claude-md.ts`
  - CLAUDE.md formatting/sync/cleanup logic.
- `worker-spawn.ts`
  - Cross-platform background worker spawn helper.

## Design Rule

- New shared logic should be added to one of these focused modules first.
- `conversation_utils.ts` should stay mostly orchestration + compatibility exports.
