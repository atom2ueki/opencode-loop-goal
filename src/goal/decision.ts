/**
 * Decide what to do after session.idle + an evaluator result.
 * Ported 1:1 from the original opencode-goal-mode loop.js.
 *
 * Mutates state counters when continuing.
 */

import type { GoalConfig } from "./config"
import { lastAssistantText } from "./transcript"
import type { GoalSessionState } from "./state"
import type { TranscriptMessage } from "../shared/transport"

/** Claude Code stops forcing continuation after 8 consecutive blocks. */
export const MAX_CONSECUTIVE_CONTINUATIONS = 8

export type EvalResult =
  | { ok: true; met: boolean; reason: string }
  | { ok: false; error: string; raw?: string }

export type Decision =
  | { action: "none" }
  | { action: "none"; reason: string }
  | { action: "paused"; reason: string }
  | { action: "achieved"; reason?: string; achievedCondition: string }
  | { action: "continue"; message: string }

export function decideAfterIdle(
  state: GoalSessionState,
  config: GoalConfig,
  evalResult: EvalResult,
  opts: { messages?: TranscriptMessage[]; now?: number } = {},
): Decision {
  const now = opts.now ?? Date.now()
  const condition = String(state?.condition || "").trim()
  if (!condition) return { action: "none" }
  if (!state?.onGoalAgent) return { action: "none", reason: "not_on_goal_agent" }

  if (state.abortedAt) {
    const elapsed = now - Number(state.abortedAt)
    if (elapsed >= 0 && elapsed < config.abortSuppressMs) {
      return { action: "none", reason: "user_cancelled" }
    }
    state.abortedAt = 0
  }

  if (state.continuationActive) {
    state.continuationActive = false
    if (state.consecutiveContinuations >= MAX_CONSECUTIVE_CONTINUATIONS) {
      return { action: "paused", reason: "consecutive_continuation_cap" }
    }
  }

  if (evalResult?.ok && evalResult.met) {
    state.achievedAt = new Date(now).toISOString()
    state.achievedCondition = condition
    state.condition = ""
    state.turnCount = 0
    state.noProgressStreak = 0
    state.lastEvalReason = ""
    state.consecutiveContinuations = 0
    state.continuationActive = false
    return {
      action: "achieved",
      reason: evalResult.reason,
      achievedCondition: state.achievedCondition,
    }
  }

  if (evalResult?.ok && !evalResult.met) {
    return continuationDecision(state, config, evalResult.reason)
  }

  // Evaluator unavailable — try the completion-marker fallback.
  const marker = String(config.completionMarker || "").trim()
  const last = lastAssistantText(opts.messages ?? [])
  if (marker && last.startsWith(marker)) {
    state.achievedAt = new Date(now).toISOString()
    state.achievedCondition = condition
    state.condition = ""
    state.turnCount = 0
    state.noProgressStreak = 0
    state.consecutiveContinuations = 0
    return {
      action: "achieved",
      reason: "completion_marker",
      achievedCondition: state.achievedCondition,
    }
  }

  if (!evalResult?.ok) {
    return { action: "none", reason: "evaluator_unavailable" }
  }

  return { action: "none" }
}

function continuationDecision(state: GoalSessionState, config: GoalConfig, reason: string): Decision {
  const r = String(reason || "").trim() || "Continue working toward the goal."
  if (r === state.lastEvalReason) {
    state.noProgressStreak = (Number(state.noProgressStreak) || 0) + 1
  } else {
    state.noProgressStreak = 0
    state.lastEvalReason = r
  }

  const maxTurns = Number(config.maxTurns)
  if (Number.isFinite(maxTurns) && maxTurns > 0 && (Number(state.turnCount) || 0) >= maxTurns) {
    return { action: "paused", reason: `maxTurns (${maxTurns})` }
  }

  const limit = Number(config.noProgressLimit) || 3
  if (state.noProgressStreak >= limit) {
    return { action: "paused", reason: `no_progress (${limit} identical evaluator reasons)` }
  }

  if (state.consecutiveContinuations >= MAX_CONSECUTIVE_CONTINUATIONS) {
    return { action: "paused", reason: "consecutive_continuation_cap" }
  }

  state.turnCount = (Number(state.turnCount) || 0) + 1
  state.consecutiveContinuations = (Number(state.consecutiveContinuations) || 0) + 1
  state.continuationActive = true
  return { action: "continue", message: r }
}
