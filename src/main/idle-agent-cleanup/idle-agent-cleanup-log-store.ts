import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { IdleAgentCleanupLogEntry } from '../../shared/idle-agent-cleanup-log-entry'

// Architecture §3: generous enough to retain a meaningful history across many
// ticks/days without unbounded growth (each entry is a handful of small
// fields); the UI's separate display cap (IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS)
// is smaller and lives with the entry type.
const MAX_LOG_ENTRIES = 200

type IdleAgentCleanupLogFile = {
  entries: IdleAgentCleanupLogEntry[]
}

/**
 * Bounded, disk-persisted "recently cleaned" log. Shaped directly on
 * CrashReportStore (src/main/crash-reporting/crash-report-store.ts): a capped
 * array, atomic tmp-then-rename write, a serialized writeChain so concurrent
 * record() calls never interleave, ENOENT/parse-failure read as empty.
 */
export class IdleAgentCleanupLogStore {
  private writeChain = Promise.resolve()

  constructor(private readonly filePath: string) {}

  static fromUserData(userDataPath = app.getPath('userData')): IdleAgentCleanupLogStore {
    return new IdleAgentCleanupLogStore(path.join(userDataPath, 'idle-agent-cleanup-log.json'))
  }

  async record(entry: IdleAgentCleanupLogEntry): Promise<void> {
    const run = this.writeChain.then(async () => {
      // Why: awaiting writeChain from inside its own callback would deadlock;
      // this writer already has exclusive ownership and can read disk directly.
      const entries = await this.readEntriesFromDisk()
      const nextEntries = [entry, ...entries].slice(0, MAX_LOG_ENTRIES)
      await this.writeEntries(nextEntries)
    })
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async listRecent(): Promise<IdleAgentCleanupLogEntry[]> {
    await this.writeChain
    return this.readEntriesFromDisk()
  }

  private async readEntriesFromDisk(): Promise<IdleAgentCleanupLogEntry[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<IdleAgentCleanupLogFile>
      return Array.isArray(parsed.entries) ? parsed.entries.slice(0, MAX_LOG_ENTRIES) : []
    } catch {
      // ENOENT and parse failures both read as an empty log, never thrown.
      return []
    }
  }

  private async writeEntries(entries: IdleAgentCleanupLogEntry[]): Promise<void> {
    const directory = path.dirname(this.filePath)
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`
    try {
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(tmpPath, `${JSON.stringify({ entries }, null, 2)}${os.EOL}`, 'utf8')
      await fs.rename(tmpPath, this.filePath)
    } finally {
      // Why: disk-full and terminal rename failures must not accumulate a new
      // orphaned tmp file after every failed write.
      await fs.rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}
