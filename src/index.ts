/**
 * opencode-loop — session-scoped /loop plugin for OpenCode
 *
 * Claude Code /loop equivalent. In-process scheduler that injects prompts
 * into a live session via the SDK. Three modes:
 *   - fixed interval:   /loop 5m check the deploy
 *   - dynamic:          /loop check the deploy   (agent picks the delay)
 *   - maintenance:      /loop                    (built-in or loop.md prompt)
 *
 * Loops live for the lifetime of the session and are restored on
 * `opencode --resume` from persisted state. 7-day expiry. Jittered fires.
 * Skip-if-busy (no catch-up). 50-job cap per session.
 *
 * State:  ~/.config/opencode/loops/<sessionId>.json
 * Logs:   ~/.config/opencode/logs/loop/<sessionId>-<jobId>.log
 *
 * Inspired by the structure of different-ai/opencode-scheduler, but the
 * execution model is in-process (SDK prompt injection) rather than OS-level
 * (launchd/systemd/cron firing `opencode run` subprocesses).
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { basename, join } from "path"
import { homedir } from "os"

// ============================================================
// Paths & constants
// ============================================================

const HOME = homedir()
const OPENCODE_CONFIG = join(HOME, ".config", "opencode")
const LOOPS_DIR = join(OPENCODE_CONFIG, "loops")
const LOGS_DIR = join(OPENCODE_CONFIG, "logs", "loop")

const MAX_JOBS_PER_SESSION = 50
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days (CC default)
const MIN_INTERVAL_MS = 60 * 1000 // 1 minute (cron granularity)
const MIN_DYNAMIC_DELAY_MS = 60 * 1000 // 1 minute
const MAX_DYNAMIC_DELAY_MS = 60 * 60 * 1000 // 1 hour
const DEFAULT_DYNAMIC_DELAY_MS = 10 * 60 * 1000 // 10 minutes
const FALLBACK_WAKEUP_MS = 20 * 60 * 1000 // 20 minutes (CC fallback)
const MAX_JITTER_MS = 30 * 60 * 1000 // 30 minutes (CC jitter cap)
const TICK_INTERVAL_MS = 1000 // 1 second (CC tick granularity)

const BUILTIN_MAINTENANCE_PROMPT = `Continue any unfinished work from the conversation. Then tend to the current branch's pull request if there is one: check CI status and any new review comments; address them or report what you found. If nothing is pending, run a small cleanup pass (bug hunt, simplification, dead-code removal) only if it is low-risk. Otherwise say so in one line.

Do not start new initiatives outside that scope. Irreversible actions (push, force-push, delete, merge, deploy) only proceed when they continue something the transcript already authorized.`

// ============================================================
// Utilities
// ============================================================

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function slugify(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
  return out || "loop"
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function randomId(): string {
  // 8-char base36 ID like CC's CronCreate IDs
  let s = ""
  for (let i = 0; i < 8; i++) {
    s += Math.floor(Math.random() * 36).toString(36)
  }
  return s
}

function nowIso(): string {
  return new Date().toISOString()
}

function logLine(jobId: string, sessionId: string, message: string): void {
  ensureDir(LOGS_DIR)
  const path = join(LOGS_DIR, `${sessionId}-${jobId}.log`)
  const line = `[${nowIso()}] ${message}\n`
  try {
    appendFileSync(path, line)
  } catch {
    // best-effort
  }
}

// ============================================================
// Interval & cron parsing
// ============================================================

const SHORTHAND_RE = /^(\d+)([smhd])$/

/**
 * Parse a shorthand interval ("5m", "30s", "2h", "1d") into milliseconds.
 * Cron expressions are detected by 5-space-separated fields and parsed
 * separately. Returns null if input is neither.
 */
function parseInterval(input: string): number | null {
  const trimmed = input.trim()
  const m = SHORTHAND_RE.exec(trimmed)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2]
  const ms =
    unit === "s" ? n * 1000 :
    unit === "m" ? n * 60_000 :
    unit === "h" ? n * 3_600_000 :
    unit === "d" ? n * 86_400_000 : null
  return ms
}

function isCronExpression(input: string): boolean {
  const parts = input.trim().split(/\s+/)
  return parts.length === 5
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  label: string,
  allowSundaySeven = false
): number[] | null {
  if (field === "*") return null
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10)
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Invalid cron ${label} step: ${field}`)
    }
    const values: number[] = []
    for (let v = min; v <= max; v += step) values.push(v)
    return values
  }
  if (field.includes(",")) {
    const values = field.split(",").map((p) => parseCronNumber(p, min, max, label, allowSundaySeven))
    return Array.from(new Set(values)).sort((a, b) => a - b)
  }
  if (/^\d+$/.test(field)) {
    return [parseCronNumber(field, min, max, label, allowSundaySeven)]
  }
  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map((p) => parseInt(p, 10))
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
      throw new Error(`Invalid cron ${label} range: ${field}`)
    }
    const values: number[] = []
    for (let v = lo; v <= hi; v++) values.push(v)
    return values
  }
  throw new Error(`Invalid cron ${label} field: ${field}`)
}

function parseCronNumber(
  value: string,
  min: number,
  max: number,
  label: string,
  allowSundaySeven: boolean
): number {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid cron ${label} value: ${value}`)
  const normalized = allowSundaySeven && parsed === 7 ? 0 : parsed
  if (normalized < min || normalized > max) throw new Error(`Invalid cron ${label} value: ${value}`)
  return normalized
}

