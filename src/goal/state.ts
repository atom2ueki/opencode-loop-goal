/**
 * Per-session Goal Mode state + store.
 *
 * Mirrors the original opencode-goal-mode state.js, but the store now also
 * persists to disk (~/.config/opencode/goals/<sessionId>.json) so an active
 * goal survives `opencode --resume`, just like loop jobs do.
 */

import { GOALS_DIR } from "../shared/paths"
import { createSessionStore } from "../shared/persist"

export const GOAL_AGENT_ID = "goal"

export interface SessionModel {
  providerID: string
  modelID: string
  variant?: string
}

/** The persisted shape — runtime-only `onGoalAgent` is re-derived on resume. */
export interface GoalSessionState {
  /** Completion condition set via goal_set; empty = no auto-continue loop. */
  condition: string
  /** User is on the goal primary agent (runtime-only; not persisted). */
  onGoalAgent: boolean
  /** Auto-continuations fired for the current condition. */
  turnCount: number
  /** Consecutive evaluator NOs with the same reason (stuck breaker). */
  noProgressStreak: number
  lastEvalReason: string
  /** Wall clock ms when user cancelled; suppresses auto-continue. */
  abortedAt: number
  /** Last idle ended in a continuation prompt. */
  continuationActive: boolean
  /** Consecutive auto-continues without clearing condition (cap at MAX). */
  consecutiveContinuations: number
  lastEvaluatorAt: string
  achievedAt: string
  achievedCondition: string
  /** Captured from chat.message / chat.params for promptAsync. */
  model: SessionModel | null
  /** Transient evaluator-retry counter for unavailable-evaluator recovery. */
  evalRetries: number
}

export function createState(): GoalSessionState {
  return {
    condition: "",
    onGoalAgent: false,
    turnCount: 0,
    noProgressStreak: 0,
    lastEvalReason: "",
    abortedAt: 0,
    continuationActive: false,
    consecutiveContinuations: 0,
    lastEvaluatorAt: "",
    achievedAt: "",
    achievedCondition: "",
    model: null,
    evalRetries: 0,
  }
}

const persist = createSessionStore<Omit<GoalSessionState, "onGoalAgent" | "evalRetries">>(GOALS_DIR)

export interface GoalStore {
  norm(sessionID: unknown): string
  stateFor(sessionID: unknown): GoalSessionState
  reset(sessionID: unknown): GoalSessionState
  /** Persist a session's state to disk (minus runtime-only fields). */
  save(sessionID: string): void
  /** Rehydrate persisted state into the store; no-op if absent. */
  load(sessionID: string): void
}

export function createStore(): GoalStore {
  const sessions = new Map<string, GoalSessionState>()

  const norm = (sid: unknown): string => {
    const key = String(sid ?? "default").trim()
    return key || "default"
  }

  return {
    norm,
    stateFor(sessionID) {
      const key = norm(sessionID)
      let st = sessions.get(key)
      if (!st) {
        st = createState()
        sessions.set(key, st)
      }
      return st
    },
    reset(sessionID) {
      const key = norm(sessionID)
      const fresh = createState()
      sessions.set(key, fresh)
      return fresh
    },
    save(sessionID) {
      const st = sessions.get(sessionID)
      if (!st) {
        persist.remove(sessionID)
        return
      }
      // Don't persist runtime-only / transient fields.
      const { onGoalAgent, evalRetries, ...rest } = st
      void onGoalAgent
      void evalRetries
      persist.save(sessionID, rest)
    },
    load(sessionID) {
      const loaded = persist.load(sessionID)
      if (!loaded) return
      const st = createState()
      Object.assign(st, loaded)
      st.onGoalAgent = false // re-derived when chat.params fires next
      st.evalRetries = 0
      sessions.set(sessionID, st)
    },
  }
}
