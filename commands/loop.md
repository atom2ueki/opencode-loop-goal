---
description: Run a prompt on a schedule (Claude Code /loop equivalent). Modes — fixed (/loop 5m ...), dynamic (/loop ...), or bare maintenance (/loop).
agent: build
---

You are parsing the user's `/loop` invocation and dispatching to the right `loop_*` tool. The available tools are `loop_start`, `loop_list`, `loop_stop`, `loop_status`, `loop_reschedule`, and `install_skill`.

# Argument grammar

The user's arguments are in `$ARGUMENTS`. Apply these rules in order:

## No arguments — `/loop`

Bare loop. Call `loop_start` with **no** `prompt` and **no** `interval`. This starts a *maintenance* loop: it runs the built-in maintenance prompt (or `.opencode/loop.md` / `~/.config/opencode/loop.md` if present) at a dynamic cadence.

## Status / management subcommands

- `/loop status` → call `loop_status` (no id).
- `/loop list` → call `loop_list`.
- `/loop list all` → call `loop_list` with `allSessions: true`.
- `/loop stop <id>` → call `loop_stop` with that id.
- `/loop stop all` → call `loop_stop` with `all: true`.
- `/loop clear` → alias for `/loop stop all`.

## Fixed interval — `/loop <interval> <prompt>`

If the **first token** is a shorthand interval (`<number><unit>` where unit is `s`, `m`, `h`, or `d`, e.g. `5m`, `30s`, `2h`, `1d`) **or** a 5-field cron expression (5 space-separated fields of digits / `*` / `/` / `-` / `,`), treat it as the interval and the remainder as the prompt.

Examples:
- `/loop 5m check the deploy status` → `loop_start({ interval: "5m", prompt: "check the deploy status" })`
- `/loop 30s poll CI` → `loop_start({ interval: "30s", prompt: "poll CI" })` (but warn the user that the minimum is 1 minute — the tool will enforce it)
- `/loop */10 * * * * check PR comments` → `loop_start({ interval: "*/10 * * * *", prompt: "check PR comments" })`
- `/loop every 2 hours check the queue` → recognize the `every N <unit>` form and convert to `loop_start({ interval: "2h", prompt: "check the queue" })`

## Dynamic — `/loop <prompt>`

If the first token is **not** an interval, treat the entire argument string as a prompt for *dynamic* mode (agent reschedules each iteration via `loop_reschedule`).

Example:
- `/loop check whether CI passed and address any review comments` → `loop_start({ prompt: "check whether CI passed and address any review comments" })` (no interval → dynamic mode)

## Skill as prompt — `/loop <interval> /<skill-name> <args>` or `/loop /<skill-name> <args>`

If the prompt portion starts with a slash (a skill reference like `/review-pr`), keep it as the literal prompt text. Skills invoked this way should be ones the model is allowed to invoke on its own (not `disable-model-invocation: true`).

# Response format

After calling the tool, **show the user** the tool's text output verbatim — it includes the assigned loop id, mode, schedule, next fire time, and expiry. Do not summarize it away. The user needs the id to stop the loop later.

If the tool returns an error, surface the error message and suggest a fix.

# When NOT to invoke this command

- The user typed `/loop` with no args and you don't see the `loop_start` tool → tell them the opencode-loop plugin isn't installed (they should see `~/.config/opencode/plugins/loop.ts`).
- The user is asking a question *about* loops rather than invoking one (e.g. "how do loops work?") → answer conversationally, don't call a tool.