function validateCron(cron: string): void {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`Invalid cron (need 5 fields): ${cron}`)
  parseCronField(parts[0], 0, 59, "minute")
  parseCronField(parts[1], 0, 23, "hour")
  parseCronField(parts[2], 1, 31, "day of month")
  parseCronField(parts[3], 1, 12, "month")
  parseCronField(parts[4], 0, 7, "day of week", true)
}

/**
 * Compute the next time (epoch ms) at or after `after` that matches the cron
 * expression. Pure brute-force scan in 1-minute steps; cheap enough for our
 * 7-day horizon and avoids the gnarly bugs of vixie-cron reimplementation.
 */
function nextCronTime(cron: string, after: Date = new Date()): number {
  validateCron(cron)
  const [mField, hField, domField, monField, dowField] = cron.trim().split(/\s+/)
  const minutes = parseCronField(mField, 0, 59, "minute") ?? range(0, 59)
  const hours = parseCronField(hField, 0, 23, "hour") ?? range(0, 23)
  const doms = parseCronField(domField, 1, 31, "day of month") ?? null
  const mons = parseCronField(monField, 1, 12, "month") ?? null
  const dows = parseCronField(dowField, 0, 7, "day of week", true) ?? null

  // Start at the next minute boundary
  const start = new Date(after)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  // Cap the scan at ~366 days to avoid infinite loops on impossible exprs
  const cap = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000)

  for (let t = start; t <= cap; t.setMinutes(t.getMinutes() + 1)) {
    const m = t.getMinutes()
    const h = t.getHours()
    const dom = t.getDate()
    const mon = t.getMonth() + 1
    const dow = t.getDay() // 0=Sun..6=Sat

    if (!minutes.includes(m)) continue
    if (!hours.includes(h)) continue
    if (mons && !mons.includes(mon)) continue
    // vixie-cron: if both dom and dow are constrained, match if EITHER matches
    if (doms && dows) {
      if (!doms.includes(dom) && !dows.includes(dow)) continue
    } else if (doms) {
      if (!doms.includes(dom)) continue
    } else if (dows) {
      if (!dows.includes(dow)) continue
    }
    return t.getTime()
  }
  throw new Error(`No next fire time for cron "${cron}" within 1 year`)
}

function range(lo: number, hi: number): number[] {
  const out: number[] = []
  for (let v = lo; v <= hi; v++) out.push(v)
  return out
}

/**
 * Convert a shorthand interval to the next-fire delay from now.
 * Cron expressions are passed through to nextCronTime.
 * Returns epoch ms of the next fire.
 */
function computeNextFire(schedule: string, fromMs: number = Date.now()): number {
  const ms = parseInterval(schedule)
  if (ms !== null) {
    return fromMs + Math.max(ms, MIN_INTERVAL_MS)
  }
  if (isCronExpression(schedule)) {
    return nextCronTime(schedule, new Date(fromMs))
  }
  throw new Error(`Unrecognized schedule: "${schedule}". Use shorthand (5m, 2h) or 5-field cron.`)
}

/**
 * Interval -> display string ("every 5 minutes", "every 2 hours").
 */
function describeSchedule(schedule: string, mode: LoopMode): string {
  if (mode === "dynamic") return "dynamic (agent chooses 1-60 min delays)"
  if (mode === "maintenance" && !schedule) return "dynamic maintenance"
  const ms = parseInterval(schedule)
  if (ms !== null) {
    const mins = ms / 60_000
    if (mins < 60) return `every ${mins} minute${mins === 1 ? "" : "s"}`
    const hours = mins / 60
    if (hours < 24) return `every ${hours} hour${hours === 1 ? "" : "s"}`
    const days = hours / 24
    return `every ${days} day${days === 1 ? "" : "s"}`
  }
  return `cron: ${schedule}`
}

// ============================================================
// LoopJob model
// ============================================================

type LoopMode = "fixed" | "dynamic" | "maintenance"

interface LoopJob {
  id: string
  sessionId: string
  workdir: string
  mode: LoopMode
  prompt: string | null // null = maintenance prompt
  schedule: string // shorthand or cron (empty for maintenance/dynamic)
  intervalMs?: number // for fixed mode (parsed from schedule)
  nextFireAt: number // epoch ms
  createdAt: number
  expiresAt: number
  lastFiredAt?: number
  fireCount: number
  jitterMs: number
  awaitingReschedule: boolean // dynamic mode: waiting for agent to call loop_reschedule
  fallbackUsed: boolean // dynamic mode: already used the 20-min fallback
  firing: boolean // mutex: prompt injection in flight
  pendingFire: boolean // true when timer fired but session was busy
}

