/**
 * Goal Mode configuration — small on purpose.
 *
 * Precedence (lowest -> highest):
 *   1. DEFAULT_CONFIG below
 *   2. GOAL_MODE_* environment variables
 *   3. Plugin options from opencode.json: ["opencode-loop-goal", { goal: { ... } }]
 *
 * There are deliberately NO guardrail keys: Goal Mode never blocks commands,
 * never rewrites messages, and never launches reviewer subagents. The only
 * thing it does is keep the goal agent working until the goal is met.
 */

import { parseModelRef, resolveConfig } from "../shared/config"

export type GoalConfigKey =
  | "enabled"
  | "evaluatorModel"
  | "maxTurns"
  | "noProgressLimit"
  | "abortSuppressMs"
  | "idleGraceMs"
  | "completionMarker"

export interface GoalConfig {
  /** Master switch. `false` turns the whole feature into a no-op. */
  enabled: boolean
  /**
   * Model used for the completion check, as "providerID/modelID"
   * (e.g. "anthropic/claude-haiku-4-5"). Empty reuses the goal session's model.
   * Claude Code uses a small fast model here; set one for speed and cost.
   */
  evaluatorModel: string
  /** Hard cap on automatic continuations per goal. 0 = unlimited. */
  maxTurns: number
  /** Consecutive evaluator "NO" verdicts with the SAME reason before pausing. */
  noProgressLimit: number
  /** How long (ms) a user cancel suppresses auto-continue. */
  abortSuppressMs: number
  /** Grace (ms) after idle before evaluating, so a fast user follow-up wins. */
  idleGraceMs: number
  /** Fallback marker ending the loop when the evaluator is unreachable. */
  completionMarker: string
}

export const DEFAULT_GOAL_CONFIG: GoalConfig = {
  enabled: true,
  evaluatorModel: "",
  maxTurns: 0,
  noProgressLimit: 3,
  abortSuppressMs: 2 * 60 * 1000,
  idleGraceMs: 1200,
  completionMarker: "Goal Completed",
}

const SPEC = [
  { key: "enabled", kind: "boolean" },
  { key: "evaluatorModel", kind: "string" },
  { key: "maxTurns", kind: "int" },
  { key: "noProgressLimit", kind: "int" },
  { key: "abortSuppressMs", kind: "int" },
  { key: "idleGraceMs", kind: "int" },
  { key: "completionMarker", kind: "string" },
] as const

/** Resolve goal config from defaults, env (GOAL_MODE_*), and plugin options. */
export function resolveGoalConfig(options: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): GoalConfig {
  const resolved = resolveConfig<GoalConfigKey>(
    DEFAULT_GOAL_CONFIG as unknown as Record<GoalConfigKey, unknown>,
    [...SPEC],
    { prefix: "GOAL_MODE_", options, env },
  )
  return resolved as unknown as GoalConfig
}

export { parseModelRef }
