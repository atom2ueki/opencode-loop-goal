# opencode-loop-goal

A combined [OpenCode](https://opencode.ai) plugin that brings Claude Code's two session-scoped modes to OpenCode: **`/loop`** (scheduled prompt injection) and **`/goal`** (completion-mode auto-continue).

> Both modes live for the lifetime of a session and die when it closes. State is persisted to disk and restored on `opencode --resume`. One plugin, one config entry, one `dist/index.js`.

## What it does

### `/loop` — scheduled prompts

Three modes, matching CC's `/loop`:

| Mode | Invocation | Behavior |
|---|---|---|
| Fixed interval | `/loop 5m check the deploy` | Fires the prompt every 5 minutes |
| Dynamic | `/loop check the deploy` | Agent picks the next delay each iteration via `loop_reschedule` (1–60 min) |
| Maintenance | `/loop` | Runs the built-in maintenance prompt (or `.opencode/loop.md` override) |

Plus management: `/loop list`, `/loop status`, `/loop stop <id>`, `/loop stop all`, `/loop clear`.

### `/goal` — completion mode

Set a **verifiable** finish line; the goal agent keeps working until a small evaluator says it's met.

| Step | What happens |
|---|---|
| Set | `/goal \`npm test\` exits 0` (or the agent calls `goal_set`) |
| Work | The **goal** agent plans, executes, shows proof once |
| Evaluate | On idle, an ephemeral session judges the transcript: **NO** → another turn with a hint; **YES** → goal clears + one completion-summary turn |
| Stop | `/goal clear`, or auto-pause on stuck/max-turns/cancel |

Safety rails: 8-consecutive-continue cap, no-progress breaker (3 identical evaluator NOs), cancel suppression, fail-open evaluator with a `completionMarker` fallback.

## Install

### From source (development)

```bash
git clone https://github.com/atom2ueki/opencode-loop-goal
cd opencode-loop-goal
bun install
bun run build
```

Then wire it into `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["file:///absolute/path/to/opencode-loop-goal/dist/index.js", { "goal": { "evaluatorModel": "anthropic/claude-haiku-4-5" } }]
  ]
}
```

Finally, copy the slash-command dispatchers and the goal agent so they show up in the TUI:

```bash
cp commands/*.md ~/.config/opencode/commands/
cp agents/goal.md ~/.config/opencode/agents/
```

### From npm (when published)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-loop-goal"]
}
```

Still copy `commands/*.md` and `agents/goal.md` into `~/.config/opencode/` — the plugin registers the tools/hooks; the markdown files are what make `/loop` and `/goal` appear in the command picker.

## Slash commands

| Command | Dispatches to |
|---|---|
| `/loop`, `/loop <interval> <prompt>`, `/loop <prompt>` | `loop_start` |
| `/loop list`, `/loop status`, `/loop stop <id>`, `/loop stop all` | `loop_list` / `loop_status` / `loop_stop` |
| `/lstop` | `loop_stop` (all in session) |
| `/goal <condition>` | `goal_set` |
| `/goal`, `/goal status` | `goal_status` |
| `/goal clear` (`stop` / `off` / `cancel`) | `goal_clear` |

`/goal` runs on the **goal** agent (see `agent: goal` in `commands/goal.md`), so setting a condition engages goal mode immediately.

## The goal agent

`agents/goal.md` defines a `mode: primary` **hidden** agent that sets conditions via `goal_set`, works with normal OpenCode tools, and writes `Goal Completed` only on the synthetic completion-summary turn. It is intentionally hidden from the mode picker (like `/loop`, not like plan/build) — invoke it via `/goal`. Goal Mode only auto-continues while the session is on this agent.

## Tools exposed to the agent

| Tool | Feature | Purpose |
|---|---|---|
| `loop_start` | loop | Schedule a new loop (`prompt?`, `interval?`, `mode?`) |
| `loop_list` | loop | List active loops (current session or all) |
| `loop_stop` | loop | Stop by id, or `all: true` for current session |
| `loop_reschedule` | loop | Dynamic mode: next delay (1–60 min) or `stop: true` |
| `loop_status` | loop | Detailed status of one loop or all in session |
| `install_skill` | loop | Write `.opencode/skills/loop-best-practices/SKILL.md` |
| `goal_set` | goal | Set the session completion condition |
| `goal_clear` | goal | Clear the condition, stop auto-continue |
| `goal_status` | goal | Read goal state (condition, turns, last evaluator note) |

All tools return the object variant of `ToolResult` (`{ title?, output, metadata? }`) for richer TUI rendering.

## Configuration

### Goal options (in `opencode.jsonc`, under the `goal` key)

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Master switch |
| `evaluatorModel` | `""` | `"providerID/modelID"` for the completion check; empty reuses the goal session's model |
| `maxTurns` | `0` | Hard cap on auto-continuations (0 = unlimited) |
| `noProgressLimit` | `3` | Consecutive evaluator NOs with the same reason before pausing |
| `abortSuppressMs` | `120000` | How long a user cancel suppresses auto-continue |
| `idleGraceMs` | `1200` | Grace after idle before evaluating |
| `completionMarker` | `"Goal Completed"` | Fallback: a final assistant line starting with this ends the loop if the evaluator is unreachable |

Each key can also be set via a `GOAL_MODE_*` env var (camelCase → SNAKE_CASE, e.g. `GOAL_MODE_MAX_TURNS`, `GOAL_MODE_EVALUATOR_MODEL`).

### Loop

Loop takes no config; behavior is controlled via tool args and these override files:

| File | Purpose |
|---|---|
| `<workdir>/.opencode/loop.md` | Project-level maintenance prompt override (highest priority) |
| `~/.config/opencode/loop.md` | Global maintenance prompt override |

### Debug

Set `OPENCODE_LOOP_DEBUG=1` to log every loop event to `~/.config/opencode/logs/loop/_events.log`. Set `GOAL_MODE_DEBUG=1` to log each idle decision.

## Files on disk

| Path | Purpose |
|---|---|
| `~/.config/opencode/loops/<sessionId>.json` | Persisted loop jobs (auto-managed) |
| `~/.config/opencode/goals/<sessionId>.json` | Persisted goal state (auto-managed) |
| `~/.config/opencode/logs/loop/*.log` | Per-job fire logs + event log |

Both features persist per session and rehydrate on `session.created`, so active loops and an in-flight goal survive `opencode --resume`.

## How it differs from `opencode-scheduler`

| | opencode-scheduler | opencode-loop-goal |
|---|---|---|
| Lifetime | Survives reboots (launchd/systemd/cron) | Session-scoped (dies when opencode closes) |
| Execution | `opencode run` subprocess | In-process SDK prompt injection |
| Use case | CC Routines / Desktop scheduled tasks | CC `/loop` + `/goal` (live-session) |
| State | `~/.config/opencode/scheduler/scopes/` | `loops/` + `goals/` per session |

They are complementary — install both for full coverage.

## Architecture

One combined `Plugin` export composes two features (`src/index.ts`), each a factory returning `{ hooks, tools }`:

```
src/
  index.ts          # combines loop + goal hooks and tools
  shared/
    transport.ts    # unified session API: v2 SDK -> v1 shape -> HTTP fallback
    result.ts       # object-shape ToolResult builders
    persist.ts      # generic per-session JSON store (loops + goals)
    config.ts       # defaults < ENV < options resolver
    paths.ts, util.ts
  loop/
    index.ts        # fire path, event handling, tools, compaction hook
    cron.ts         # shorthand + 5-field cron parsing, next-fire
    registry.ts     # in-memory jobs + debounced disk persistence
    jitter.ts, types.ts, maintenance.ts, skill.ts
  goal/
    index.ts        # idle pipeline + hooks (chat.params/message, event, compacting)
    evaluator.ts    # strict YES/NO prompt on an ephemeral session
    decision.ts     # decideAfterIdle: continue / achieved / paused / none
    transcript.ts, prompt.ts, state.ts, config.ts, tools.ts
commands/{loop,lstop,goal}.md   # slash-command dispatchers
agents/goal.md                   # the goal primary agent
```

### Shared transport

Both features inject prompts through the same `shared/transport.ts` adapter: it tries the v2 SDK flat calls (`client.session.prompt({ sessionID, ... })`), falls back to the v1 shape (`{ path: { id }, body }`), and finally to plain HTTP against `input.serverUrl`. One transport layer to fix, both features benefit.

### Loop invariants

- **Skip-if-busy**: if the session is busy at fire time, the job sets `pendingFire=true` and waits for `session.idle`. No catch-up for missed fires.
- **Jitter**: deterministic per-job offset (up to 30 min, or half the interval for sub-hourly jobs), from an FNV-1a hash of the job id.
- **7-day expiry**; **50-job cap per session**.
- **Dynamic fallback**: if a dynamic loop doesn't call `loop_reschedule`, one 20-minute fallback fires; if that also doesn't reschedule, the loop stops.

### Goal invariants

- **Event-driven**: auto-continue fires only on `session.idle`/`session.status:idle` while on the goal agent with a condition set.
- **Fail-open evaluator**: on error, Goal Mode retries (3x) then schedules a delayed re-check so a transient evaluator failure can't stall the loop.
- **Compaction-aware**: the active condition + last evaluator note are injected into compaction context so the objective survives context compression.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

## Credits

The loop cron parser, slugify/FNV utilities, and built-in-skill pattern are adapted from [`different-ai/opencode-scheduler`](https://github.com/different-ai/opencode-scheduler). The goal-mode logic (idle evaluator, continuation/summary prompts, decision state machine) is ported from [`devinoldenburg/opencode-goal-mode`](https://github.com/devinoldenburg/opencode-goal-mode) and rewritten in TypeScript on top of the shared transport. The execution model is in-process (SDK prompt injection) rather than OS-level subprocess scheduling.

## License

MIT
