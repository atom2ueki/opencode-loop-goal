/**
 * opencode-loop-goal — combined plugin entry.
 *
 * Composes the loop and goal features into a single Plugin export. Each
 * feature is a factory returning { hooks, tools }; this module merges them.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { createLoopFeature } from "./loop"
import { createGoalFeature } from "./goal"

const CombinedPlugin: Plugin = async (input, options = {}) => {
  const loop = createLoopFeature(input)
  const goalOpts = (options as { goal?: Record<string, unknown> }).goal ?? {}
  const goal = createGoalFeature(input, goalOpts)

  return {
    ...loop.hooks,
    ...goal.hooks,
    tool: {
      ...loop.tools,
      ...goal.tools,
    },
  }
}

export default CombinedPlugin
