const RETENTION_MS = 60_000
const MAX_ENTRIES = 256

type RecentPtyExit = { sequence: number; recordedAt: number }

export class CodexSessionMigrationRecentExits {
  private readonly exits = new Map<string, RecentPtyExit>()

  record(leaseId: string, sequence: number): void {
    const now = Date.now()
    for (const [id, exit] of this.exits) {
      if (now - exit.recordedAt > RETENTION_MS) {
        this.exits.delete(id)
      }
    }
    this.exits.delete(leaseId)
    this.exits.set(leaseId, { sequence, recordedAt: now })
    while (this.exits.size > MAX_ENTRIES) {
      const oldestLeaseId = this.exits.keys().next().value
      if (oldestLeaseId === undefined) {
        break
      }
      this.exits.delete(oldestLeaseId)
    }
  }

  consumeAfter(leaseId: string, startedSequence: number | undefined): RecentPtyExit | null {
    const exit = this.exits.get(leaseId)
    this.exits.delete(leaseId)
    if (
      !exit ||
      startedSequence === undefined ||
      exit.sequence <= startedSequence ||
      Date.now() - exit.recordedAt > RETENTION_MS
    ) {
      return null
    }
    return exit
  }

  matchesAfter(leaseId: string, startedSequence: number | undefined): boolean {
    const exit = this.exits.get(leaseId)
    if (!exit) {
      return false
    }
    if (Date.now() - exit.recordedAt > RETENTION_MS) {
      this.exits.delete(leaseId)
      return false
    }
    return startedSequence !== undefined && exit.sequence > startedSequence
  }
}
