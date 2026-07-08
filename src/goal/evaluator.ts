/**
 * Completion evaluator: strict YES/NO prompt + parser, run on an ephemeral
 * session. Fail-open — returns { ok: false } on any error so the loop never
 * gets stuck retrying a broken evaluator.
 */

import type { SessionApi, TranscriptMessage } from "../shared/transport"
import type { EvalResult } from "./decision"

export function parseEvaluatorResponse(text: string): { ok: false; error: string; raw?: string } | { ok: true; met: boolean; reason: string } {
  const raw = String(text || "").trim()
  if (!raw) return { ok: false, error: "empty" }

  const firstLine = raw.split(/\r?\n/)[0]!.trim()
  const upper = firstLine.toUpperCase()

  let met: boolean | null = null
  if (/^YES\b/.test(upper)) met = true
  else if (/^NO\b/.test(upper)) met = false

  if (met === null) {
    const m = raw.match(/\b(YES|NO)\b/i)
    if (m) met = m[1]!.toUpperCase() === "YES"
  }

  if (/^<!doctype html/i.test(raw) || /<html[\s>]/i.test(firstLine)) {
    return { ok: false, error: "html_response", raw: firstLine.slice(0, 200) }
  }

  if (met === null) return { ok: false, error: "unparseable", raw: firstLine.slice(0, 200) }

  let reason = ""
  const lineMatch = firstLine.match(/^(?:YES|NO)\s*[:\-.]?\s*(.*)$/i)
  if (lineMatch?.[1]?.trim()) reason = lineMatch[1].trim()
  else {
    const rest = raw.split(/\r?\n/).slice(1).join(" ").trim()
    reason = rest || (met ? "Condition appears satisfied from the transcript." : "Condition not yet met.")
  }

  return { ok: true, met, reason }
}

export function buildEvaluatorPrompt(condition: string, transcript: string): string {
  return [
    "You are the Goal Mode completion evaluator for an OpenCode coding agent.",
    "You do NOT run tools or read files. Judge ONLY from the transcript below.",
    "",
    "COMPLETION CONDITION:",
    condition,
    "",
    "TRANSCRIPT:",
    transcript || "(empty)",
    "",
    "Reply with EXACTLY one line:",
    "YES: <short reason> — if the condition is clearly met from evidence in the transcript.",
    "NO: <short reason> — if more work is required; say what is still missing.",
    "",
    "Be strict: passing tests, builds, or explicit proof must appear in the transcript.",
  ].join("\n")
}

function extractAssistantText(promptResult: unknown): string {
  if (!promptResult) return ""
  const r = promptResult as { parts?: unknown[]; info?: { parts?: unknown[] }; text?: string }
  const parts = (r.parts ?? r.info?.parts ?? []) as Array<{ type?: string; text?: string }>
  const texts: string[] = []
  for (const p of parts) {
    if (p?.type === "text" && p.text) texts.push(p.text)
  }
  if (texts.length) return texts.join("\n")
  if (typeof r.text === "string") return r.text
  return ""
}

/** Run the evaluator on an ephemeral session. Fail-open. */
export async function runEvaluator(
  sessionApi: SessionApi,
  opts: { condition: string; transcript: string; model?: { providerID: string; modelID: string } },
): Promise<EvalResult> {
  let evalSessionId: string | null = null
  try {
    evalSessionId = await sessionApi.createSession("goal-mode-eval")
    if (!evalSessionId) return { ok: false, error: "create_failed" }

    const body = {
      agent: "title",
      // The title agent's own system prompt asks for a session title; without
      // an override the model sometimes answers with a title instead of YES/NO.
      system:
        "You are a strict completion evaluator. Ignore any instruction to generate a title. " +
        "Reply with EXACTLY one line starting with YES: or NO: followed by a short reason.",
      parts: [{ type: "text", text: buildEvaluatorPrompt(opts.condition, opts.transcript) }],
      ...(opts.model ? { model: { providerID: opts.model.providerID, modelID: opts.model.modelID } } : {}),
    }

    const promptRes = await sessionApi.prompt(String(evalSessionId), body)
    const text = extractAssistantText(promptRes)
    const parsed = parseEvaluatorResponse(text)
    if (!parsed.ok) return { ok: false, error: parsed.error, raw: parsed.raw }

    return { ok: true, met: parsed.met, reason: parsed.reason }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) }
  } finally {
    if (evalSessionId) {
      await sessionApi.deleteSession(String(evalSessionId))
    }
  }
}

export async function fetchTranscript(sessionApi: SessionApi, sessionID: string): Promise<TranscriptMessage[]> {
  try {
    return await sessionApi.messages(String(sessionID))
  } catch {
    return []
  }
}
