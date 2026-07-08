/**
 * Goal feature: a dedicated "goal" primary agent + an idle evaluator that
 * auto-continues the session until a completion condition is judged met.
 *
 * Factory `createGoalFeature(input, options)` returns { hooks, tools }.
 * Ported from opencode-goal-mode's plugin.js; logic unchanged — only the
 * language (TS), shared transport, disk-persisted state, and object tool
 * returns differ.
 */

import type { Hooks, PluginInput, ToolDefinition } from "@opencode-ai/plugin"
import { resolveGoalConfig, parseModelRef, type GoalConfig } from "./config"
import { createStore, GOAL_AGENT_ID, type GoalStore, type SessionModel } from "./state"
import { createGoalTools } from "./tools"
import { fetchTranscript, runEvaluator } from "./evaluator"
import { formatTranscript } from "./transcript"
import { decideAfterIdle } from "./decision"
import { buildAchievedSummaryBody, buildContinuationBody, isSyntheticUserTurn } from "./prompt"
import { promptAsyncRetry, resolveSessionApi, type SessionApi } from "../shared/transport"
import { sleep } from "../shared/util"

export interface GoalFeature {
  hooks: Partial<Hooks>
  tools: Record<string, ToolDefinition>
}

interface ModelInput {
  providerID?: string
  modelID?: string
  id?: string
  variant?: string
  provider?: { id?: string } | string
}

function captureModel(state: { model: SessionModel | null }, model: ModelInput | undefined, variant?: string): void {
  if (!model) return
  const providerID = model.providerID || (typeof model.provider === "object" ? model.provider?.id : model.provider)
  const modelID = model.modelID || model.id
  if (!providerID || !modelID) return
  const supplied =
    variant && String(variant).trim() && String(variant).trim().toLowerCase() !== "default" ? String(variant).trim() : undefined
  const entry: SessionModel = { providerID, modelID }
  const v = supplied || state.model?.variant
  if (v) entry.variant = v
  state.model = entry
}

function evaluatorModel(config: GoalConfig, state: { model: SessionModel | null }): SessionModel | null {
  const fromConfig = parseModelRef(config.evaluatorModel)
  if (fromConfig) return fromConfig
  return state.model
}

