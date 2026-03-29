# Claude Reflect

A persistent, local background agent for Claude Code. Claude Reflect watches your sessions, maintains durable notes, learns from repeated patterns, and surfaces timely steer/insight messages back into Claude.

![evil claude](assets/evil-claude.png)

## What Is This?

By default, Claude Code does not carry rich project memory across sessions. Reflect runs fully locally alongside Claude Code's plugin system and adds:

- **Persistent memory**: Durable state lives in `.subnotes/` by default, with canonical memory stored in the durable state's `memory.json`.
- **Continuous reasoning**: A long-running worker ingests transcript updates and maintains notes over time using Anthropic's SDK.
- **Pattern learning**: The autonomic pipeline logs observations, crystallizes patterns, promotes reflex rules, tracks intervention outcomes, and self-tunes.
- **Real-time steering**: `PreToolUse` can inject warnings, whispers, insights, asks, denies, or input corrections before a tool runs.
- **Distilled context sync**: Reflect keeps a distilled section synced into `CLAUDE.md` or `.claude/CLAUDE.md` while also injecting targeted context directly through hook output.

## Architecture

Claude Reflect currently has two cooperating parts: a continuous reflective worker and an autonomic control layer.

### Continuous Reflect Worker

The continuous worker is started on `SessionStart` and fed transcript updates from `UserPromptSubmit`, `PostToolUse`, and mirrored Claude transcripts.

- Maintains canonical memory in the durable state's `memory.json`.
- Queues scored foreground notes in the durable state's `conversation.json`.
- Uses the memory block schema from `Subconscious.af`.
- Can use memory tools and, unless `sdkToolsMode` is `off`, conversation search, web, and local file-reading tools.

By default, the memory block set includes `core_directives`, `guidance`, `pending_items`, `project_context`, `self_improvement`, `session_patterns`, `tool_guidelines`, and `user_preferences`.

### Autonomic Control Layer

The autonomic subsystem is split across five systems:

- **System 1: Crystallizer**: Converts observations into learned patterns in the durable state's `autonomic/patterns.json`.
- **System 2: Reflex layer**: Promotes patterns into reflex rules and matches them during `PreToolUse`.
- **System 3: Intervention tracker**: Records interventions and resolves whether they were followed, ignored, retried, or overridden.
- **System 4: Self-tuner**: Adjusts confidences and thresholds based on outcomes.
- **System 5: Sentinel**: Maintains fast, local counters for thrashing, test loops, error cascades, and overwrite risk.

### Communication Style

Reflect is programmed via `Subconscious.af` to stay concise, observational, and useful. Foreground notes are rendered to the user as `Notes reflect`, `Notes steer`, or `Notes insight` rather than hidden internal logs.

## Installation

### Option 1: Claude Plugin Marketplace (Recommended)

1. **Add the repository to your marketplace sources:**
   ```bash
   /plugin marketplace add maddygoround/claude-reflect
   ```
2. **Install the plugin:**
   ```bash
   /plugin install claude-reflect
   ```
3. **Enable the plugin:**
   ```bash
   /plugin enable claude-reflect
   ```
   *(To enable it globally for all projects: `/plugin enable --global claude-reflect`)*

### Option 2: Install Locally (From Source)

Requires Node 18+.

1. **Clone the repo and install dependencies:**
   ```bash
   git clone https://github.com/maddygoround/claude-reflect.git
   cd claude-reflect
   npm install
   ```
   *(Or use `bun install` if you prefer.)*
2. **Add the local marketplace manifest:**
   ```bash
   /plugin marketplace add ./.claude-plugin/marketplace.json
   ```
3. **Install the plugin from that local marketplace entry:**
   ```bash
   /plugin install claude-reflect
   ```
4. **Enable the plugin:**
   ```bash
   /plugin enable claude-reflect
   ```

> **Linux Note (tmpfs workaround):** If installation or runtime fails with `EXDEV: cross-device link not permitted` (common when `/tmp` is on a different filesystem), set `TMPDIR` first:
> `mkdir -p ~/.claude/tmp && export TMPDIR="$HOME/.claude/tmp"`

## Configuration

### Environment Variables and State Location

Reflect reads configuration from the durable state directory and falls back to a few environment variables:

