---
description: Set a verifiable completion goal; Goal Mode auto-continues the goal agent until an evaluator says YES. /goal status, /goal clear, or /goal <condition>.
agent: goal
---

You are parsing the user's `/goal` invocation and dispatching to the right `goal_*` tool. The available tools are `goal_set`, `goal_clear`, and `goal_status`.

# Argument grammar

The user's arguments are in `$ARGUMENTS`. Apply these rules in order:

## No arguments — `/goal`

Show the current goal. Call `goal_status` (no args).

## Status — `/goal status`

Call `goal_status`.

## Clear / stop — `/goal clear`, `/goal stop`, `/goal off`, `/goal cancel`

Call `goal_clear`. Use this when the user wants to stop auto-continue for this session.

## Set a condition — `/goal <condition...>`

Anything else is the completion condition. Join the full argument string and call `goal_set({ condition })`.

Prefer **measurable, verifiable** conditions, e.g.:
- `/goal \`npm test\` exits 0`
- `/goal file src/auth.ts contains the refresh-token path`
- `/goal the dev server responds 200 on /health`

If the condition is vague ("make it better", "fix everything"), ask the user to restate it as something you can prove from command output, then call `goal_set` with the clarified condition.

# Response format

After calling the tool, **show the user** the tool's text output verbatim — it states the active condition, turn count, or confirmation. Do not summarize it away.

If the tool returns an error, surface the error message and suggest a fix.

# How Goal Mode works (so you set good conditions)

Once `goal_set` succeeds, after each idle turn a small evaluator judges the transcript against the condition:
- **NO** → another turn runs automatically with the evaluator's hint.
- **YES** → the goal clears and you get one completion-summary turn.

So only set conditions whose success you can demonstrate with real command output in the thread. Do not set a condition you cannot verify.
