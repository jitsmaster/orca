type IdleAgentCleanupSchedulerSettings = {
  idleAgentCleanupEnabled: boolean
  idleAgentCleanupIntervalMs: number
}

type IdleAgentCleanupSchedulerDeps = {
  getSettings: () => IdleAgentCleanupSchedulerSettings
  runTick: () => Promise<void>
}

const SETTINGS_KEYS_TRIGGERING_REARM = new Set([
  'idleAgentCleanupEnabled',
  'idleAgentCleanupIntervalMs'
])

/** Owns the periodic idle-agent-cleanup timer; settings reads and tick logic are injected. */
export class IdleAgentCleanupScheduler {
  private readonly _getSettings: () => IdleAgentCleanupSchedulerSettings
  private readonly _runTick: () => Promise<void>
  private _intervalHandle: ReturnType<typeof setInterval> | undefined
  private _tickInFlight = false

  constructor(deps: IdleAgentCleanupSchedulerDeps) {
    this._getSettings = deps.getSettings
    this._runTick = deps.runTick
  }

  start(): void {
    if (this._intervalHandle !== undefined) {
      return // already running -- do not arm a second interval
    }
    const settings = this._getSettings()
    if (!settings.idleAgentCleanupEnabled) {
      return
    }
    this._intervalHandle = setInterval(() => {
      // A tick slower than the configured interval (many candidates, a slow
      // Windows taskkill) must not overlap with the next one -- doubled
      // concurrent full-table scans and a candidate independently
      // kill-attempted twice are both worse than skipping one firing.
      if (this._tickInFlight) {
        return
      }
      this._tickInFlight = true
      void this._runTick().finally(() => {
        this._tickInFlight = false
      })
    }, settings.idleAgentCleanupIntervalMs)
  }

  stop(): void {
    if (this._intervalHandle === undefined) {
      return
    }
    clearInterval(this._intervalHandle)
    this._intervalHandle = undefined
  }

  onSettingsChanged(updatedKeys: readonly string[]): void {
    if (!updatedKeys.some((key) => SETTINGS_KEYS_TRIGGERING_REARM.has(key))) {
      return // no-op: neither the enabled flag nor the interval changed
    }
    this.stop()
    this.start()
  }
}
