# Claude Reflect

A persistent memory agent for Claude Code. A local Claude agent that watches your sessions, reads your files, builds up memory over time, and whispers guidance back.

![evil claude](assets/evil-claude.png)

## What Is This?

Claude Code forgets everything between sessions. SubNotes is a local background agent running underneath — watching, learning, and whispering back:

- **Watches** every Claude Code session transcript
- **Reads your codebase** — explores files with Read, Grep, and Glob while processing transcripts
- **Remembers** across sessions, projects, and time
- **Whispers guidance** — surfaces context, patterns, and reminders before each prompt
- **Never blocks** — runs asynchronously in the background
- **Fully local** — powered by Anthropic's SDK, no external service required

Not just a memory layer — a background agent with real tool access that gets smarter the more you use it.

## How It Works

After each response, the transcript is sent to a local Claude agent via the Anthropic SDK. The agent reads files, updates its memory blocks, and can whisper back before the next prompt. All memory is stored locally in `.subnotes/` directory.

```
┌─────────────┐          ┌─────────────────────────────┐
│ Claude Code │◄────────►│ Reflect Agent (background)  │
└─────────────┘          │                             │
       │                 │  Tools: Read, memory ops    │
       │                 │  Memory: .subnotes/         │
       │                 │  Model: Claude (Anthropic)  │
       │                 └─────────────────────────────┘
       │                        │
       │   Session Start        │
       ├───────────────────────►│ New session notification
       │                        │
       │   Before each prompt   │
       │◄───────────────────────┤ Whispers guidance → stdout
       │                        │
       │   Before each tool use │
       │◄───────────────────────┤ Mid-workflow updates → stdout
       │                        │
       │   After each response  │
       ├───────────────────────►│ Transcript → Agent (async)
       │                        │  ↳ Reads files, updates memory
       │                        │  ↳ May self-continue up to 2x
       │   Before stop          │
       │◄───────────────────────┤ Blocks stop if unread messages
       │                        │  ↳ Injects message, then stops
```

## Installation

### Install from Source

Clone the repository:

```bash
git clone https://github.com/maddygoround/claude-reflect.git
cd claude-reflect
bun install
```

Enable the plugin (from inside the cloned directory):

```
/plugin enable .
```

Or enable globally for all projects:

```
/plugin enable --global .
```

If running from a different directory, use the full path to the cloned repo.

### Linux: tmpfs Workaround

