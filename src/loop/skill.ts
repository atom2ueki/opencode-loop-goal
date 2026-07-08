/** The loop-best-practices skill body, written by the install_skill tool. */

export const LOOP_BEST_PRACTICES_SKILL = `---
name: loop-best-practices
description: Patterns for safe, useful /loop iterations in OpenCode
---

## Use This Skill

Reference at the top of any /loop prompt that should run unattended:

@loop-best-practices

## Core Principles

1. **Idempotent.** Each iteration must be safe to rerun. Maintain state in files
   (e.g. a seen-list) rather than relying on conversation memory, which compacts.
2. **Self-contained.** Do not assume context from prior iterations. Re-discover
   state with tools (read files, run queries) at the start of each iteration.
3. **Bounded output.** Print a one-line summary at the end. Long logs bloat the
   transcript and trigger compaction faster.
4. **No irreversible actions unless authorized.** Pushing, deleting, merging,
   deploying — only when continuing something the user already approved.
5. **Dynamic mode: reschedule deliberately.** When using \`/loop <prompt>\` (no
   interval), call \`loop_reschedule\` with a delay based on what you observed:
   - seconds-left on a build -> 1-2 minutes
   - waiting on CI -> 5 minutes
   - quiet PR -> 30-60 minutes
   - nothing to do -> call \`loop_stop\` instead

## Output Contract

End every iteration with a single line:

\`[loop <jobId>] <status>: <one-line summary>\`

Status is one of: \`progressing\`, \`waiting\`, \`quiet\`, \`error\`.

## When to Stop

Call \`loop_stop\` (or \`loop_reschedule\` with \`stop: true\`) when:
- The condition you were polling is met
- Three consecutive iterations made no progress
- You hit something requiring user input
`
