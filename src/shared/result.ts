/**
 * Unified tool-return builders. Both loop and goal tools return the object
 * variant of ToolResult ({ title?, output, metadata? }) for richer TUI
 * rendering (titles + structured metadata).
 */

import type { ToolResult } from "@opencode-ai/plugin"

export type { ToolResult }

export interface ResultOpts {
  title?: string
  metadata?: Record<string, unknown>
}

/** Success result. `metadata.ok` defaults to true. */
export function ok(output: string, opts: ResultOpts = {}): ToolResult {
  return {
    output,
    ...(opts.title ? { title: opts.title } : {}),
    metadata: { ok: true, ...(opts.metadata ?? {}) },
  }
}

/** Error result. `metadata.ok` is false so callers/evaluators can branch on it. */
export function err(output: string, opts: ResultOpts = {}): ToolResult {
  return {
    output,
    ...(opts.title ? { title: opts.title } : {}),
    metadata: { ok: false, ...(opts.metadata ?? {}) },
  }
}
