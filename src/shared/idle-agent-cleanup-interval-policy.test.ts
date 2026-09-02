import { describe, expect, it } from 'vitest'
import {
  IDLE_AGENT_CLEANUP_INTERVAL_MS_DEFAULT,
  IDLE_AGENT_CLEANUP_INTERVAL_MS_MAX,
  IDLE_AGENT_CLEANUP_INTERVAL_MS_MIN,
  normalizeIdleAgentCleanupIntervalMs
} from './idle-agent-cleanup-interval-policy'

describe('normalizeIdleAgentCleanupIntervalMs', () => {
  it('returns the default for a non-finite-number value (missing, NaN, string, etc.)', () => {
    expect(normalizeIdleAgentCleanupIntervalMs(undefined)).toBe(
      IDLE_AGENT_CLEANUP_INTERVAL_MS_DEFAULT
    )
    expect(normalizeIdleAgentCleanupIntervalMs(Number.NaN)).toBe(
      IDLE_AGENT_CLEANUP_INTERVAL_MS_DEFAULT
    )
    expect(normalizeIdleAgentCleanupIntervalMs('300000')).toBe(
      IDLE_AGENT_CLEANUP_INTERVAL_MS_DEFAULT
    )
  })

  it('clamps a tiny or negative value up to the minimum, so the scheduler cannot be driven into a tight loop', () => {
    expect(normalizeIdleAgentCleanupIntervalMs(1)).toBe(IDLE_AGENT_CLEANUP_INTERVAL_MS_MIN)
    expect(normalizeIdleAgentCleanupIntervalMs(-1_000)).toBe(IDLE_AGENT_CLEANUP_INTERVAL_MS_MIN)
  })

  it('clamps a huge value down to the maximum, so it can never outlive its own retention grace period', () => {
    expect(normalizeIdleAgentCleanupIntervalMs(24 * 60 * 60_000)).toBe(
      IDLE_AGENT_CLEANUP_INTERVAL_MS_MAX
    )
  })

  it('floors and passes through an in-range value unchanged', () => {
    expect(normalizeIdleAgentCleanupIntervalMs(900_000.7)).toBe(900_000)
  })
})