/**
 * The on-disk shape. Omits runtime-only fields (timer, mutex flags).
 * The `timer` is re-armed on load.
 */
interface PersistedJob {
  id: string
  sessionId: string
  workdir: string
  mode: LoopMode
  prompt: string | null
  schedule: string
  intervalMs?: number
  nextFireAt: number
  createdAt: number
  expiresAt: number
  lastFiredAt?: number
  fireCount: number
  jitterMs: number
  awaitingReschedule: boolean
  fallbackUsed: boolean
}

function toPersisted(job: LoopJob): PersistedJob {
  return {
    id: job.id,
    sessionId: job.sessionId,
    workdir: job.workdir,
    mode: job.mode,
    prompt: job.prompt,
    schedule: job.schedule,
    intervalMs: job.intervalMs,
    nextFireAt: job.nextFireAt,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    lastFiredAt: job.lastFiredAt,
    fireCount: job.fireCount,
    jitterMs: job.jitterMs,
    awaitingReschedule: job.awaitingReschedule,
    fallbackUsed: job.fallbackUsed,
  }
}

function fromPersisted(p: PersistedJob): LoopJob {
  return {
    ...p,
    firing: false,
    pendingFire: false,
  }
}

// ============================================================
// LoopRegistry — in-memory state + disk persistence
// ============================================================

class LoopRegistry {
  private jobs = new Map<string, LoopJob>() // jobId -> LoopJob
  private bySession = new Map<string, Set<string>>() // sessionId -> Set<jobId>
  // Track BUSY sessions (positive signal) rather than idle ones. A session
  // we've never heard from is treated as idle by default, which is the safe
  // default for firing loops.
  private busySessions = new Set<string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>() // jobId -> timer
  private persistenceDirty = new Set<string>() // sessionIds needing a flush

  constructor() {
    // Persistence flush (debounced writes). unref so the timer doesn't keep
    // the opencode process alive solely for loop bookkeeping.
    const handle = setInterval(() => this.flushAll(), 5_000)
    if (handle && typeof handle === "object" && "unref" in handle) {
      ;(handle as { unref: () => void }).unref()
    }
  }

  // --- session busy/idle tracking ---

  /**
   * Mark the session busy/idle. We track BUSY as the positive signal because
   * busy is what `session.status` reliably tells us; a session we've never
   * heard from defaults to idle.
   */
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
    // Don't keep the event loop alive solely for loop timers — let opencode exit cleanly.
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

  /** Public so the fire/stop/reschedule flows outside the class can flag a flush. */
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
      // Drop expired jobs on load (CC: "Recurring tasks automatically expire 7 days after creation")
      if (p.expiresAt <= now) continue
      // If the next fire is in the past (session was offline), push it forward
      if (p.nextFireAt < now) {
        try {
          if (p.mode === "fixed" && p.schedule) {
            p.nextFireAt = computeNextFire(p.schedule, now)
          } else if (p.mode === "maintenance") {
            p.nextFireAt = now + DEFAULT_DYNAMIC_DELAY_MS
          } else {
            // dynamic — restore as paused (agent must reschedule)
            p.awaitingReschedule = true
            p.nextFireAt = now + FALLBACK_WAKEUP_MS
          }
        } catch { /* keep stored fire time */ }
      }
      const job = fromPersisted(p)
      this.add(job)
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

// Singleton — one registry per opencode server process
const registry = new LoopRegistry()

// ============================================================
// Maintenance prompt + loop.md loader
// ============================================================

/**
 * Resolve the maintenance prompt. Priority:
 *   1. <workdir>/.opencode/loop.md
 *   2. ~/.config/opencode/loop.md
 *   3. built-in BUILTIN_MAINTENANCE_PROMPT
 */
function resolveMaintenancePrompt(workdir: string): string {
  const candidates = [
    join(workdir, ".opencode", "loop.md"),
    join(OPENCODE_CONFIG, "loop.md"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8").trim()
        if (content) return content
      } catch { /* fall through */ }
    }
  }
  return BUILTIN_MAINTENANCE_PROMPT
}

// ============================================================
// Built-in skill
// ============================================================

