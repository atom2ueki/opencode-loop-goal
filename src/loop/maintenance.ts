/** Built-in maintenance prompt + loop.md override loader. */

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { OPENCODE_CONFIG } from "../shared/util"

export const BUILTIN_MAINTENANCE_PROMPT = `Continue any unfinished work from the conversation. Then tend to the current branch's pull request if there is one: check CI status and any new review comments; address them or report what you found. If nothing is pending, run a small cleanup pass (bug hunt, simplification, dead-code removal) only if it is low-risk. Otherwise say so in one line.

Do not start new initiatives outside that scope. Irreversible actions (push, force-push, delete, merge, deploy) only proceed when they continue something the transcript already authorized.`

/**
 * Resolve the maintenance prompt. Priority:
 *   1. <workdir>/.opencode/loop.md
 *   2. ~/.config/opencode/loop.md
 *   3. built-in BUILTIN_MAINTENANCE_PROMPT
 */
export function resolveMaintenancePrompt(workdir: string): string {
  const candidates = [
    join(workdir, ".opencode", "loop.md"),
    join(OPENCODE_CONFIG, "loop.md"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8").trim()
        if (content) return content
      } catch {
        /* fall through */
      }
    }
  }
  return BUILTIN_MAINTENANCE_PROMPT
}
