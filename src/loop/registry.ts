/**
 * LoopRegistry — in-memory loop jobs indexed by session, with debounced disk
 * persistence (rehydrated on `session.created` for `opencode --resume`).
 *
 * Tracks BUSY sessions (positive signal); a session we've never heard from
 * defaults to idle, which is the safe default for firing loops.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { LOOPS_DIR } from "../shared/paths"
import { ensureDir, nowIso } from "../shared/util"
import { computeNextFire } from "./cron"
import { fromPersisted, toPersisted, type LoopJob, type PersistedJob } from "./types"

export const MAX_JOBS_PER_SESSION = 50
export const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days (CC default)
export const DEFAULT_DYNAMIC_DELAY_MS = 10 * 60 * 1000 // 10 minutes
export const FALLBACK_WAKEUP_MS = 20 * 60 * 1000 // 20 minutes (CC fallback)
export const MIN_DYNAMIC_DELAY_MS = 60 * 1000 // 1 minute
export const MAX_DYNAMIC_DELAY_MS = 60 * 60 * 1000 // 1 hour

export class LoopRegistry {
  private jobs = new Map<string, LoopJob>() // jobId -> LoopJob
  private bySession = new Map<string, Set<string>>() // sessionId -> Set<jobId>
  private busySessions = new Set<string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private persistenceDirty = new Set<string>()

  constructor() {
    // Debounced persistence flush. unref so the timer doesn't keep opencode alive.
    const handle = setInterval(() => this.flushAll(), 5_000)
    if (handle && typeof handle === "object" && "unref" in handle) {
      ;(handle as { unref: () => void }).unref()
    }
  }

  // --- session busy/idle tracking ---

  setIdle(sessionId: string, idle: boolean): void {
    if (idle) this.busySessions.delete(sessionId)
    else this.busySessions.add(sessionId)
  }

  isIdle(sessionId: string): boolean {
    return !this.busySessions.has(sessionId)
  }

  // --- job CRUD ---

  list(sessionId?: string): LoopJob[] {
    const all = Array.from(this.jobs.values())
    return sessionId ? all.filter((j) => j.sessionId === sessionId) : all
  }

  get(jobId: string): LoopJob | undefined {
    return this.jobs.get(jobId)
  }

  add(job: LoopJob): void {
    this.jobs.set(job.id, job)
    if (!this.bySession.has(job.sessionId)) this.bySession.set(job.sessionId, new Set())
    this.bySession.get(job.sessionId)!.add(job.id)
    this.markDirty(job.sessionId)
  }

  remove(jobId: string): LoopJob | undefined {
    const job = this.jobs.get(jobId)
    if (!job) return undefined
    this.clearTimer(jobId)
    this.jobs.delete(jobId)
    const set = this.bySession.get(job.sessionId)
    if (set) {
      set.delete(jobId)
      if (set.size === 0) this.bySession.delete(job.sessionId)
    }
    this.markDirty(job.sessionId)
    return job
  }

  clearSession(sessionId: string): void {
    const ids = this.bySession.get(sessionId)
    if (!ids) return
    for (const id of Array.from(ids)) this.remove(id)
    this.busySessions.delete(sessionId)
    this.deletePersistedSession(sessionId)
  }

  count(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0
  }

  // --- timer management ---

  setTimer(jobId: string, delayMs: number, callback: () => void): void {
    this.clearTimer(jobId)
    const safe = Math.max(1000, delayMs) // never sub-second; matches CC tick granularity
    const timer = setTimeout(() => {
      this.timers.delete(jobId)
      callback()
    }, safe)
    if (typeof timer === "object" && timer && "unref" in timer) {
      ;(timer as { unref: () => void }).unref()
    }
    this.timers.set(jobId, timer)
  }

  clearTimer(jobId: string): void {
    const t = this.timers.get(jobId)
    if (t) {
      clearTimeout(t)
      this.timers.delete(jobId)
    }
  }

  // --- persistence ---

  private markDirty(sessionId: string): void {
    this.persistenceDirty.add(sessionId)
  }

  flagDirty(sessionId: string): void {
    this.markDirty(sessionId)
  }

  private statePath(sessionId: string): string {
    return join(LOOPS_DIR, `${sessionId}.json`)
  }

  private deletePersistedSession(sessionId: string): void {
    const p = this.statePath(sessionId)
    if (existsSync(p)) {
      try { unlinkSync(p) } catch { /* best-effort */ }
    }
  }

  flushSession(sessionId: string): void {
    const jobs = this.list(sessionId)
    const path = this.statePath(sessionId)
    if (jobs.length === 0) {
      if (existsSync(path)) {
        try { unlinkSync(path) } catch { /* best-effort */ }
      }
    } else {
      ensureDir(LOOPS_DIR)
      const payload = {
        version: 1,
        sessionId,
        updatedAt: nowIso(),
        jobs: jobs.map(toPersisted),
      }
      try {
        writeFileSync(path, JSON.stringify(payload, null, 2))
      } catch { /* best-effort */ }
    }
    this.persistenceDirty.delete(sessionId)
  }

  private flushAll(): void {
    for (const sid of Array.from(this.persistenceDirty)) {
      this.flushSession(sid)
    }
  }

  loadSession(sessionId: string): number {
    const path = this.statePath(sessionId)
    if (!existsSync(path)) return 0
    let parsed: { jobs?: PersistedJob[] }
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"))
    } catch {
      return 0
    }
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : []
    let loaded = 0
    const now = Date.now()
    for (const p of jobs) {
      if (p.expiresAt <= now) continue
      if (p.nextFireAt < now) {
        try {
          if (p.mode === "fixed" && p.schedule) {
            p.nextFireAt = computeNextFire(p.schedule, now)
          } else if (p.mode === "maintenance") {
            p.nextFireAt = now + DEFAULT_DYNAMIC_DELAY_MS
          } else {
            p.awaitingReschedule = true
            p.nextFireAt = now + FALLBACK_WAKEUP_MS
          }
        } catch { /* keep stored fire time */ }
      }
      this.add(fromPersisted(p))
      loaded++
    }
    if (loaded > 0) this.markDirty(sessionId)
    return loaded
  }

  listPersistedSessions(): string[] {
    if (!existsSync(LOOPS_DIR)) return []
    return readdirSync(LOOPS_DIR)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => f.replace(/\.json$/, ""))
  }
}
