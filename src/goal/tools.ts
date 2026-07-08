/**
 * goal_set / goal_clear / goal_status tools. Object return shape via shared/result.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { err, ok } from "../shared/result"
import type { GoalStore } from "./state"

export function createGoalTools(store: GoalStore): Record<string, ToolDefinition> {
  function sessionKey(ctx: { sessionID?: string } | undefined): string | null {
    const raw = ctx?.sessionID
    if (raw === undefined || raw === null) return null
    const key = String(raw).trim()
    return key || null
  }

  return {
    goal_set: tool({
      description:
        "Set the session completion condition for Goal Mode. While set, Goal Mode auto-continues " +
        "after each turn until a separate evaluator judges the condition met. Call when the user " +
        "gives a concrete objective worth driving to completion. Use measurable conditions " +
        "(tests pass, build succeeds, specific files changed).",
      args: {
        condition: tool.schema.string().describe("Verifiable completion condition for this goal."),
      },
      async execute(args, ctx) {
        const key = sessionKey(ctx)
        if (!key) return err("Could not determine session id.")
        const condition = String(args?.condition || "").trim()
        if (!condition) return err("condition must be non-empty.")
        const state = store.stateFor(key)
        state.condition = condition.slice(0, 4000)
        state.turnCount = 0
        state.noProgressStreak = 0
        state.lastEvalReason = ""
        state.consecutiveContinuations = 0
        state.continuationActive = false
        state.achievedAt = ""
        state.achievedCondition = ""
        store.save(key)
        return ok(`Goal Mode is active for this session.\n\nCondition:\n${state.condition}`, {
          title: "Completion goal set",
          metadata: { condition: state.condition, uiLabel: "Completion goal" },
        })
      },
    }),

    goal_clear: tool({
      description: "Clear the active Goal Mode completion condition and stop auto-continue for this session.",
      args: {},
      async execute(_args, ctx) {
        const key = sessionKey(ctx)
        if (!key) return err("Could not determine session id.")
        const state = store.stateFor(key)
        const had = state.condition
        state.condition = ""
        state.turnCount = 0
        state.noProgressStreak = 0
        state.continuationActive = false
        state.consecutiveContinuations = 0
        store.save(key)
        return ok(had ? `Stopped auto-continue.\n\nPrevious condition:\n${had}` : "No completion goal was active.", {
          title: "Completion goal cleared",
          metadata: { uiLabel: "Completion goal cleared" },
        })
      },
    }),

    goal_status: tool({
      description: "Read Goal Mode state for this session (condition, turns, last evaluator reason).",
      args: {},
      async execute(_args, ctx) {
        const key = sessionKey(ctx)
        if (!key) return err("Could not determine session id.")
        const state = store.stateFor(key)
        const report = {
          onGoalAgent: state.onGoalAgent,
          condition: state.condition || null,
          turnCount: state.turnCount,
          noProgressStreak: state.noProgressStreak,
          lastEvalReason: state.lastEvalReason || null,
          achievedAt: state.achievedAt || null,
          achievedCondition: state.achievedCondition || null,
        }
        const active = !!state.condition
        return ok(
          active
            ? `Goal Mode is active.\nTurns: ${state.turnCount}\nCondition:\n${state.condition}` +
                (state.lastEvalReason ? `\n\nLast evaluator note:\n${state.lastEvalReason}` : "")
            : "No completion goal is set for this session.",
          { title: "Completion goal status", metadata: { ...report, uiLabel: "Completion goal status" } },
        )
      },
    }),
  }
}
