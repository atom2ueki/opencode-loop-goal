/**
 * Interval + cron parsing (shorthand like "5m" and 5-field cron) and fire-time
 * computation. Pure logic — safe to unit test directly.
 */

const SHORTHAND_RE = /^(\d+)([smhd])$/

export const MIN_INTERVAL_MS = 60 * 1000 // 1 minute (cron granularity)

/** Parse a shorthand interval ("5m", "30s", "2h", "1d") into milliseconds. */
export function parseInterval(input: string): number | null {
  const trimmed = input.trim()
  const m = SHORTHAND_RE.exec(trimmed)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2]
  return unit === "s" ? n * 1000
    : unit === "m" ? n * 60_000
    : unit === "h" ? n * 3_600_000
    : unit === "d" ? n * 86_400_000
    : null
}

export function isCronExpression(input: string): boolean {
  return input.trim().split(/\s+/).length === 5
}

function parseCronNumber(
  value: string,
  min: number,
  max: number,
  label: string,
  allowSundaySeven: boolean,
): number {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid cron ${label} value: ${value}`)
  const normalized = allowSundaySeven && parsed === 7 ? 0 : parsed
  if (normalized < min || normalized > max) throw new Error(`Invalid cron ${label} value: ${value}`)
  return normalized
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  label: string,
  allowSundaySeven = false,
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

export function validateCron(cron: string): void {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`Invalid cron (need 5 fields): ${cron}`)
  parseCronField(parts[0], 0, 59, "minute")
  parseCronField(parts[1], 0, 23, "hour")
  parseCronField(parts[2], 1, 31, "day of month")
  parseCronField(parts[3], 1, 12, "month")
  parseCronField(parts[4], 0, 7, "day of week", true)
}

function range(lo: number, hi: number): number[] {
  const out: number[] = []
  for (let v = lo; v <= hi; v++) out.push(v)
  return out
}

/**
 * Compute the next time (epoch ms) at or after `after` that matches the cron
 * expression. Brute-force scan in 1-minute steps — cheap for our 7-day horizon
 * and avoids vixie-cron reimplementation bugs.
 */
export function nextCronTime(cron: string, after: Date = new Date()): number {
  validateCron(cron)
  const [mField, hField, domField, monField, dowField] = cron.trim().split(/\s+/)
  const minutes = parseCronField(mField, 0, 59, "minute") ?? range(0, 59)
  const hours = parseCronField(hField, 0, 23, "hour") ?? range(0, 23)
  const doms = parseCronField(domField, 1, 31, "day of month") ?? null
  const mons = parseCronField(monField, 1, 12, "month") ?? null
  const dows = parseCronField(dowField, 0, 7, "day of week", true) ?? null

  const start = new Date(after)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  const cap = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000)

  for (let t = start; t <= cap; t.setMinutes(t.getMinutes() + 1)) {
    const m = t.getMinutes()
    const h = t.getHours()
    const dom = t.getDate()
    const mon = t.getMonth() + 1
    const dow = t.getDay()

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

/** Convert a schedule (shorthand or cron) to the next-fire epoch ms from `fromMs`. */
export function computeNextFire(schedule: string, fromMs: number = Date.now()): number {
  const ms = parseInterval(schedule)
  if (ms !== null) {
    return fromMs + Math.max(ms, MIN_INTERVAL_MS)
  }
  if (isCronExpression(schedule)) {
    return nextCronTime(schedule, new Date(fromMs))
  }
  throw new Error(`Unrecognized schedule: "${schedule}". Use shorthand (5m, 2h) or 5-field cron.`)
}

/** Human-readable schedule label ("every 5 minutes", "every 2 hours", "cron: ..."). */
export function describeSchedule(schedule: string, mode: "fixed" | "dynamic" | "maintenance"): string {
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
