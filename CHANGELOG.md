# Changelog

All notable changes to this project are documented in this file. The format
is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-07-08

### Fixed
- `/goal` no longer dumps its multi-line parsing grammar into the chat. The
  dispatch body is now a single line (`/goal $ARGUMENTS`); the argument grammar
  (no-args / `status` / `clear` / `<condition>`) moved into the hidden `goal`
  agent's system prompt, so only the user's input is shown.
- The **goal** agent is now `hidden: true`, so it no longer appears as a
  switchable mode next to plan/build (matching `/loop`). It is still the target
  of the `/goal` command and the synthetic auto-continue turns.

## [0.2.0] — 2026-07-08

Renamed from `opencode-loop` to **`opencode-loop-goal`** and merged in a
TypeScript rewrite of Goal Mode (ported from
[`devinoldenburg/opencode-goal-mode`](https://github.com/devinoldenburg/opencode-goal-mode)).
Loop and Goal now ship as **one combined plugin**.

### Added
- **Goal Mode** — set a verifiable completion condition; the dedicated **goal**
  agent auto-continues on idle until an evaluator judges it met.
  - Tools: `goal_set`, `goal_clear`, `goal_status`.
  - `/goal <condition>` slash command + `agents/goal.md` primary agent.
  - Idle-driven evaluator (strict YES/NO), decision state machine with safety
    rails: 8-consecutive-continue cap, no-progress breaker, cancel suppression,
    fail-open evaluator with a `completionMarker` fallback.
  - Config under the `goal` key in `opencode.jsonc` (`evaluatorModel`,
    `maxTurns`, `noProgressLimit`, `abortSuppressMs`, `idleGraceMs`,
    `completionMarker`, `enabled`) and `GOAL_MODE_*` env vars.
  - Per-session goal state persisted to `~/.config/opencode/goals/<sid>.json`
    for `opencode --resume` parity with loops.
- **Shared transport** (`src/shared/transport.ts`): unified v2 SDK → v1 shape →
  HTTP fallback session API, used by both loop's fire path and goal's
  continuation path. Fixes fragility against v2-only hosts.
- Object-shape `ToolResult` (`{ title?, output, metadata? }) for all tools,
  loop and goal, for richer TUI rendering.

### Changed
- Package renamed `opencode-loop` → `opencode-loop-goal`. Update your
  `opencode.jsonc` `plugin` entry and re-copy `commands/*.md` / `agents/goal.md`.
- Loop split into modular `src/{shared,loop,goal}` files (was a single ~1,200
  line `src/index.ts`). Behavior preserved; bundled output is still one
  `dist/index.js`.
- Loop tools and fire path now use the shared transport + object results.
- Repository and homepage URLs point at `atom2ueki/opencode-loop-goal`.

### Migration from 0.1.0
```jsonc
// before
{ "plugin": [["file:///.../opencode-loop/dist/index.js", {}]] }

// after
{ "plugin": [["file:///.../opencode-loop-goal/dist/index.js", { "goal": { "evaluatorModel": "anthropic/claude-haiku-4-5" } }]] }
```
Then `cp commands/*.md ~/.config/opencode/commands/` and
`cp agents/goal.md ~/.config/opencode/agents/`.

## [0.1.0]

- Initial release: session-scoped `/loop` plugin (fixed, dynamic, maintenance
  modes), Claude Code `/loop` equivalent.