```bash
export ANTHROPIC_API_KEY="your-api-key"  # Required unless set as anthropicApiKey in config.json
export EXA_API_KEY="your-exa-key"        # Optional: improves web_search results
export SUBNOTES_HOME="$HOME"             # Optional: relocate durable state out of the repo
```

- If `SUBNOTES_HOME` is unset, durable state lives in `<repo>/.subnotes/`.
- If `SUBNOTES_HOME` is set, durable state lives in `{SUBNOTES_HOME}/.subnotes/<repo-namespace>/`.
- This centralizes storage, but repositories stay isolated by namespace; it does not merge all repos into one shared memory file.

### Configuration (`config.json` in the durable state directory)

On first run, Reflect creates `config.json` in the durable state directory and merges in any missing defaults on later runs.

Abridged example:

```json
{
  "mode": "whisper",
  "sdkToolsMode": "read-only",
  "architecture": "continuous",
  "autonomic": true,
  "debug": false,
  "checkIntervalMs": 1000,
  "minMessages": 1,
  "idleTimeoutMs": 1800000,
  "maxContinuations": 2,
  "crystallizeInterval": 10,
  "minObservations": 5,
  "anthropicModel": "claude-sonnet-4-6",
  "crystallizerModel": "claude-haiku-3-5-20250815"
}
```

- `mode`: `whisper` keeps the distilled `CLAUDE.md` section and targeted hook messages active without dumping full memory on every prompt. `full` injects the full memory snapshot on the first prompt, then changed blocks on later syncs. `off` disables Reflect.
- `sdkToolsMode`: accepts `read-only`, `full`, or `off`. In the current code, any value other than `off` enables the worker's conversation, web, and local file-reading tools.
- `autonomic`: enables the autonomic systems and sentinel warnings.
- `debug`: turns on verbose hook logging.
- `anthropicModel`: model used by the main continuous reasoning worker.
- `crystallizerModel`: model used when System 1 names and describes newly discovered patterns.
- `projectDir`: optional override for where the distilled `CLAUDE.md` section is synced.
- `anthropicApiKey` and `exaApiKey`: optional config-file equivalents of `ANTHROPIC_API_KEY` and `EXA_API_KEY`.
- Additional sentinel, crystallizer, and self-tuner thresholds are also persisted in the same file.

## Hook Lifecycle

Claude Reflect is wired through Claude Code hooks:

| Hook | Purpose |
|------|---------|
| `SessionStart` | Ensures config exists, syncs distilled state into `CLAUDE.md`, initializes session state, and starts the continuous worker. |
| `UserPromptSubmit` | Mirrors new user input into the internal transcript and optionally injects full memory or foreground notes. |
| `PreToolUse` | Syncs memory/message updates and runs sentinel + reflex gating. It can pass, whisper, insight, ask, deny, or correct before the tool executes. |
| `PostToolUse` | Streams tool events into the transcript and updates sentinel counters. |
| `Stop` | If unread foreground notes exist, blocks stop long enough for Claude to surface them visibly as `Notes reflect`, `Notes steer`, or `Notes insight`. |
| `SessionEnd` | Stops the continuous worker and cleans up stale worker artifacts. |

## State and Logs

### Durable State

Canonical state lives in the durable state directory (`<repo>/.subnotes/` by default, or `$SUBNOTES_HOME/.subnotes/<repo-namespace>/` when relocated).

- `config.json` - runtime configuration
- `memory.json` - canonical memory blocks
- `conversation.json` - queued foreground notes for Claude
- `session-<repo-namespace>-<session-id>.json` - per-session sync state
- `transcript-<repo-namespace>-<session-id>.jsonl` - mirrored transcript stream
- `autonomic/patterns.json` - learned patterns
- `autonomic/reflexes.json` - promoted reflex rules
- `autonomic/interventions.json` - recorded intervention outcomes
- `autonomic/meta-config.json` - self-tuned thresholds and style data
- `autonomic/observations.jsonl` - append-only observation log

### Logs and Ephemeral State

Logs, worker PID files, and sentinel state live under `path.join(os.tmpdir(), "subnotes-sync-<uid>")`.

- On many Linux systems this is `/tmp/subnotes-sync-$(id -u)/`
- On macOS it is usually under `/var/folders/.../subnotes-sync-<uid>/`

## License

MIT