const LOOP_BEST_PRACTICES_SKILL = `---
name: loop-best-practices
description: Patterns for safe, useful /loop iterations in OpenCode
---

## Use This Skill

Reference at the top of any /loop prompt that should run unattended:

@loop-best-practices

## Core Principles

1. **Idempotent.** Each iteration must be safe to rerun. Maintain state in files
   (e.g. a seen-list) rather than relying on conversation memory, which compacts.
2. **Self-contained.** Do not assume context from prior iterations. Re-discover
   state with tools (read files, run queries) at the start of each iteration.
3. **Bounded output.** Print a one-line summary at the end. Long logs bloat the
   transcript and trigger compaction faster.
4. **No irreversible actions unless authorized.** Pushing, deleting, merging,
   deploying — only when continuing something the user already approved.
5. **Dynamic mode: reschedule deliberately.** When using \`/loop <prompt>\` (no
   interval), call \`loop_reschedule\` with a delay based on what you observed:
   - seconds-left on a build → 1-2 minutes
   - waiting on CI → 5 minutes
   - quiet PR → 30-60 minutes
   - nothing to do → call \`loop_stop\` instead

## Output Contract

End every iteration with a single line:

\`[loop <jobId>] <status>: <one-line summary>\`

Status is one of: \`progressing\`, \`waiting\`, \`quiet\`, \`error\`.

## When to Stop

Call \`loop_stop\` (or \`loop_reschedule\` with \`stop: true\`) when:
- The condition you were polling is met
- Three consecutive iterations made no progress
- You hit something requiring user input
`

// ============================================================
// Output helpers (ported from opencode-scheduler)
// ============================================================

type OutputFormat = "text" | "json"

interface ToolResult<T = unknown> {
  success: boolean
  output: string
  shouldContinue: boolean
  data?: T
}

function normalizeFormat(format?: string): OutputFormat {
  return format === "json" ? "json" : "text"
}

function formatResult<T>(format: OutputFormat, result: ToolResult<T>): string {
  return format === "json" ? JSON.stringify(result, null, 2) : result.output
}

function okResult<T>(format: OutputFormat, output: string, data?: T): string {
  return formatResult(format, { success: true, output, shouldContinue: false, data })
}

function errorResult<T>(format: OutputFormat, output: string, data?: T): string {
  return formatResult(format, { success: false, output, shouldContinue: true, data })
}

function summarizeJob(job: LoopJob): Record<string, unknown> {
  return {
    id: job.id,
    mode: job.mode,
    schedule: job.schedule || "(dynamic)",
    description: describeSchedule(job.schedule, job.mode),
    prompt: job.prompt === null ? "(maintenance)" : (job.prompt.length > 80 ? job.prompt.slice(0, 77) + "..." : job.prompt),
    nextFireAt: new Date(job.nextFireAt).toISOString(),
    expiresAt: new Date(job.expiresAt).toISOString(),
    lastFiredAt: job.lastFiredAt ? new Date(job.lastFiredAt).toISOString() : null,
    fireCount: job.fireCount,
    state: jobState(job),
  }
}

function jobState(job: LoopJob): string {
  if (job.firing) return "firing"
  if (job.expiresAt <= Date.now()) return "expired"
  if (job.mode === "dynamic" && job.awaitingReschedule && !job.fallbackUsed) return "awaiting-reschedule"
  if (job.pendingFire) return "pending-fire"
  return "scheduled"
}

// ============================================================
// Jitter (deterministic per job ID, matches CC semantics)
// ============================================================

function computeJitterMs(jobId: string, intervalMs?: number): number {
  const max = intervalMs && intervalMs < 2 * MAX_JITTER_MS ? Math.floor(intervalMs / 2) : MAX_JITTER_MS
  // Deterministic offset from the job ID
  return fnv1a32(jobId) % Math.max(max, 1)
}

// ============================================================
// Plugin entry
// ============================================================