If plugin installation fails with `EXDEV: cross-device link not permitted`, your `/tmp` is likely on a different filesystem (common on Ubuntu, Fedora, Arch). Set `TMPDIR` to work around this [Claude Code bug](https://github.com/anthropics/claude-code/issues/14799):

```bash
mkdir -p ~/.claude/tmp
export TMPDIR="$HOME/.claude/tmp"
```

Add to your shell profile (`~/.bashrc` or `~/.zshrc`) to make permanent.

## Configuration

### Required

```bash
export ANTHROPIC_API_KEY="your-api-key"
```

Get your API key from [console.anthropic.com](https://console.anthropic.com).

### Optional

```bash
export SUBNOTES_MODE="whisper"           # Default. Or "full" for blocks + messages, "off" to disable
export SUBNOTES_HOME="$HOME"             # Consolidate .subnotes state to ~/.subnotes/
export SUBNOTES_SDK_TOOLS="read-only"    # Or "full", "off"
export SUBNOTES_DEBUG="1"                # Enable debug logging
export SUBNOTES_IDLE_TIMEOUT="1800000"   # Optional: worker idle self-shutdown in ms (0 disables)
export SUBNOTES_MAX_CONTINUATIONS="2"        # Max self-continuations per cycle (default: 2)
export ANTHROPIC_MODEL="claude-sonnet-4-6"  # Model override (optional)
```

- `SUBNOTES_MODE` - Controls what gets injected. `whisper` (default, messages only), `full` (blocks + messages), `off` (disable). See [Modes](#modes).
- `SUBNOTES_HOME` - Base directory for plugin state files. Creates `{SUBNOTES_HOME}/.subnotes/` for session data and memory blocks. Defaults to current working directory. Set to `$HOME` to consolidate all state in one location.
- `SUBNOTES_SDK_TOOLS` - Controls client-side tool access for the SubNotes agent. `read-only` (default), `full`, or `off`. See [SDK Tools](#sdk-tools).
- `SUBNOTES_DEBUG` - Set to `1` to enable debug logging.
- `SUBNOTES_IDLE_TIMEOUT` - Optional idle timeout in milliseconds for the detached worker. Default `1800000` (30 min). Set to `0` to disable idle self-termination.
- `SUBNOTES_MAX_CONTINUATIONS` - Max self-continuation cycles the agent can run per transcript batch. Default `2`.
- `ANTHROPIC_MODEL` - Override the Claude model. Defaults to `claude-sonnet-4-6`.

### Modes

The `SUBNOTES_MODE` environment variable controls what gets injected into Claude's context:

| Mode | What Claude sees | Use case |
|------|-----------------|----------|
| **`whisper`** (default) | Only messages from SubNotes | Lightweight — SubNotes speaks when it has something to say |
| **`full`** | Memory blocks + messages | Full context — blocks on first prompt, diffs after |
| **`off`** | Nothing | Disable hooks temporarily |

SubNotes **never writes to CLAUDE.md** in any mode. All content is injected via stdout into the prompt context. Legacy `<subnotes>` content in CLAUDE.md will be cleaned up automatically.

### Multi-Project Usage

SubNotes memory is stored per-project in `.subnotes/` directory. Each project maintains its own memory blocks and session history. To share memory across projects, set `SUBNOTES_HOME` to a common directory:

```bash
# Share memory across all projects
export SUBNOTES_HOME="$HOME"
```

This creates `~/.subnotes/` for shared state, or you can point to a specific directory for project groups.

## Memory Blocks

SubNotes maintains persistent memory blocks that evolve over time:

| Block | Purpose |
|-------|---------|
| `core_directives` | Role definition and behavioral guidelines |
| `guidance` | Active guidance for the next session (syncs to Claude Code before each prompt) |
| `user_preferences` | Learned coding style, tool preferences, communication style |
| `project_context` | Codebase knowledge, architecture decisions, known gotchas |
| `session_patterns` | Recurring behaviors, time-based patterns, common struggles |
| `pending_items` | Unfinished work, explicit TODOs, follow-up items |

### Communication Style

SubNotes is configured to be:

- **Observational** - "I noticed..." not "You should..."
- **Concise** - Technical, no filler
- **Present but not intrusive** - Empty guidance is fine; it won't manufacture content

### Two-Way Communication

Claude Code can address the SubNotes agent directly in responses. The agent sees everything in the transcript and may respond on the next sync. It's designed for ongoing dialogue, not just one-way observation.

## Hooks

The plugin uses five Claude Code hooks:

| Hook | Script | Timeout | Purpose |
|------|--------|---------|---------|
| `SessionStart` | `session_start.ts` | 5s | Initializes session, starts continuous worker |
| `UserPromptSubmit` | `stream_transcript.ts` + `sync_local_memory.ts` | 3s + 10s | Streams user input + injects memory/messages |
| `PostToolUse` | `stream_transcript.ts` | 3s | Streams tool events to the continuous worker |
| `PreToolUse` | `pretool_sync.ts` | 5s | Mid-workflow hidden whispers via `additionalContext` |
| `Stop` | `stop_sync.ts` | 5s | Blocks stop if SubNotes has unread messages; injects them |
| `SessionEnd` | `stop_continuous_worker.ts` | 5s | Stops the session worker and cleans up PID files |

### SessionStart

When a new Claude Code session begins:
- Initializes local memory blocks (loads from `.subnotes/memory.json`)
- Starts a detached continuous worker for this session
- Cleans up any legacy `<subnotes>` content from CLAUDE.md
- Saves session state for other hooks to reference
- Displays startup banner with configuration

### UserPromptSubmit

Before each prompt is processed:
- Streams the prompt to the continuous transcript queue
- Loads agent's current memory blocks and messages
- In `full` mode: injects all blocks on first prompt, diffs on subsequent prompts
- In `whisper` mode: injects only messages from SubNotes

### PreToolUse

Before each tool use:
- Checks for memory changes since last sync
- Injects changed memory blocks and any unread SubNotes messages via `additionalContext`
- Silent no-op if nothing changed

### PostToolUse

After each tool call:
- Streams tool execution metadata/results into transcript queue
- Enables SubNotes to reason between tool calls, not only between prompts

### Stop

When Claude is about to stop responding:
- Checks if the SubNotes agent has posted any unread messages
- If unread messages exist, blocks the stop and injects them into the conversation — Claude renders the thought as `**Subconscious thought** — [key point]` and continues
- Once all messages are marked read, exits silently and Claude stops normally
- Errors exit with code 0 (never disrupts the stop flow)

### SessionEnd

When a Claude Code session ends:
- Stops the detached worker for that session (SIGTERM)
- Cleans up namespaced and legacy PID files
- Prevents worker processes from lingering after session close

### SDK Tools

SubNotes has access to tools during transcript processing:

**Configuration via `SUBNOTES_SDK_TOOLS`:**

| Mode | Tools Available | Use Case |
|------|----------------|----------|
| `read-only` (default) | `Read`, `Grep`, `Glob`, `web_search`, `fetch_webpage` | Safe file reading and searching only |
| `full` | All tools including `Read`, `Grep`, `Glob` + future tools | Reserved for future expansion |
| `off` | None (memory-only) | Listen-only — SubNotes processes transcripts but can't read files |

### Continuous Worker

SubNotes runs as a single continuous execution model:
- Session start spawns one worker per session (`send_worker_continuous.ts`)
- Worker consumes streamed transcript events (`UserPromptSubmit` + `PostToolUse`)
- Worker updates memory blocks and queues SubNotes whispers in near real-time
- `PreToolUse` injects the freshest state back into Claude before each tool call
- `Stop` delivers any queued messages before Claude stops responding
- `SessionEnd` shuts down the session worker; idle workers also self-terminate (default: 30 minutes without transcript changes)

**Self-continuing thoughts:** The agent can emit `<continue_thought>your follow-up here</continue_thought>` in its response to re-invoke itself with a follow-up question, up to 2 times per cycle. This lets it resolve multi-step reasoning (e.g. "I noticed X — let me check if Y is also true") without waiting for the next transcript event. The tag is stripped from the final message before delivery.

## State Management

The plugin stores state in two locations:

### Durable State (`.subnotes/`)

Persisted in your project directory (or `$SUBNOTES_HOME/.subnotes/{repoHash}/` if set):
- `memory.json` - Memory blocks storage
- `conversation.json` - Messages from SubNotes to Claude Code
- `session-{repoHash}-{id}.json` - Per-session state (last processed index)
- Session/transcript files are namespaced by a repo hash to avoid collisions across repos when sharing `SUBNOTES_HOME`
- If `Subconscious.af` exists in repo root, SubNotes uses it as the template source for system prompt + default/required memory block structure

### Temporary State (`$TMPDIR/subnotes-sync-$UID/`)

Log files for debugging:
- `session_start.log` - Session initialization
- `sync_local_memory.log` - Memory sync operations
- `send_worker_continuous.log` - Continuous background worker

## What SubNotes Receives

SubNotes processes the full conversation transcript with:
- User messages
- Assistant responses (including thinking blocks)
- Tool uses and results
- Session context (session ID, working directory)

## What Claude Sees

All content is injected via stdout — nothing is written to disk. What Claude receives depends on the mode.

### Messages (whisper + full mode)

Messages from SubNotes are injected before each prompt:

```xml
<subnotes_message from="SubNotes" timestamp="2026-03-27T08:42:51.133Z">
You've asked about error handling in async contexts three times this week.
Consider reviewing error handling architecture holistically.
</subnotes_message>
```

### Memory Blocks (full mode only)

On the first prompt of a session, all memory blocks are injected:

```xml
<subnotes_context>
SubNotes agent is watching this session and whispering guidance.
It can read files, search your codebase, and browse the web (read-only).
</subnotes_context>

<subnotes_memory_blocks>
<user_preferences description="Learned coding style and preferences.">
Prefers explicit type annotations. Uses pnpm, not npm.
</user_preferences>
<project_context description="Codebase knowledge and architecture.">
Working on claude-reflect plugin. TypeScript, ESM modules.
</project_context>
</subnotes_memory_blocks>
```

On subsequent prompts, only changed blocks are shown as diffs:

```xml
<subnotes_memory_update>
<pending_items status="modified">
- Phase 1 test harness complete
+ Release prep complete: README fixed, .gitignore updated
</pending_items>
</subnotes_memory_update>
```

## First Run

On first use, the agent starts with minimal context. It takes a few sessions before it has enough signal to provide useful guidance. Give it time — it reads your code, learns your patterns, and gets smarter the more it observes.

## Use Cases

- **Persistent project context** — Agent reads your codebase and remembers it across sessions
- **Learned preferences** — "This user always wants explicit type annotations"
- **Cross-session continuity** — Pick up where you left off, with full context
- **Pattern detection** — "You've been debugging auth for 2 hours, maybe step back?"
- **Proactive reminders** — Tracks pending items and unfinished work

## Debugging

Check the log files if hooks aren't working. The log directory is user-specific (`$TMPDIR/subnotes-sync-$UID/`):

```bash
# Watch all logs (macOS/Linux)
tail -f /tmp/subnotes-sync-$(id -u)/*.log

# Or specific logs
tail -f /tmp/subnotes-sync-$(id -u)/session_start.log
tail -f /tmp/subnotes-sync-$(id -u)/send_worker_continuous.log
```

## Architecture Notes

- Memory stored in local JSON files (`.subnotes/memory.json`)
- Agent powered by Anthropic SDK (`@anthropic-ai/sdk`)
- Continuous worker runs detached and processes transcript events in real-time
- Tool handlers are modularized under `scripts/framework/tools/` (`memory`, `conversation_search`, `web_search`, `fetch_webpage`, `Read`, `Glob`, `Grep`)
- Memory updates via tool calls: `memory`, `memory_replace`, `memory_insert`, `memory_rethink`

For a comprehensive technical overview of the system design, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## License

MIT
