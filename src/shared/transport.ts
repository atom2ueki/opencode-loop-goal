/**
 * Unified session transport: v2 SDK -> v1 SDK shape -> plain HTTP fallback.
 *
 * OpenCode >=1.17 injects the v2 SDK into plugins (`input.client`): methods
 * take flat parameters — `client.session.prompt({ sessionID, parts, ... })` —
 * not the v1 `{ path: { id }, body }` shape. Calling v1-style against v2
 * produces server errors and sessions created under `<dir>/undefined`.
 *
 * This adapter tries v2 flat calls, falls back to v1 shape for older hosts,
 * and finally to plain HTTP against `input.serverUrl` (same-origin REST API).
 *
 * Both loop's fire path and goal's continuation path go through this so a
 * single fix to the transport layer repairs both features.
 */

import type { PluginInput } from "@opencode-ai/plugin"

/** A message as returned by session.messages — loosely typed (SDK surface varies). */
export interface TranscriptMessage {
  info?: { role?: string; type?: string; agent?: string; parts?: unknown[] }
  parts?: unknown[]
  role?: string
  agent?: string
}

/** The bodies we send use REST field names ({ agent?, system?, parts, model? }). */
export interface PromptBody {
  agent?: string
  system?: string | string[]
  parts?: Array<Record<string, unknown>>
  model?: { providerID: string; modelID: string }
  variant?: string
  title?: string
}

export interface SessionApi {
  promptAsync(sessionID: string, body: PromptBody): Promise<void>
  messages(sessionID: string): Promise<TranscriptMessage[]>
  createSession(title?: string): Promise<string>
  /** Synchronous prompt — returns the assistant reply (used by the evaluator). */
  prompt(sessionID: string, body: PromptBody): Promise<unknown>
  deleteSession(sessionID: string): Promise<void>
}

const unwrap = <T>(r: { data?: T } | T): T => (r && typeof r === "object" && "data" in (r as object) ? (r as { data: T }).data : r as T)

/** True when this SDK error means "wrong call shape", worth retrying v1 style. */
const isShapeError = (err: unknown): boolean => /ses.*got|%7B|path/i.test(String((err as Error)?.message ?? err))

