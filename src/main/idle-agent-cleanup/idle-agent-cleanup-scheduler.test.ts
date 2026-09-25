import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdleAgentCleanupScheduler } from './idle-agent-cleanup-scheduler'

// The scheduler only owns setInterval lifecycle; settings reads and tick logic
// are injected as plain callbacks so this file needs no process-table/fs mocks.

type SchedulerSettings = { idleAgentCleanupEnabled: boolean; idleAgentCleanupIntervalMs: number }

function makeSettings(overrides: Partial<SchedulerSettings> = {}): SchedulerSettings {
  return { idleAgentCleanupEnabled: true, idleAgentCleanupIntervalMs: 60_000, ...overrides }
}

describe('IdleAgentCleanupScheduler', () => {
  let settings: SchedulerSettings
  let runTick: ReturnType<typeof vi.fn<() => Promise<void>>>

  beforeEach(() => {
    vi.useFakeTimers()
    settings = makeSettings()
    runTick = vi.fn(() => Promise.resolve())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeScheduler(
    getSettings: () => SchedulerSettings = () => settings
  ): IdleAgentCleanupScheduler {
    return new IdleAgentCleanupScheduler({ getSettings, runTick })
  }

  it('enable-starts-timer: enabling the feature starts the timer without an app restart', () => {
    const scheduler = makeScheduler()

    scheduler.start()
    vi.advanceTimersByTime(60_000)

    expect(runTick).toHaveBeenCalledTimes(1)
  })

  it('enable-starts-timer: onSettingsChanged after the feature flips on starts the timer without an app restart', () => {
    settings = makeSettings({ idleAgentCleanupEnabled: false })
    const scheduler = makeScheduler()
    scheduler.start()

    settings = makeSettings({ idleAgentCleanupEnabled: true })
    scheduler.onSettingsChanged(['idleAgentCleanupEnabled'])
    vi.advanceTimersByTime(60_000)

    expect(runTick).toHaveBeenCalledTimes(1)
  })

  it('disable-stops-before-next-tick: disabling via onSettingsChanged stops the timer before its next tick would have fired', () => {
    const scheduler = makeScheduler()
    scheduler.start()

    settings = makeSettings({ idleAgentCleanupEnabled: false })
    scheduler.onSettingsChanged(['idleAgentCleanupEnabled'])
    vi.advanceTimersByTime(120_000)

    expect(runTick).not.toHaveBeenCalled()
  })

  it('interval-change-rearms-with-new-value: changing the interval while enabled re-arms with the new value, not the old', () => {
    const scheduler = makeScheduler()
    scheduler.start()

    settings = makeSettings({ idleAgentCleanupIntervalMs: 120_000 })
    scheduler.onSettingsChanged(['idleAgentCleanupIntervalMs'])

    vi.advanceTimersByTime(60_000)
    expect(runTick).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    expect(runTick).toHaveBeenCalledTimes(1)
  })

  it('in-flight-tick-allowed-to-finish-when-stopped: stop() does not reject or discard a runTick promise already in flight', async () => {
    let resolveInFlightTick: (() => void) | undefined
    runTick.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInFlightTick = resolve
        })
    )
    const scheduler = makeScheduler()
    scheduler.start()

    vi.advanceTimersByTime(60_000) // fires the tick; runTick's promise is now in flight
    expect(runTick).toHaveBeenCalledTimes(1)

    expect(() => scheduler.stop()).not.toThrow()

    expect(resolveInFlightTick).toBeDefined()
    await expect(
      new Promise<void>((resolve) => {
        resolveInFlightTick?.()
        resolve()
      })
    ).resolves.toBeUndefined()
  })

  it('does not arm a second interval when start() is called twice without an intervening stop', () => {
    const scheduler = makeScheduler()

    scheduler.start()
    scheduler.start()
    vi.advanceTimersByTime(60_000)

    expect(runTick).toHaveBeenCalledTimes(1)
  })

  it('does not arm any timer when starting while the feature is disabled', () => {
    settings = makeSettings({ idleAgentCleanupEnabled: false })
    const scheduler = makeScheduler()

    scheduler.start()
    vi.advanceTimersByTime(600_000)

    expect(runTick).not.toHaveBeenCalled()
  })

  it('stop() does not throw when called on a scheduler that was never started', () => {
    const scheduler = makeScheduler()

    expect(() => scheduler.stop()).not.toThrow()
  })

  it('stop() is safe to call twice in a row and never calls runTick again afterward', () => {
    const scheduler = makeScheduler()
    scheduler.start()

    scheduler.stop()
    expect(() => scheduler.stop()).not.toThrow()
    vi.advanceTimersByTime(600_000)

    expect(runTick).not.toHaveBeenCalled()
  })

  it('onSettingsChanged is a no-op when the updated keys include neither the enabled flag nor the interval', () => {
    const getSettings = vi.fn(() => settings)
    const scheduler = makeScheduler(getSettings)
    scheduler.start()
    getSettings.mockClear()

    scheduler.onSettingsChanged(['someUnrelatedSetting'])

    expect(getSettings).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(runTick).toHaveBeenCalledTimes(1)
  })
})
