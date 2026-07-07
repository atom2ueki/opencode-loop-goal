import { expect, test, describe } from "bun:test"

// We test the pure logic by re-implementing the same exports the plugin uses
// internally. The plugin file itself doesn't export these, so for a real
// package you'd factor them into a separate module. This is a smoke test
// that the math is sound.

// Re-implemented here for testing — keep in sync with src/index.ts
function parseInterval(input: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(input.trim())
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

function isCronExpression(input: string): boolean {
  return input.trim().split(/\s+/).length === 5
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function computeJitterMs(jobId: string, intervalMs?: number): number {
  const MAX_JITTER_MS = 30 * 60 * 1000
  const max = intervalMs && intervalMs < 2 * MAX_JITTER_MS ? Math.floor(intervalMs / 2) : MAX_JITTER_MS
  return fnv1a32(jobId) % Math.max(max, 1)
}

describe("parseInterval", () => {
  test("parses seconds", () => {
    expect(parseInterval("30s")).toBe(30_000)
    expect(parseInterval("1s")).toBe(1000)
  })
  test("parses minutes", () => {
    expect(parseInterval("5m")).toBe(300_000)
    expect(parseInterval("1m")).toBe(60_000)
  })
  test("parses hours and days", () => {
    expect(parseInterval("2h")).toBe(7_200_000)
    expect(parseInterval("1d")).toBe(86_400_000)
  })
  test("rejects invalid input", () => {
    expect(parseInterval("5x")).toBeNull()
    expect(parseInterval("abc")).toBeNull()
    expect(parseInterval("0m")).toBeNull()
    expect(parseInterval("-5m")).toBeNull()
    expect(parseInterval("*/5 * * * *")).toBeNull()
  })
  test("is not confused with cron", () => {
    expect(parseInterval("*/5 * * * *")).toBeNull()
  })
})

describe("isCronExpression", () => {
  test("detects 5-field cron", () => {
    expect(isCronExpression("*/5 * * * *")).toBe(true)
    expect(isCronExpression("0 9 * * 1-5")).toBe(true)
    expect(isCronExpression("30 14 15 3 *")).toBe(true)
  })
  test("rejects non-cron", () => {
    expect(isCronExpression("5m")).toBe(false)
    expect(isCronExpression("hello world")).toBe(false)
    expect(isCronExpression("0 9 * *")).toBe(false) // 4 fields
  })
})

describe("computeJitterMs", () => {
  test("is deterministic per id", () => {
    const a = computeJitterMs("abc12345")
    const b = computeJitterMs("abc12345")
    expect(a).toBe(b)
  })
  test("different ids get different jitter (usually)", () => {
    const ids = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee"]
    const jitters = ids.map((id) => computeJitterMs(id))
    const unique = new Set(jitters)
    expect(unique.size).toBeGreaterThan(1)
  })
  test("caps at 30 min for long intervals", () => {
    const j = computeJitterMs("anyid", 60 * 60 * 1000) // 1h interval
    expect(j).toBeLessThanOrEqual(30 * 60 * 1000)
  })
  test("caps at half-interval for short intervals", () => {
    const j = computeJitterMs("anyid", 5 * 60 * 1000) // 5 min interval
    expect(j).toBeLessThanOrEqual(2.5 * 60 * 1000)
  })
  test("is non-negative", () => {
    for (let i = 0; i < 100; i++) {
      const id = Math.random().toString(36).slice(2, 10)
      expect(computeJitterMs(id)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe("fnv1a32", () => {
  test("produces stable 32-bit hashes", () => {
    expect(fnv1a32("hello")).toBe(fnv1a32("hello"))
    expect(fnv1a32("hello")).toBeLessThan(2 ** 32)
  })
})