export const LoopPlugin: Plugin = (async ({ client, worktree, directory }) => {
  // `client`, `worktree`, `directory` are provided by opencode. We type-narrow
  // the client loosely because the SDK surface is large and we only use a
  // handful of methods; access is best-effort with optional chaining.
  const sdk = client as unknown as {
    session: {
      prompt: (args: { path: { id: string }; body: Record<string, unknown> }) => Promise<unknown>
    }
    tui?: {
      showToast?: (args: { body: { title?: string; message: string; variant?: string } }) => Promise<unknown>
    }
    app?: {
      log?: (args: { body: { service: string; level: string; message: string; extra?: Record<string, unknown> } }) => Promise<unknown>
    }
  }
  const sessionWorkdir = (worktree || directory || process.cwd()) as string

  // ----- helpers that need the client -----

  async function fireJob(job: LoopJob): Promise<void> {
    if (job.firing) {
      logLine(job.id, job.sessionId, "fire skipped: already firing")
      return
    }
    if (job.expiresAt <= Date.now()) {
      logLine(job.id, job.sessionId, "expiring (7-day cap reached)")
      registry.remove(job.id)
      return
    }

    job.firing = true
    job.pendingFire = false
    job.lastFiredAt = Date.now()
    job.fireCount += 1
    registry.flagDirty(job.sessionId)

    const promptText = job.prompt === null ? resolveMaintenancePrompt(job.workdir) : job.prompt
    const tagged = `[loop ${job.id}] ${promptText}`

    logLine(job.id, job.sessionId, `fire #${job.fireCount} mode=${job.mode}`)

    try {
      await sdk.session.prompt({
        path: { id: job.sessionId },
        body: { parts: [{ type: "text", text: tagged }] },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logLine(job.id, job.sessionId, `fire failed: ${msg}`)
      try {
        await sdk.tui?.showToast?.({
          body: { title: `loop ${job.id}`, message: `fire failed: ${msg}`, variant: "error" },
        })
      } catch { /* best-effort */ }
    } finally {
      job.firing = false
    }

    // Reschedule
    if (job.mode === "fixed" && job.schedule) {
      const base = computeNextFire(job.schedule, Date.now())
      job.nextFireAt = base + job.jitterMs
      armJob(job)
    } else if (job.mode === "maintenance") {
      // Default 15-min cadence, jittered
      const base = Date.now() + 15 * 60_000
      job.nextFireAt = base + job.jitterMs
      armJob(job)
    } else if (job.mode === "dynamic") {
      // Wait for agent to call loop_reschedule during this turn.
      // If they don't, schedule one fallback wakeup; if THAT one doesn't reschedule, stop.
      job.awaitingReschedule = true
      if (!job.fallbackUsed) {
        job.fallbackUsed = true
        job.nextFireAt = Date.now() + FALLBACK_WAKEUP_MS
        armJob(job)
        logLine(job.id, job.sessionId, `dynamic: no reschedule, fallback in ${FALLBACK_WAKEUP_MS / 60_000}m`)
      } else {
        logLine(job.id, job.sessionId, "dynamic: stopping (no reschedule after fallback)")
        registry.remove(job.id)
      }
    }
    registry.flagDirty(job.sessionId)
  }

  function armJob(job: LoopJob): void {
    const delay = Math.max(1000, job.nextFireAt - Date.now())
    registry.setTimer(job.id, delay, () => {
      void attemptFire(job)
    })
  }

  async function attemptFire(job: LoopJob): Promise<void> {
    if (job.expiresAt <= Date.now()) {
      registry.remove(job.id)
      return
    }
    if (Date.now() < job.nextFireAt) {
      // Spurious wake; re-arm
      armJob(job)
      return
    }
    if (registry.isIdle(job.sessionId) || !sdk?.session) {
      await fireJob(job)
    } else {
      // Session is busy. Mark pending and wait for session.idle event.
      job.pendingFire = true
      registry.flagDirty(job.sessionId)
      logLine(job.id, job.sessionId, "deferring fire: session busy")
    }
  }

  // ----- session lifecycle hooks -----

  // Diagnostic: log every event the handler sees, to debug idle tracking.
  // Remove or gate behind an env var once stable.
  const DEBUG = process.env.OPENCODE_LOOP_DEBUG === "1"
  function debugEvents(message: string): void {
    if (!DEBUG) return
    ensureDir(LOGS_DIR)
    try {
      appendFileSync(join(LOGS_DIR, "_events.log"), `[${nowIso()}] ${message}\n`)
    } catch { /* best-effort */ }
  }

  async function onEvent(event: { type: string; properties?: Record<string, unknown> }): Promise<void> {
    const props = event.properties || {}
    const sessionId = String(props.sessionID || props.sessionId || "")
    if (DEBUG) {
      const status = props.status ? JSON.stringify(props.status) : ""
      debugEvents(`event type=${event.type} sid=${sessionId} ${status}`)
    }

    if (event.type === "session.created" && sessionId) {
      // Rehydrate loops for this session (covers `opencode --resume`)
      const loaded = registry.loadSession(sessionId)
      if (loaded > 0) {
        for (const job of registry.list(sessionId)) {
          if (job.mode === "dynamic" && job.awaitingReschedule && !job.fallbackUsed) {
            // Don't auto-arm a paused dynamic loop; wait for explicit reschedule
            continue
          }
          armJob(job)
        }
        try {
          await sdk?.app?.log?.({
            body: { service: "loop", level: "info", message: `restored ${loaded} loop(s) for session ${sessionId}` },
          })
        } catch { /* best-effort */ }
      }
      return
    }

    if (event.type === "session.idle" && sessionId) {
      registry.setIdle(sessionId, true)
      debugEvents(`marked idle=true for ${sessionId}`)
      // Fire any pending jobs for this session
      const pending = registry.list(sessionId).filter((j) => j.pendingFire && !j.firing)
      for (const job of pending) {
        void fireJob(job)
      }
      return
    }

    if ((event.type === "session.updated" || event.type === "message.updated") && sessionId) {
      // Don't mark busy on every session.updated/message.updated — those fire
      // many times per turn, including AFTER session.idle in some orderings,
      // which would clobber the idle flag. Instead, rely on session.status
      // (busy/idle) as the authoritative signal below.
      return
    }

    // Authoritative busy/idle signal
    if (event.type === "session.status" && sessionId) {
      const status = props.status as { type?: string } | undefined
      if (status?.type === "busy") {
        registry.setIdle(sessionId, false)
        debugEvents(`marked idle=false for ${sessionId} (status=busy)`)
      } else if (status?.type === "idle") {
        registry.setIdle(sessionId, true)
        debugEvents(`marked idle=true for ${sessionId} (status=idle)`)
        // session.status:idle is more reliable than session.idle in some orderings;
        // fire pending jobs here too.
        const pending = registry.list(sessionId).filter((j) => j.pendingFire && !j.firing)
        for (const job of pending) {
          void fireJob(job)
        }
      }
      return
    }

    if (event.type === "session.deleted" && sessionId) {
      registry.clearSession(sessionId)
      return
    }
  }

  // ----- tools -----

  return {
    event: async ({ event }) => {
      await onEvent(event as { type: string; properties?: Record<string, unknown> })
    },

    // Inject loop context into compaction summaries so the agent remembers
    // pending loops after auto-compact.
    "experimental.session.compacting": async (input, output) => {
      const inputAny = input as { sessionID?: string; sessionId?: string }
      const sessionId = String(inputAny?.sessionID || inputAny?.sessionId || "")
      if (!sessionId) return
      const jobs = registry.list(sessionId)
      if (jobs.length === 0) return
      const summary = jobs
        .map(
          (j) =>
            `- loop ${j.id} (${j.mode}, ${describeSchedule(j.schedule, j.mode)}), fired ${j.fireCount}x, next: ${new Date(j.nextFireAt).toISOString()}`
        )
        .join("\n")
      const out = output as { context?: string[] }
      if (out && Array.isArray(out.context)) {
        out.context.push(`## Active loops in this session\n${summary}\n\nIf the user asks about loops, use loop_list / loop_status.`)
      }
    },

    tool: {
      // -----------------------------------------------------
      // loop_start — schedule a new loop
      // -----------------------------------------------------
      loop_start: tool({
        description:
          "Start a session-scoped loop that injects a prompt into the current session on a schedule. " +
          "Three modes: (1) fixed interval — pass both interval and prompt; " +
          "(2) dynamic — pass only prompt, the agent reschedules each iteration via loop_reschedule; " +
          "(3) maintenance — pass neither, runs the built-in maintenance prompt (or loop.md override). " +
          "Loops fire only while the session is idle and die with the session (restored on --resume). " +
          "Max 50 per session. Auto-expire after 7 days.",
        args: {
          prompt: tool.schema
            .string()
            .optional()
            .describe("Prompt text to run each iteration. Omit for the built-in maintenance prompt."),
          interval: tool.schema
            .string()
            .optional()
            .describe("Shorthand (5m, 30s, 2h, 1d) or 5-field cron (*\/5 * * * *). Omit for dynamic mode."),
          mode: tool.schema
            .enum(["fixed", "dynamic", "maintenance"])
            .optional()
            .describe("Force a mode. Usually inferred: prompt+interval=fixed, prompt-only=dynamic, neither=maintenance."),
          format: tool.schema.string().optional().describe("Output format: 'text' (default) or 'json'."),
        },
        async execute(args, context) {
          const format = normalizeFormat(args.format)
          const sessionId = context.sessionID
          if (!sessionId) {
            return errorResult(format, "No active session in tool context.")
          }

          // Mode inference (matches CC /loop semantics)
          let mode: LoopMode
          if (args.mode) {
            mode = args.mode
          } else if (args.prompt && args.interval) {
            mode = "fixed"
          } else if (args.prompt) {
            mode = "dynamic"
          } else {
            mode = "maintenance"
          }

          // Validate inputs per mode
          let schedule = ""
          let intervalMs: number | undefined
          if (mode === "fixed") {
            if (!args.interval) {
              return errorResult(format, "Fixed mode requires an interval (e.g. '5m' or '*/5 * * * *').")
            }
            const ms = parseInterval(args.interval)
            if (ms !== null) {
              if (ms < MIN_INTERVAL_MS) {
                return errorResult(format, `Interval too small: ${args.interval}. Minimum is 1 minute.`)
              }
              schedule = args.interval
              intervalMs = ms
            } else if (isCronExpression(args.interval)) {
              try {
                validateCron(args.interval)
              } catch (err) {
                return errorResult(format, err instanceof Error ? err.message : String(err))
              }
              schedule = args.interval
            } else {
              return errorResult(format, `Unrecognized interval: "${args.interval}". Use shorthand (5m, 2h, 1d) or 5-field cron.`)
            }
            // We're inside `mode === "fixed"`; if no prompt was supplied, the
            // user wants a maintenance loop on a fixed cadence (e.g. `/loop 15m`).
            if (!args.prompt) {
              mode = "maintenance"
            }
          }
          if (mode === "maintenance") {
            // Maintenance always uses dynamic cadence unless interval forced a fixed one
            if (!args.interval) {
              schedule = ""
            }
          }

          const prompt = args.prompt?.trim() || null
          if (mode !== "maintenance" && !prompt) {
            return errorResult(format, `${mode} mode requires a prompt.`)
          }

          // Enforce 50-job cap
          if (registry.count(sessionId) >= MAX_JOBS_PER_SESSION) {
            return errorResult(
              format,
              `Session already has ${MAX_JOBS_PER_SESSION} loops (the max). Stop one with loop_stop first.`
            )
          }

          // Build the job
          const id = randomId()
          const createdAt = Date.now()
          const expiresAt = createdAt + EXPIRY_MS
          const jitterMs = computeJitterMs(id, intervalMs)

          let nextFireAt: number
          if (mode === "fixed" && schedule) {
            nextFireAt = computeNextFire(schedule, createdAt) + jitterMs
          } else if (mode === "maintenance" && schedule) {
            nextFireAt = computeNextFire(schedule, createdAt) + jitterMs
          } else {
            // dynamic or maintenance-without-interval: fire soon (CC runs immediately on /loop)
            nextFireAt = createdAt + 1500
          }

          const job: LoopJob = {
            id,
            sessionId,
            workdir: context.worktree || sessionWorkdir,
            mode,
            prompt,
            schedule,
            intervalMs,
            nextFireAt,
            createdAt,
            expiresAt,
            fireCount: 0,
            jitterMs,
            awaitingReschedule: mode === "dynamic",
            fallbackUsed: false,
            firing: false,
            pendingFire: false,
          }

          registry.add(job)
          armJob(job)

          logLine(id, sessionId, `created mode=${mode} schedule="${schedule}"`)
          try {
            await sdk?.app?.log?.({
              body: {
                service: "loop",
                level: "info",
                message: `loop ${id} started (${mode})`,
                extra: { mode, schedule, sessionId },
              },
            })
          } catch { /* best-effort */ }

          return okResult(
            format,
            `Loop ${id} started.\n` +
              `  Mode:     ${mode}\n` +
              `  Schedule: ${describeSchedule(schedule, mode)}\n` +
              `  Prompt:   ${prompt === null ? "(maintenance)" : '"' + (prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt) + '"'}\n` +
              `  Next fire: ${new Date(nextFireAt).toISOString()}\n` +
              `  Expires:  ${new Date(expiresAt).toISOString()}\n` +
              (mode === "dynamic"
                ? `\nNote: dynamic mode — call loop_reschedule after each iteration with the delay you want.\n` +
                  `If you don't, one fallback wakeup fires in 20m; if that also doesn't reschedule, the loop stops.`
                : ""),
            { job: summarizeJob(job) }
          )
        },
      }),

      // -----------------------------------------------------
      // loop_list — list active loops
      // -----------------------------------------------------
      loop_list: tool({
        description: "List active loops in the current session (or all sessions).",
        args: {
          allSessions: tool.schema
            .boolean()
            .optional()
            .describe("If true, list loops across all sessions. Default: current session only."),
          format: tool.schema.string().optional().describe("Output format: 'text' or 'json'."),
        },
        async execute(args, context) {
          const format = normalizeFormat(args.format)
          const sessionId = context.sessionID
          const all = args.allSessions === true
          const jobs = all ? registry.list() : registry.list(sessionId)
          if (jobs.length === 0) {
            return okResult(format, all ? "No loops in any session." : "No loops in this session.", { jobs: [] })
          }
          const lines = jobs.map((j) => {
            const s = summarizeJob(j)
            return `${j.id}  ${j.mode.padEnd(11)} ${describeSchedule(j.schedule, j.mode).padEnd(30)} next=${s.nextFireAt} fired=${j.fireCount} state=${s.state}`
          })
          return okResult(format, `Active loops (${all ? "all sessions" : "this session"}):\n${lines.join("\n")}`, {
            jobs: jobs.map(summarizeJob),
          })
        },
      }),

      // -----------------------------------------------------
      // loop_stop — stop a loop by id (or all in session)
      // -----------------------------------------------------
      loop_stop: tool({
        description: "Stop a loop by id, or all loops in the current session.",
        args: {
          id: tool.schema.string().optional().describe("Loop id (8-char). Required unless all=true."),
          all: tool.schema.boolean().optional().describe("Stop all loops in the current session. Default false."),
          format: tool.schema.string().optional().describe("Output format: 'text' or 'json'."),
        },
        async execute(args, context) {
          const format = normalizeFormat(args.format)
          const sessionId = context.sessionID
          if (args.all === true) {
            const jobs = registry.list(sessionId)
            for (const j of jobs) registry.remove(j.id)
            return okResult(format, `Stopped ${jobs.length} loop(s) in this session.`, {
              stopped: jobs.map((j) => j.id),
            })
          }
          if (!args.id) {
            return errorResult(format, "Provide a loop id, or pass all=true to stop every loop in this session.")
          }
          const job = registry.get(args.id)
          if (!job) {
            return errorResult(format, `No loop with id "${args.id}".`)
          }
          registry.remove(args.id)
          logLine(args.id, job.sessionId, "stopped via loop_stop")
          return okResult(format, `Stopped loop ${args.id}.`, { stopped: args.id })
        },
      }),

      // -----------------------------------------------------
      // loop_reschedule — dynamic mode: agent picks next delay
      // -----------------------------------------------------
      loop_reschedule: tool({
        description:
          "In dynamic mode, set the delay until the next iteration. Call this near the end of each iteration " +
          "with a delay based on what you observed (1-60 minutes). " +
          "If you omit this, one 20-minute fallback fires; if that also doesn't reschedule, the loop stops. " +
          "Pass stop=true to end the loop instead (equivalent to loop_stop).",
        args: {
          id: tool.schema.string().describe("Loop id (8-char)."),
          delayMinutes: tool.schema
            .number()
            .optional()
            .describe("Minutes until the next iteration. Range: 1-60. Omit only with stop=true."),
          stop: tool.schema.boolean().optional().describe("If true, stop the loop entirely. Default false."),
          reason: tool.schema
            .string()
            .optional()
            .describe("Optional one-line reason, included in logs. Use it to record why you picked this delay."),
          format: tool.schema.string().optional().describe("Output format: 'text' or 'json'."),
        },
        async execute(args) {
          const format = normalizeFormat(args.format)
          const job = registry.get(args.id)
          if (!job) {
            return errorResult(format, `No loop with id "${args.id}".`)
          }
          if (job.mode !== "dynamic") {
            return errorResult(format, `Loop ${args.id} is mode=${job.mode}, not dynamic. loop_reschedule only applies to dynamic loops.`)
          }
          if (args.stop === true) {
            registry.remove(args.id)
            logLine(args.id, job.sessionId, `dynamic: stopped via loop_reschedule (${args.reason || "no reason"})`)
            return okResult(format, `Stopped loop ${args.id}.`, { stopped: args.id })
          }
          const mins = args.delayMinutes
          if (typeof mins !== "number" || !Number.isFinite(mins)) {
            return errorResult(format, "delayMinutes is required (1-60) unless stop=true.")
          }
          if (mins < MIN_DYNAMIC_DELAY_MS / 60_000 || mins > MAX_DYNAMIC_DELAY_MS / 60_000) {
            return errorResult(format, `delayMinutes out of range: ${mins}. Allowed: 1-60.`)
          }
          const nextFireAt = Date.now() + mins * 60_000
          job.nextFireAt = nextFireAt
          job.awaitingReschedule = false
          job.fallbackUsed = false
          armJob(job)
          registry.flagDirty(job.sessionId)
          logLine(args.id, job.sessionId, `dynamic: rescheduled in ${mins}m (${args.reason || "no reason"})`)
          return okResult(
            format,
            `Loop ${args.id} rescheduled. Next fire: ${new Date(nextFireAt).toISOString()} (in ${mins}m).`,
            { nextFireAt }
          )
        },
      }),

      // -----------------------------------------------------
      // loop_status — show detailed status
      // -----------------------------------------------------
      loop_status: tool({
        description: "Show status of all loops in the current session, or one loop by id.",
        args: {
          id: tool.schema.string().optional().describe("Loop id. Omit for all loops in the session."),
          format: tool.schema.string().optional().describe("Output format: 'text' or 'json'."),
        },
        async execute(args, context) {
          const format = normalizeFormat(args.format)
          const sessionId = context.sessionID
          if (args.id) {
            const job = registry.get(args.id)
            if (!job) return errorResult(format, `No loop with id "${args.id}".`)
            return okResult(format, JSON.stringify(summarizeJob(job), null, 2), summarizeJob(job))
          }
          const jobs = registry.list(sessionId)
          if (jobs.length === 0) return okResult(format, "No loops in this session.", { jobs: [] })
          return okResult(
            format,
            `Loops in this session (${jobs.length}):\n` +
              jobs.map((j) => `  ${JSON.stringify(summarizeJob(j))}`).join("\n"),
            { jobs: jobs.map(summarizeJob) }
          )
        },
      }),

      // -----------------------------------------------------
      // install_skill — write the loop-best-practices SKILL.md
      // -----------------------------------------------------
      install_skill: tool({
        description: "Install the loop-best-practices skill into the current project so agents reference it in /loop prompts.",
        args: {
          overwrite: tool.schema.boolean().optional().describe("Overwrite if exists. Default false."),
          format: tool.schema.string().optional().describe("Output format: 'text' or 'json'."),
        },
        async execute(args, context) {
          const format = normalizeFormat(args.format)
          const workdir = context.worktree || sessionWorkdir
          const skillDir = join(workdir, ".opencode", "skills", "loop-best-practices")
          const skillPath = join(skillDir, "SKILL.md")
          ensureDir(skillDir)
          if (existsSync(skillPath) && !args.overwrite) {
            return errorResult(format, `Already exists: ${skillPath} (pass overwrite=true to replace).`)
          }
          writeFileSync(skillPath, LOOP_BEST_PRACTICES_SKILL.trimEnd() + "\n")
          return okResult(format, `Installed skill at ${skillPath}`, { path: skillPath })
        },
      }),
    },
  }
}) as Plugin

export default LoopPlugin
