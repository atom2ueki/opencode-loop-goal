# opencode-loop

Session-scoped `/loop` plugin for [OpenCode](https://opencode.ai) — the Claude Code `/loop` equivalent.

> Loops live for the lifetime of a session, fire prompts into it on a schedule, and die when the session closes. State is restored on `opencode --resume`. 7-day expiry, jittered fires, skip-if-busy (no catch-up). 50-job cap per session.

## What it does

Three modes, matching CC's `/loop`:

| Mode | Invocation | Behavior |
|---|---|---|
| Fixed interval | `/loop 5m check the deploy` | Fires the prompt every 5 minutes |
| Dynamic | `/loop check the deploy` | Agent picks the next delay each iteration via `loop_reschedule` (1–60 min) |
| Maintenance | `/loop` | Runs the built-in maintenance prompt (or `.opencode/loop.md` override) |

Plus management: `/loop list`, `/loop status`, `/loop stop <id>`, `/loop stop all`, `/loop clear`.

## Install

### From npm (when published)

```jsonc
// opencode.json or opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-loop"]
}
```

Then copy [`commands/loop.md`](./commands/loop.md) into `~/.config/opencode/commands/loop.md` (or `.opencode/commands/loop.md` for project scope) to get the `/loop` slash command.

### From source (development)

```bash
git clone <this-repo>
cd opencode-loop
bun install
bun run build
```

Then either:

```jsonc
// ~/.config/opencode/opencode.jsonc — load the source file directly
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-loop/src/index.ts"]
}
```

…or copy `src/index.ts` into `~/.config/opencode/plugins/loop.ts` (auto-loaded).

## Tools exposed to the agent

| Tool | Purpose |
|---|---|
| `loop_start` | Schedule a new loop. Args: `prompt?`, `interval?`, `mode?` |
| `loop_list` | List active loops (current session or all) |
| `loop_stop` | Stop by id, or `all: true` for current session |
| `loop_reschedule` | Dynamic mode: set the next delay (1–60 min) or `stop: true` |
| `loop_status` | Detailed status of one loop or all in session |
| `install_skill` | Write `.opencode/skills/loop-best-practices/SKILL.md` |

## Configuration

The plugin reads no direct config; all behavior is controlled via tool args and these files:

| File | Purpose |
|---|---|
| `<workdir>/.opencode/loop.md` | Project-level maintenance prompt override (highest priority) |
| `~/.config/opencode/loop.md` | Global maintenance prompt override |
| `~/.config/opencode/loops/<sessionId>.json` | Persisted loop state (auto-managed) |
| `~/.config/opencode/logs/loop/*.log` | Per-job fire logs |

### Debug mode

Set `OPENCODE_LOOP_DEBUG=1` to log every event the plugin receives to `~/.config/opencode/logs/loop/_events.log`. Useful for diagnosing idle-detection or session-event issues.

## How it differs from `opencode-scheduler`

| | opencode-scheduler | opencode-loop |
|---|---|---|
| Lifetime | Survives reboots (launchd/systemd/cron) | Session-scoped (dies when opencode closes) |
| Execution | `opencode run` subprocess | `client.session.prompt` SDK call |
| Use case | CC Routines / Desktop scheduled tasks | CC `/loop` (live-session polling/maintenance) |
| State | `~/.config/opencode/scheduler/scopes/` | `~/.config/opencode/loops/<sessionId>.json` |

They are complementary — install both for full coverage.

## Architecture

The plugin is a single TypeScript file (~1,200 lines) that:

1. Registers an `event` hook listening for `session.created`, `session.idle`, `session.status`, `session.deleted`
2. Maintains an in-memory `LoopRegistry` (Map of jobs keyed by id, indexed by session)
3. Uses `setTimeout` per job (with `.unref()` so timers don't keep opencode alive)
4. Fires by calling `client.session.prompt({ path: { id }, body: { parts: [...] } })`
5. Persists state per session to disk on every change (5s debounce)
6. Rehydrates on `session.created` (covers `opencode --resume`)
7. Injects a loop summary into compaction prompts via `experimental.session.compacting`

Key invariants:
- **Skip-if-busy**: if the session is busy at fire time, the job sets `pendingFire=true` and waits for the next `session.idle` event. No catch-up for missed fires (matches CC).
- **Jitter**: deterministic per-job offset (up to 30 min, or half the interval for sub-hourly jobs), derived from FNV-1a hash of the job id.
- **7-day expiry**: every fire checks `expiresAt` and removes expired jobs; load also drops expired jobs.
- **Dynamic fallback**: if a dynamic-loop agent doesn't call `loop_reschedule` during a turn, one 20-minute fallback fires; if that also doesn't reschedule, the loop stops.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

### End-to-end smoke test

The fastest way to verify the plugin works in your environment:

```bash
# Terminal 1
opencode serve --port 4097

# Terminal 2 (in a temp project)
cd /tmp/loop-test && bun add @opencode-ai/sdk
# Write a tiny script that creates a session, calls loop_start via the agent,
# and polls for the [loop <id>] injection. See test/smoke.ts for a reference.
```

## Credits

The plugin structure, cron parser, slugify/FNV utilities, `okResult`/`errorResult` formatters, and built-in-skill pattern are adapted from [`different-ai/opencode-scheduler`](https://github.com/different-ai/opencode-scheduler). The execution model is entirely different (in-process SDK calls vs OS-level subprocess scheduling).

## License

MIT
