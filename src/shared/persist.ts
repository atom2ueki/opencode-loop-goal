/**
 * Generic per-session JSON persistence. Both loop jobs and goal state are
 * written as `<featuresDir>/<sessionId>.json`, debounced across writes.
 *
 * This is the same pattern loop already used; factored out so goal gets
 * `opencode --resume` parity for free.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs"
import { ensureDir } from "./util"
import { sessionStatePath } from "./paths"

export interface SessionStore<T> {
  /** Load the persisted value for a session, or null if missing/unreadable. */
  load(sessionId: string): T | null
  /** Persist the value for a session. */
  save(sessionId: string, value: T): void
  /** Delete the persisted file for a session (no-op if absent). */
  remove(sessionId: string): void
  /** List every session id that has a persisted file. */
  list(): string[]
}

export function createSessionStore<T>(featuresDir: string): SessionStore<T> {
  return {
    load(sessionId: string): T | null {
      const path = sessionStatePath(featuresDir, sessionId)
      if (!existsSync(path)) return null
      try {
        return JSON.parse(readFileSync(path, "utf-8")) as T
      } catch {
        return null
      }
    },
    save(sessionId: string, value: T): void {
      ensureDir(featuresDir)
      try {
        writeFileSync(sessionStatePath(featuresDir, sessionId), JSON.stringify(value, null, 2))
      } catch {
        /* best-effort */
      }
    },
    remove(sessionId: string): void {
      const path = sessionStatePath(featuresDir, sessionId)
      if (existsSync(path)) {
        try {
          unlinkSync(path)
        } catch {
          /* best-effort */
        }
      }
    },
    list(): string[] {
      if (!existsSync(featuresDir)) return []
      return readdirSync(featuresDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
    },
  }
}