/** Plain-HTTP fallback bound to the plugin's server + directory. */
function sessionHttp(input: PluginInput): SessionApi | null {
  const base = input?.serverUrl?.toString?.()?.replace(/\/$/, "") || ""
  const directory = input?.directory || ""
  if (!base || !directory) return null
  const headers = { "Content-Type": "application/json", "x-opencode-directory": directory }

  const http: SessionApi = {
    async promptAsync(sessionID, body) {
      const res = await fetch(`${base}/session/${sessionID}/prompt_async`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
      if (res.status !== 204 && !res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`prompt_async ${res.status}: ${text.slice(0, 200)}`)
      }
    },
    async messages(sessionID) {
      const res = await fetch(`${base}/session/${sessionID}/message`, {
        headers: { "x-opencode-directory": directory },
      })
      if (!res.ok) throw new Error(`messages ${res.status}`)
      const data = (await res.json()) as { data?: TranscriptMessage[] }
      return (Array.isArray(data) ? data : (data.data ?? [])) as TranscriptMessage[]
    },
    async createSession(title) {
      const res = await fetch(`${base}/session`, {
        method: "POST",
        headers,
        body: JSON.stringify(title ? { title } : {}),
      })
      if (!res.ok) throw new Error(`create ${res.status}`)
      const data = (await res.json()) as { id?: string; sessionID?: string }
      return (data.id ?? data.sessionID) as string
    },
    async prompt(sessionID, body) {
      const res = await fetch(`${base}/session/${sessionID}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`prompt ${res.status}: ${text.slice(0, 200)}`)
      }
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        return { text }
      }
    },
    async deleteSession(sessionID) {
      await fetch(`${base}/session/${sessionID}`, {
        method: "DELETE",
        headers: { "x-opencode-directory": directory },
      }).catch(() => {})
    },
  }
  return http
}

interface LooseSession {
  prompt: (a: unknown) => Promise<unknown>
  promptAsync: (a: unknown) => Promise<unknown>
  messages: (a: unknown) => Promise<unknown>
  create: (a: unknown) => Promise<unknown>
  delete: (a: unknown) => Promise<unknown>
}

/** Unified session transport: v2 SDK -> v1 SDK -> HTTP. */
function sessionTransport(client: unknown, http: SessionApi | null): SessionApi {
  const session = (client as { session?: LooseSession } | null)?.session

  // SDK responses are { data, error } and do NOT throw on API errors — treat
  // a present .error (or missing .data) as failure so fallbacks engage.
  function unwrapStrict<T>(res: unknown): T {
    const r = res as { error?: { message?: string; name?: string } } | undefined
    if (r && r.error) {
      throw new Error(String(r.error?.message || r.error?.name || JSON.stringify(r.error).slice(0, 200)))
    }
    return unwrap<T>(res as { data?: T } | T)
  }

  // v2thenV1 receives the session explicitly (guaranteed defined by caller)
  // so TS narrowing holds inside the lambdas.
  async function v2thenV1<T>(
    sess: LooseSession,
    v2: (s: LooseSession) => Promise<T>,
    v1: ((s: LooseSession) => Promise<T>) | null,
    httpCall: () => Promise<T>,
  ): Promise<T> {
    let lastErr: unknown
    try {
      return unwrapStrict<T>(await v2(sess))
    } catch (e) {
      lastErr = e
      if (v1) {
        try {
          return unwrapStrict<T>(await v1(sess))
        } catch (e2) {
          lastErr = e2
        }
      }
      if (!http) throw lastErr
    }
    if (http) return httpCall()
    throw lastErr ?? new Error("no transport")
  }

  return {
    async promptAsync(sessionID, body) {
      const key = String(sessionID)
      if (!session) {
        if (!http) throw new Error("no transport")
        return http.promptAsync(key, body)
      }
      await v2thenV1(
        session,
        (s) => s.promptAsync({ sessionID: key, ...body }),
        (s) => s.promptAsync({ path: { id: key }, body }),
        () => (http as SessionApi).promptAsync(key, body),
      )
    },
    async messages(sessionID) {
      const key = String(sessionID)
      if (!session) {
        if (!http) throw new Error("no transport")
        return http.messages(key)
      }
      const out = await v2thenV1(
        session,
        (s) => s.messages({ sessionID: key }),
        (s) => s.messages({ path: { id: key } }),
        () => (http as SessionApi).messages(key),
      )
      return Array.isArray(out) ? (out as TranscriptMessage[]) : []
    },
    async createSession(title) {
      if (!session) {
        if (!http) throw new Error("no transport")
        return http.createSession(title)
      }
      const out = await v2thenV1(
        session,
        (s) => s.create({ title }),
        (s) => s.create({ body: { title } }),
        () => (http as SessionApi).createSession(title),
      )
      const o = out as { id?: string; sessionID?: string }
      return (o?.id ?? o?.sessionID ?? (out as string)) as string
    },
    async prompt(sessionID, body) {
      const key = String(sessionID)
      // Synchronous prompt (evaluator must read the assistant reply). v2
      // `session.prompt` is queue-based and returns SessionInputAdmitted — NOT
      // the reply. HTTP v1 REST works in web/server mode; in pure TUI mode
      // `input.serverUrl` may be a placeholder with no listener, so fall back
      // to in-process v1 SDK.
      let httpErr: unknown
      if (http) {
        try {
          return await http.prompt(key, body)
        } catch (e) {
          httpErr = e
        }
      }
      if (session?.prompt) return unwrapStrict(await session.prompt({ path: { id: key }, body }))
      throw httpErr ?? new Error("no prompt transport")
    },
    async deleteSession(sessionID) {
      const key = String(sessionID)
      if (!session) {
        if (!http) throw new Error("no transport")
        try {
          await http.deleteSession(key)
        } catch {
          /* best-effort */
        }
        return
      }
      try {
        await v2thenV1(
          session,
          (s) => s.delete({ sessionID: key }),
          (s) => s.delete({ path: { id: key } }),
          () => (http as SessionApi).deleteSession(key),
        )
      } catch {
        /* best-effort */
      }
    },
  }
}

/** Resolve the session API for a plugin instance: v2 SDK first, HTTP fallback. */
export function resolveSessionApi(input: PluginInput): SessionApi {
  const client = (input as { client?: unknown }).client
  const http = sessionHttp(input)
  return sessionTransport(client, http)
}

/** prompt_async with retries — transient failures must not stall a loop/goal. */
export async function promptAsyncRetry(api: SessionApi, sessionID: string, body: PromptBody, attempts = 3): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await api.promptAsync(String(sessionID), body)
      return
    } catch (err) {
      lastErr = err
      if (!isShapeError(err)) {
        // exponential-ish backoff
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
  }
  throw lastErr ?? new Error("prompt_async failed")
}

export { unwrap, isShapeError }
