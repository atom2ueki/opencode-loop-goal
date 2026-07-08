/**
 * Loop feature: session-scoped scheduled prompt injection.
 *
 * Factory `createLoopFeature(input)` returns the hooks + tools that the
 * combined plugin composes. Fire logic is identical to the original
 * single-file plugin; only the transport (now the shared v2->v1->HTTP
 * adapter) and tool return shape (now objects) changed.
 */

import type { Hooks, PluginInput, ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { existsSync, writeFileSync } from "fs"
import { appendFileSync } from "fs"
import { join } from "path"
import { err, ok } from "../shared/result"
import { LOGS_DIR } from "../shared/paths"
import { ensureDir, nowIso, randomId } from "../shared/util"
import { resolveSessionApi, type PromptBody } from "../shared/transport"
import {
  computeNextFire,
  describeSchedule,
  isCronExpression,
  parseInterval,
  validateCron,
  MIN_INTERVAL_MS,
} from "./cron"
import { computeJitterMs } from "./jitter"
import {
  DEFAULT_DYNAMIC_DELAY_MS,
  EXPIRY_MS,
  FALLBACK_WAKEUP_MS,
  LoopRegistry,
  MAX_DYNAMIC_DELAY_MS,
  MAX_JOBS_PER_SESSION,
  MIN_DYNAMIC_DELAY_MS,
} from "./registry"
import { resolveMaintenancePrompt } from "./maintenance"
import { LOOP_BEST_PRACTICES_SKILL } from "./skill"
import { type LoopJob, type LoopMode } from "./types"

export interface LoopFeature {
  hooks: Partial<Hooks>
  tools: Record<string, ToolDefinition>
}

function logLine(jobId: string, sessionId: string, message: string): void {
  ensureDir(LOGS_DIR)
  const path = join(LOGS_DIR, `${sessionId}-${jobId}.log`)
  const line = `[${nowIso()}] ${message}\n`
  try {
    appendFileSync(path, line)
  } catch {
    /* best-effort */
  }
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

export function createLoopFeature(input: PluginInput): LoopFeature {
  const sessionApi = resolveSessionApi(input)
  const registry = new LoopRegistry()
  const sessionWorkdir = (input.worktree || input.directory || process.cwd()) as string

  // Loose client access for the optional tui/app surfaces.
  const sdk = input.client as {
    tui?: { showToast?: (a: { body: { title?: string; message: string; variant?: string } }) => Promise<unknown> }
    app?: { log?: (a: { body: { service: string; level: string; message: string; extra?: Record<string, unknown> } }) => Promise<unknown> }
  }

  // ----- fire path -----

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

    const body: PromptBody = { parts: [{ type: "text", text: tagged }] }
    try {
      await sessionApi.prompt(job.sessionId, body)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logLine(job.id, job.sessionId, `fire failed: ${msg}`)
      try {
        await sdk.tui?.showToast?.({ body: { title: `loop ${job.id}`, message: `fire failed: ${msg}`, variant: "error" } })
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
      const base = Date.now() + 15 * 60_000
      job.nextFireAt = base + job.jitterMs
      armJob(job)
    } else if (job.mode === "dynamic") {
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
      armJob(job)
      return
    }
    // sessionApi existence is guaranteed by resolveSessionApi; treat "idle or
    // no transport signal" as fireable. The registry tracks busy sessions.
    if (registry.isIdle(job.sessionId)) {
      await fireJob(job)
    } else {
      job.pendingFire = true
      registry.flagDirty(job.sessionId)
      logLine(job.id, job.sessionId, "deferring fire: session busy")
    }
  }

  // ----- event handling -----

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
      const loaded = registry.loadSession(sessionId)
      if (loaded > 0) {
        for (const job of registry.list(sessionId)) {
          if (job.mode === "dynamic" && job.awaitingReschedule && !job.fallbackUsed) continue
          armJob(job)
        }
        try {
          await sdk.app?.log?.({ body: { service: "loop", level: "info", message: `restored ${loaded} loop(s) for session ${sessionId}` } })
        } catch { /* best-effort */ }
      }
      return
    }

    if (event.type === "session.idle" && sessionId) {
      registry.setIdle(sessionId, true)
      debugEvents(`marked idle=true for ${sessionId}`)
      const pending = registry.list(sessionId).filter((j) => j.pendingFire && !j.firing)
      for (const job of pending) void fireJob(job)
      return
    }

    if ((event.type === "session.updated" || event.type === "message.updated") && sessionId) {
      // These fire many times per turn; rely on session.status instead.
      return
    }

    if (event.type === "session.status" && sessionId) {
      const status = props.status as { type?: string } | undefined
      if (status?.type === "busy") {
        registry.setIdle(sessionId, false)
        debugEvents(`marked idle=false for ${sessionId} (status=busy)`)
      } else if (status?.type === "idle") {
        registry.setIdle(sessionId, true)
        debugEvents(`marked idle=true for ${sessionId} (status=idle)`)
        const pending = registry.list(sessionId).filter((j) => j.pendingFire && !j.firing)
        for (const job of pending) void fireJob(job)
      }
      return
    }

    if (event.type === "session.deleted" && sessionId) {
      registry.clearSession(sessionId)
      return
    }
  }

  // ----- hooks -----

  const hooks: Partial<Hooks> = {
    event: async ({ event }) => {
      await onEvent(event as { type: string; properties?: Record<string, unknown> })
    },
    "experimental.session.compacting": async (i, output) => {
      const sessionId = i.sessionID
      const jobs = registry.list(sessionId)
      if (jobs.length === 0) return
      const summary = jobs
        .map((j) => `- loop ${j.id} (${j.mode}, ${describeSchedule(j.schedule, j.mode)}), fired ${j.fireCount}x, next: ${new Date(j.nextFireAt).toISOString()}`)
        .join("\n")
      output.context.push(`## Active loops in this session\n${summary}\n\nIf the user asks about loops, use loop_list / loop_status.`)
    },
  }

  // ----- tools -----

  const tools: Record<string, ToolDefinition> = {
    loop_start: tool({
      description:
        "Start a session-scoped loop that injects a prompt into the current session on a schedule. " +
        "Three modes: (1) fixed interval — pass both interval and prompt; " +
        "(2) dynamic — pass only prompt, the agent reschedules each iteration via loop_reschedule; " +
        "(3) maintenance — pass neither, runs the built-in maintenance prompt (or loop.md override). " +
        "Loops fire only while the session is idle and die with the session (restored on --resume). " +
        "Max 50 per session. Auto-expire after 7 days.",
      args: {
        prompt: tool.schema.string().optional().describe("Prompt text to run each iteration. Omit for the built-in maintenance prompt."),
        interval: tool.schema.string().optional().describe('Shorthand (5m, 30s, 2h, 1d) or 5-field cron (*\\/5 * * * *). Omit for dynamic mode.'),
        mode: tool.schema.enum(["fixed", "dynamic", "maintenance"]).optional().describe("Force a mode. Usually inferred: prompt+interval=fixed, prompt-only=dynamic, neither=maintenance."),
        format: tool.schema.string().optional().describe("Output format: 'text' (default) or 'json'."),
      },
      async execute(args, context) {
        const sessionId = context.sessionID
        if (!sessionId) return err("No active session in tool context.")

        let mode: LoopMode
        if (args.mode) mode = args.mode
        else if (args.prompt && args.interval) mode = "fixed"
        else if (args.prompt) mode = "dynamic"
        else mode = "maintenance"

        let schedule = ""
        let intervalMs: number | undefined
        if (mode === "fixed") {
          if (!args.interval) return err("Fixed mode requires an interval (e.g. '5m' or '*/5 * * * *').")
          const ms = parseInterval(args.interval)
          if (ms !== null) {
            if (ms < MIN_INTERVAL_MS) return err(`Interval too small: ${args.interval}. Minimum is 1 minute.`)
            schedule = args.interval
            intervalMs = ms
          } else if (isCronExpression(args.interval)) {
            try {
              validateCron(args.interval)
            } catch (e) {
              return err(e instanceof Error ? e.message : String(e))
            }
            schedule = args.interval
          } else {
            return err(`Unrecognized interval: "${args.interval}". Use shorthand (5m, 2h, 1d) or 5-field cron.`)
          }
          if (!args.prompt) mode = "maintenance"
        }
        if (mode === "maintenance") {
          if (!args.interval) schedule = ""
        }

        const prompt = args.prompt?.trim() || null
        if (mode !== "maintenance" && !prompt) return err(`${mode} mode requires a prompt.`)

        if (registry.count(sessionId) >= MAX_JOBS_PER_SESSION) {
          return err(`Session already has ${MAX_JOBS_PER_SESSION} loops (the max). Stop one with loop_stop first.`)
        }

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
          await sdk.app?.log?.({ body: { service: "loop", level: "info", message: `loop ${id} started (${mode})`, extra: { mode, schedule, sessionId } } })
        } catch { /* best-effort */ }

        return ok(
          `Loop ${id} started.\n` +
            `  Mode:     ${mode}\n` +
            `  Schedule: ${describeSchedule(schedule, mode)}\n` +
            `  Prompt:   ${prompt === null ? "(maintenance)" : '"' + (prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt) + '"'}\n` +
            `  Next fire: ${new Date(nextFireAt).toISOString()}\n` +
            `  Expires:  ${new Date(expiresAt).toISOString()}` +
            (mode === "dynamic"
              ? `\n\nNote: dynamic mode — call loop_reschedule after each iteration with the delay you want.\n` +
                `If you don't, one fallback wakeup fires in 20m; if that also doesn't reschedule, the loop stops.`
              : ""),
          { title: `Loop ${id} started`, metadata: { job: summarizeJob(job) } },
        )
      },
    }),

    loop_list: tool({
      description: "List active loops in the current session (or all sessions).",
      args: {
        allSessions: tool.schema.boolean().optional().describe("If true, list loops across all sessions. Default: current session only."),
        format: tool.schema.string().optional().describe("Output format: 'text' or 'json'."),
      },
      async execute(args, context) {
        const sessionId = context.sessionID
        const all = args.allSessions === true
        const jobs = all ? registry.list() : registry.list(sessionId)
        if (jobs.length === 0) {
          return ok(all ? "No loops in any session." : "No loops in this session.", { metadata: { jobs: [] } })
        }
        const lines = jobs.map((j) => {
          const s = summarizeJob(j)
          return `${j.id}  ${j.mode.padEnd(11)} ${describeSchedule(j.schedule, j.mode).padEnd(30)} next=${s.nextFireAt} fired=${j.fireCount} state=${s.state}`
        })
        return ok(`Active loops (${all ? "all sessions" : "this session"}):\n${lines.join("\n")}`, {
          metadata: { jobs: jobs.map(summarizeJob) },
        })
      },
    }),

    loop_stop: tool({
      description: "Stop a loop by id, or all loops in the current session.",
      args: {
        id: tool.schema.string().optional().describe("Loop id (8-char). Required unless all=true."),
        all: tool.schema.boolean().optional().describe("Stop all loops in the current session. Default false."),
        format: tool.schema.string().optional().describe("Output format: 'text' or 'json'."),
      },
      async execute(args, context) {
        const sessionId = context.sessionID
        if (args.all === true) {
          const jobs = registry.list(sessionId)
          for (const j of jobs) registry.remove(j.id)
          return ok(`Stopped ${jobs.length} loop(s) in this session.`, { metadata: { stopped: jobs.map((j) => j.id) } })
        }
        if (!args.id) return err("Provide a loop id, or pass all=true to stop every loop in this session.")
        const job = registry.get(args.id)
        if (!job) return err(`No loop with id "${args.id}".`)
        registry.remove(args.id)
        logLine(args.id, job.sessionId, "stopped via loop_stop")
        return ok(`Stopped loop ${args.id}.`, { metadata: { stopped: args.id } })
      },
    }),

    loop_reschedule: tool({
      description:
        "In dynamic mode, set the delay until the next iteration. Call this near the end of each iteration " +
        "with a delay based on what you observed (1-60 minutes). " +
        "If you omit this, one 20-minute fallback fires; if that also doesn't reschedule, the loop stops. " +
        "Pass stop=true to end the loop instead (equivalent to loop_stop).",
      args: {
        id: tool.schema.string().describe("Loop id (8-char)."),
        delayMinutes: tool.schema.number().optional().describe("Minutes until the next iteration. Range: 1-60. Omit only with stop=true."),
        stop: tool.schema.boolean().optional().describe("If true, stop the loop entirely. Default false."),
        reason: tool.schema.string().optional().describe("Optional one-line reason, included in logs. Use it to record why you picked this delay."),
        format: tool.schema.string().optional().describe("Output format: 'text' or 'json'."),
      },
      async execute(args) {
        const job = registry.get(args.id)
        if (!job) return err(`No loop with id "${args.id}".`)
        if (job.mode !== "dynamic") {
          return err(`Loop ${args.id} is mode=${job.mode}, not dynamic. loop_reschedule only applies to dynamic loops.`)
        }
        if (args.stop === true) {
          registry.remove(args.id)
          logLine(args.id, job.sessionId, `dynamic: stopped via loop_reschedule (${args.reason || "no reason"})`)
          return ok(`Stopped loop ${args.id}.`, { metadata: { stopped: args.id } })
        }
        const mins = args.delayMinutes
        if (typeof mins !== "number" || !Number.isFinite(mins)) {
          return err("delayMinutes is required (1-60) unless stop=true.")
        }
        if (mins < MIN_DYNAMIC_DELAY_MS / 60_000 || mins > MAX_DYNAMIC_DELAY_MS / 60_000) {
          return err(`delayMinutes out of range: ${mins}. Allowed: 1-60.`)
        }
        const nextFireAt = Date.now() + mins * 60_000
        job.nextFireAt = nextFireAt
        job.awaitingReschedule = false
        job.fallbackUsed = false
        armJob(job)
        registry.flagDirty(job.sessionId)
        logLine(args.id, job.sessionId, `dynamic: rescheduled in ${mins}m (${args.reason || "no reason"})`)
        return ok(`Loop ${args.id} rescheduled. Next fire: ${new Date(nextFireAt).toISOString()} (in ${mins}m).`, {
          metadata: { nextFireAt },
        })
      },
    }),

    loop_status: tool({
      description: "Show status of all loops in the current session, or one loop by id.",
      args: {
        id: tool.schema.string().optional().describe("Loop id. Omit for all loops in the session."),
        format: tool.schema.string().optional().describe("Output format: 'text' or 'json'."),
      },
      async execute(args, context) {
        const sessionId = context.sessionID
        if (args.id) {
          const job = registry.get(args.id)
          if (!job) return err(`No loop with id "${args.id}".`)
          return ok(JSON.stringify(summarizeJob(job), null, 2), { metadata: summarizeJob(job) })
        }
        const jobs = registry.list(sessionId)
        if (jobs.length === 0) return ok("No loops in this session.", { metadata: { jobs: [] } })
        return ok(
          `Loops in this session (${jobs.length}):\n` + jobs.map((j) => `  ${JSON.stringify(summarizeJob(j))}`).join("\n"),
          { metadata: { jobs: jobs.map(summarizeJob) } },
        )
      },
    }),

    install_skill: tool({
      description: "Install the loop-best-practices skill into the current project so agents reference it in /loop prompts.",
      args: {
        overwrite: tool.schema.boolean().optional().describe("Overwrite if exists. Default false."),
        format: tool.schema.string().optional().describe("Output format: 'text' or 'json'."),
      },
      async execute(args, context) {
        const workdir = context.worktree || sessionWorkdir
        const skillDir = join(workdir, ".opencode", "skills", "loop-best-practices")
        const skillPath = join(skillDir, "SKILL.md")
        ensureDir(skillDir)
        if (existsSync(skillPath) && !args.overwrite) {
          return err(`Already exists: ${skillPath} (pass overwrite=true to replace).`)
        }
        writeFileSync(skillPath, LOOP_BEST_PRACTICES_SKILL.trimEnd() + "\n")
        return ok(`Installed skill at ${skillPath}`, { metadata: { path: skillPath } })
      },
    }),
  }

  return { hooks, tools }
}
