/** LoopJob model + persistence shape. */

export type LoopMode = "fixed" | "dynamic" | "maintenance"

export interface LoopJob {
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

/** On-disk shape — omits runtime-only fields (timer, mutex flags). */
export interface PersistedJob {
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

export function toPersisted(job: LoopJob): PersistedJob {
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

export function fromPersisted(p: PersistedJob): LoopJob {
  return { ...p, firing: false, pendingFire: false }
}
