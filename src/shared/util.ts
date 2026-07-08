/**
 * Generic helpers shared by the loop and goal features.
 */

import { existsSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export const HOME = homedir()
export const OPENCODE_CONFIG = join(HOME, ".config", "opencode")

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function slugify(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
  return out || "loop"
}

/** Deterministic 32-bit FNV-1a hash. Used for per-job jitter and stable ids. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 8-char base36 id, like Claude Code's CronCreate ids and loop job ids. */
export function randomId(): string {
  let s = ""
  for (let i = 0; i < 8; i++) {
    s += Math.floor(Math.random() * 36).toString(36)
  }
  return s
}

export function nowIso(): string {
  return new Date().toISOString()
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function isTruthy(v: unknown): boolean {
  if (typeof v === "boolean") return v
  const s = String(v ?? "").trim().toLowerCase()
  return ["1", "true", "yes", "on"].includes(s)
}
