export const IDLE_AGENT_CLEANUP_INTERVAL_MS_MIN = 60_000
export const IDLE_AGENT_CLEANUP_INTERVAL_MS_DEFAULT = 300_000
// Matches the renderer's largest interval option (IdleAgentCleanupSection.tsx).
// Also the single source of truth pane-close-descendant-retention.ts derives
// its retention grace period from, so a closed pane's tracked descendants
// can never be evicted before a tick slow enough to use this interval gets a
// chance to see them.
export const IDLE_AGENT_CLEANUP_INTERVAL_MS_MAX = 1_800_000

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Clamps a renderer-supplied interval so a tiny/negative/NaN/huge value can't drive the scheduler into a tight loop or outlive its own retention grace. */
export function normalizeIdleAgentCleanupIntervalMs(value: unknown): number {
  if (!isFiniteNumber(value)) {
    return IDLE_AGENT_CLEANUP_INTERVAL_MS_DEFAULT
  }
  return Math.min(
    IDLE_AGENT_CLEANUP_INTERVAL_MS_MAX,
    Math.max(IDLE_AGENT_CLEANUP_INTERVAL_MS_MIN, Math.floor(value))
  )
}
