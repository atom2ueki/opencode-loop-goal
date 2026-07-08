/**
 * On-disk locations for loop + goal state and logs.
 *
 *   ~/.config/opencode/loops/<session>.json   — persisted loop jobs
 *   ~/.config/opencode/goals/<session>.json   — persisted goal state
 *   ~/.config/opencode/logs/loop/*.log        — per-job fire logs + event log
 */

import { join } from "path"
import { OPENCODE_CONFIG } from "./util"

export const LOOPS_DIR = join(OPENCODE_CONFIG, "loops")
export const GOALS_DIR = join(OPENCODE_CONFIG, "goals")
export const LOGS_DIR = join(OPENCODE_CONFIG, "logs", "loop")

export function sessionStatePath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.json`)
}
