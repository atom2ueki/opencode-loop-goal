/**
 * Synthetic continuation / completion bodies and trigger markers.
 *
 * Bodies use REST field names ({ agent, system, parts, model }); the shared
 * transport sends them verbatim.
 */

import { GOAL_AGENT_ID, type SessionModel } from "./state"
import type { PromptBody } from "../shared/transport"

export const GOAL_MODE_PREFIX = "[Goal Mode]"
export const SYNTHETIC_TRIGGER = "(goal-mode continue)"
export const SYNTHETIC_ACHIEVED_TRIGGER = "(goal-mode completion summary)"

function modelOf(model: SessionModel | null): Pick<SessionBody, "model" | "variant"> {
  if (!model) return {}
  const variant =
    model.variant && String(model.variant).trim().toLowerCase() !== "default" ? model.variant : undefined
  return {
    model: { providerID: model.providerID, modelID: model.modelID },
    ...(variant ? { variant } : {}),
  }
}

type SessionBody = PromptBody & { variant?: string }

/** True when every text part is synthetic (harness continuation, not the user). */
export function isSyntheticUserTurn(parts: unknown): boolean {
  if (!Array.isArray(parts) || parts.length === 0) return false
  const textParts = parts.filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text")
  if (textParts.length === 0) return false
  return textParts.every((p) => (p as { synthetic?: boolean }).synthetic === true)
}

export function buildContinuationBody(reason: string, model: SessionModel | null): SessionBody {
  return {
    agent: GOAL_AGENT_ID,
    ...modelOf(model),
    system: [
      GOAL_MODE_PREFIX,
      "The completion condition is not met yet. Continue implementation or verification.",
      "Write **zero** summary text on this turn — no `Goal Completed`, no completion banner, no 'What was implemented / Outcome / Note from completion check' sections, and no final wrap-up.",
      "Only the later synthetic `(goal-mode completion summary)` turn may produce the `Goal Completed` banner and full summary sections.",
      "Do not repeat full verification output unless fixing a gap.",
      "",
      `Evaluator note: ${reason}`,
    ].join("\n"),
    parts: [{ type: "text", text: SYNTHETIC_TRIGGER, synthetic: true }],
  }
}

/**
 * One synthetic turn after the evaluator says YES — implementation wrap-up for the user.
 */
export function buildAchievedSummaryBody(
  decision: { achievedCondition?: string; reason?: string },
  model: SessionModel | null,
): SessionBody {
  const condition = String(decision?.achievedCondition || "").trim() || "(see session)"
  const evalNote = String(decision?.reason || "").trim()
  const marker = "Goal Completed"

  return {
    agent: GOAL_AGENT_ID,
    ...modelOf(model),
    system: [
      GOAL_MODE_PREFIX,
      "The completion condition was satisfied. Goal Mode has stopped auto-continue.",
      "",
      "This is the ONLY turn where you may write `Goal Completed`.",
      "Write a final **user-facing** summary only. Do NOT re-run checks or paste verification logs again.",
      "Reference what you already did in this session; keep it concise and readable.",
      "",
      `Start your reply with exactly: ${marker}`,
      "",
      "Then use these markdown sections:",
      "## What was implemented",
      "## How it was verified (brief — point to earlier output, no log dumps)",
      "## Outcome",
      evalNote ? "## Note from completion check" : "",
      "",
      `Condition satisfied:\n${condition}`,
      evalNote ? `\nEvaluator: ${evalNote}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    parts: [{ type: "text", text: SYNTHETIC_ACHIEVED_TRIGGER, synthetic: true }],
  }
}
