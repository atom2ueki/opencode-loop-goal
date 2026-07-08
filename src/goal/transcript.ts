/**
 * Transcript flattening for the evaluator. Pure logic.
 */

import type { TranscriptMessage } from "../shared/transport"

const MAX_CHARS = 24_000

function partText(part: unknown): string {
  if (!part || typeof part !== "object") return ""
  const p = part as { type?: string; text?: unknown; content?: unknown }
  if (p.type !== "text") return ""
  const t = p.text ?? p.content
  return typeof t === "string" ? t.trim() : ""
}

function messageRole(m: TranscriptMessage): "user" | "assistant" {
  const role = m?.info?.role ?? m?.role ?? m?.info?.type
  if (role === "user" || role === "assistant") return role
  const agent = m?.info?.agent ?? m?.agent
  if (agent) return "assistant"
  return "user"
}

/** Flatten session messages into a single string for the evaluator. */
export function formatTranscript(messages: unknown): string {
  const list = Array.isArray(messages) ? (messages as TranscriptMessage[]) : []
  const lines: string[] = []
  for (const m of list) {
    const role = messageRole(m)
    const parts = (m.parts ?? m.info?.parts ?? []) as unknown[]
    const chunks: string[] = []
    for (const p of parts) {
      if (p && typeof p === "object" && "synthetic" in p && (p as { synthetic?: boolean }).synthetic) continue
      const text = partText(p)
      if (text) chunks.push(text)
    }
    if (!chunks.length) continue
    const label = role === "user" ? "User" : "Assistant"
    lines.push(`${label}:\n${chunks.join("\n")}`)
  }
  let out = lines.join("\n\n")
  if (out.length > MAX_CHARS) {
    out = `…(transcript truncated)\n\n${out.slice(-MAX_CHARS)}`
  }
  return out
}

/** Last non-synthetic assistant text in the transcript. */
export function lastAssistantText(messages: unknown): string {
  const list = Array.isArray(messages) ? (messages as TranscriptMessage[]) : []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (messageRole(m) !== "assistant") continue
    const parts = (m.parts ?? m.info?.parts ?? []) as unknown[]
    const texts: string[] = []
    for (const p of parts) {
      if (p && typeof p === "object" && "synthetic" in p && (p as { synthetic?: boolean }).synthetic) continue
      const text = partText(p)
      if (text) texts.push(text)
    }
    if (texts.length) return texts.join("\n")
  }
  return ""
}
