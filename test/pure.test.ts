import { expect, test, describe } from "bun:test"
import { computeJitterMs } from "../src/loop/jitter"
import { isCronExpression, parseInterval } from "../src/loop/cron"
import { fnv1a32 } from "../src/shared/util"

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
    expect(computeJitterMs("abc12345")).toBe(computeJitterMs("abc12345"))
  })
  test("different ids get different jitter (usually)", () => {
    const ids = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee"]
    const unique = new Set(ids.map((id) => computeJitterMs(id)))
    expect(unique.size).toBeGreaterThan(1)
  })
  test("caps at 30 min for long intervals", () => {
    expect(computeJitterMs("anyid", 60 * 60 * 1000)).toBeLessThanOrEqual(30 * 60 * 1000)
  })
  test("caps at half-interval for short intervals", () => {
    expect(computeJitterMs("anyid", 5 * 60 * 1000)).toBeLessThanOrEqual(2.5 * 60 * 1000)
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
