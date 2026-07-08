/** Deterministic per-job jitter (matches Claude Code semantics). */

import { fnv1a32 } from "../shared/util"

export const MAX_JITTER_MS = 30 * 60 * 1000 // 30 minutes (CC jitter cap)

/** Deterministic offset from the job id; capped at 30 min or half the interval. */
export function computeJitterMs(jobId: string, intervalMs?: number): number {
  const max = intervalMs && intervalMs < 2 * MAX_JITTER_MS ? Math.floor(intervalMs / 2) : MAX_JITTER_MS
  return fnv1a32(jobId) % Math.max(max, 1)
}
