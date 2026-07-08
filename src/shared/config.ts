/**
 * Generic config resolver: defaults < ENV < plugin options.
 *
 * Shared by goal (prefix GOAL_MODE_) so camelCase keys map to
 * GOAL_MODE_SNAPE_CASE env vars, mirroring how opencode-scheduler / loop-style
 * configs are resolved. Loop currently takes no config, but if it grows knobs
 * they'd use OPENCODE_LOOP_* the same way.
 */

export type ConfigSpec<T extends string> = {
  key: T
  kind: "boolean" | "int" | "string"
}

/** camelCase -> SNAKE_UPPER with the given prefix (maxTurns, GOAL_MODE_ -> GOAL_MODE_MAX_TURNS). */
export function envKey(prefix: string, key: string): string {
  const snake = key.replace(/([A-Z])/g, "_$1").toUpperCase()
  return `${prefix}${snake}`
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  const s = String(value ?? "").trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(s)) return true
  if (["0", "false", "no", "off"].includes(s)) return false
  return fallback
}

function parseInt10(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

export function resolveConfig<T extends string>(
  defaults: Record<T, unknown>,
  specs: ConfigSpec<T>[],
  opts: {
    prefix: string
    options?: Record<string, unknown>
    env?: NodeJS.ProcessEnv
  }
): Record<T, unknown> {
  const env = opts.env ?? process.env
  const options = opts.options ?? {}
  const config: Record<T, unknown> = { ...defaults }
  const kindOf = new Map<T, ConfigSpec<T>["kind"]>(specs.map((s) => [s.key, s.kind]))

  const apply = (key: T, value: unknown): void => {
    if (value === undefined || value === null) return
    const kind = kindOf.get(key) ?? "string"
    if (kind === "boolean") config[key] = parseBool(value, Boolean(config[key]))
    else if (kind === "int") config[key] = parseInt10(value, Number(config[key]))
    else config[key] = String(value).trim()
  }

  for (const key of Object.keys(defaults) as T[]) {
    const envValue = env?.[envKey(opts.prefix, key)]
    if (envValue !== undefined) apply(key, envValue)
  }
  for (const key of Object.keys(defaults) as T[]) {
    if (Object.prototype.hasOwnProperty.call(options, key)) apply(key, options[key])
  }
  return config
}

/** Parse "providerID/modelID" into a ModelRef, or null when unset/invalid. */
export function parseModelRef(spec: unknown): { providerID: string; modelID: string } | null {
  const s = String(spec ?? "").trim()
  if (!s) return null
  const slash = s.indexOf("/")
  if (slash <= 0 || slash === s.length - 1) return null
  return { providerID: s.slice(0, slash), modelID: s.slice(slash + 1) }
}
