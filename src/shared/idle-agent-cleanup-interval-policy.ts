export const IDLE_AGENT_CLEANUP_INTERVAL_MS_MIN = 60_000
export const IDLE_AGENT_CLEANUP_INTERVAL_MS_DEFAULT = 300_000

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Clamps a renderer-supplied interval so a tiny/negative/NaN value can't drive the scheduler into a tight loop. */
export function normalizeIdleAgentCleanupIntervalMs(value: unknown): number {
  if (!isFiniteNumber(value)) {
    return IDLE_AGENT_CLEANUP_INTERVAL_MS_DEFAULT
  }
  return Math.max(IDLE_AGENT_CLEANUP_INTERVAL_MS_MIN, Math.floor(value))
}