export function createGoalFeature(input: PluginInput, options: Record<string, unknown> = {}): GoalFeature {
  const config = resolveGoalConfig(options)
  const store = createStore()
  const sessionApi: SessionApi = resolveSessionApi(input)
  const decidingIdle = new Set<string>()

  async function resolveIdle(sessionID: string): Promise<void> {
    const key = store.norm(sessionID)
    try {
      const state = store.stateFor(key)
      if (!config.enabled) return
      if (!String(state.condition || "").trim()) return
      if (!state.onGoalAgent) return

      if (config.idleGraceMs > 0) await sleep(config.idleGraceMs)

      const messages = await fetchTranscript(sessionApi, key)
      const transcript = formatTranscript(messages)
      const evalModel = evaluatorModel(config, state)

      let evalResult = await runEvaluator(sessionApi, { condition: state.condition, transcript, model: evalModel ?? undefined })
      for (let attempt = 0; attempt < 2; attempt++) {
        if (evalResult.ok) break
        await sleep(1000 * (attempt + 1))
        evalResult = await runEvaluator(sessionApi, { condition: state.condition, transcript, model: evalModel ?? undefined })
      }

      if (evalResult.ok) state.lastEvaluatorAt = new Date().toISOString()

      const decision = decideAfterIdle(state, config, evalResult, { messages })
      if (["1", "true"].includes(String(process.env.GOAL_MODE_DEBUG || "").toLowerCase())) {
        console.log(
          `[goal-mode] idle session=${key} eval=${evalResult.ok ? ("met" in evalResult && evalResult.met ? "YES" : "NO") : `ERR:${evalResult.error}`}` +
            `${"raw" in evalResult && evalResult.raw ? ` raw=${JSON.stringify(String(evalResult.raw).slice(0, 200))}` : ""}` +
            ` decision=${decision.action}`,
        )
      }

      if (decision.action === "continue") {
        try {
          await promptAsyncRetry(sessionApi, key, buildContinuationBody(decision.message, state.model))
        } catch (err) {
          state.continuationActive = false
          state.consecutiveContinuations = Math.max(0, (state.consecutiveContinuations || 1) - 1)
          console.error("[goal-mode] continue prompt_async failed", key, (err as Error)?.message || err)
        }
      } else if (decision.action === "achieved") {
        try {
          await promptAsyncRetry(sessionApi, key, buildAchievedSummaryBody(decision, state.model))
        } catch {
          /* summary is best-effort; goal is already cleared */
        }
      } else if (decision.action === "none" && "reason" in decision && decision.reason === "evaluator_unavailable") {
        // The loop is event-driven; without a continue no further idle events
        // arrive. Schedule one delayed re-check so a transient evaluator
        // failure cannot permanently stall an active goal.
        const retries = (state.evalRetries = (state.evalRetries || 0) + 1)
        if (retries <= 5) {
          const t = setTimeout(() => {
            if (!decidingIdle.has(key)) {
              decidingIdle.add(key)
              void resolveIdle(key).catch(() => decidingIdle.delete(key))
            }
          }, 15_000)
          if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref()
        }
      }
      if (decision.action !== "none") state.evalRetries = 0
      store.save(key)
    } finally {
      decidingIdle.delete(key)
    }
  }

  const hooks: Partial<Hooks> = {
    async "chat.params"(inp) {
      try {
        if (!config.enabled || !inp?.sessionID) return
        const state = store.stateFor(inp.sessionID)
        state.onGoalAgent = String(inp.agent || "") === GOAL_AGENT_ID
        captureModel(state, inp.model as ModelInput | undefined, (inp.model as { variant?: string } | undefined)?.variant)
      } catch {
        /* never break a turn */
      }
    },

    async "chat.message"(inp, out) {
      try {
        if (!config.enabled || !inp?.sessionID) return
        if (isSyntheticUserTurn(out?.parts)) {
          const state = store.stateFor(inp.sessionID)
          captureModel(state, inp.model as ModelInput | undefined, inp.variant)
          if (inp.agent) state.onGoalAgent = String(inp.agent) === GOAL_AGENT_ID
          return
        }
        const state = store.stateFor(inp.sessionID)
        if (state.abortedAt) state.abortedAt = 0
        captureModel(state, inp.model as ModelInput | undefined, inp.variant)
        const outMsg = out?.message as { agent?: string; info?: { agent?: string } } | undefined
        const agentName = inp.agent ?? outMsg?.agent ?? outMsg?.info?.agent
        if (agentName) state.onGoalAgent = String(agentName) === GOAL_AGENT_ID
      } catch {
        /* never break a turn */
      }
    },

    "experimental.session.compacting": async (inp, out) => {
      try {
        if (!inp?.sessionID) return
        const state = store.stateFor(inp.sessionID)
        if (!state.condition) return
        out.context.push(
          `Goal Mode: active condition = ${state.condition}. ` +
            (state.lastEvalReason ? `Last evaluator note: ${state.lastEvalReason}` : ""),
        )
      } catch {
        /* ignore */
      }
    },

    async event(inp) {
      try {
        if (!config.enabled) return
        const event = (inp?.event ?? {}) as { type: string; properties?: Record<string, unknown> }

        if (event.type === "session.created") {
          const sid = event.properties?.sessionID as string | undefined
          if (sid) store.load(sid)
          return
        }

        if (event.type === "session.error") {
          const err = event.properties?.error as { name?: string } | undefined
          const sid = event.properties?.sessionID as string | undefined
          if (sid && err && /abort/i.test(String(err.name || ""))) {
            store.stateFor(sid).abortedAt = Date.now()
          }
          return
        }

        const idleSessionID =
          event.type === "session.idle" && event.properties?.sessionID
            ? (event.properties.sessionID as string)
            : event.type === "session.status" && event.properties?.sessionID && (event.properties.status as { type?: string })?.type === "idle"
              ? (event.properties.sessionID as string)
              : null
        if (idleSessionID) {
          const key = store.norm(idleSessionID)
          if (decidingIdle.has(key)) return
          decidingIdle.add(key)
          void resolveIdle(key).catch(() => {
            decidingIdle.delete(key)
          })
        }
      } catch {
        /* ignore */
      }
    },

    async dispose() {
      decidingIdle.clear()
    },
  }

  const tools = createGoalTools(store)

  return { hooks, tools }
}
