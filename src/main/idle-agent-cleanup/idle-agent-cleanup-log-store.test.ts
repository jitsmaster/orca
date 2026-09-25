import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS,
  type IdleAgentCleanupLogEntry
} from '../../shared/idle-agent-cleanup-log-entry'
import { IdleAgentCleanupLogStore } from './idle-agent-cleanup-log-store'

const tempDirs: string[] = []

async function createStore(): Promise<{ store: IdleAgentCleanupLogStore; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-idle-agent-cleanup-log-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, 'idle-agent-cleanup-log.json')
  return { store: new IdleAgentCleanupLogStore(filePath), filePath }
}

function entry(index: number): IdleAgentCleanupLogEntry {
  return {
    pid: 1000 + index,
    command: `cmd-${index}`,
    agentName: 'Claude Code',
    paneId: `pane-${index}`,
    timestamp: index,
    outcome: 'killed'
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('IdleAgentCleanupLogStore', () => {
  it('prepends newest-first and caps at 200 entries (architecture §3), dropping the oldest', async () => {
    const { store } = await createStore()

    for (let index = 0; index < 202; index += 1) {
      await store.record(entry(index))
    }

    const entries = await store.listRecent()
    expect(entries).toHaveLength(200)
    expect(entries[0].command).toBe('cmd-201')
    expect(entries[199].command).toBe('cmd-2')
  })

  it('serializes concurrent record() calls so a tick killing 2+ candidates does not interleave/corrupt the file', async () => {
    const { store } = await createStore()

    await Promise.all(Array.from({ length: 5 }, (_, index) => store.record(entry(index))))

    const entries = await store.listRecent()
    expect(entries).toHaveLength(5)
    expect(new Set(entries.map((e) => e.command)).size).toBe(5)
  })

  it('returns an empty list from listRecent() when the log file does not exist (ENOENT)', async () => {
    const { store } = await createStore()

    await expect(store.listRecent()).resolves.toEqual([])
  })

  it('returns an empty list from listRecent() when the log file is corrupt/truncated', async () => {
    const { store, filePath } = await createStore()
    await fs.writeFile(filePath, '{ not valid json', 'utf8')

    await expect(store.listRecent()).resolves.toEqual([])
  })

  it('never leaves the log file half-written when a write is interrupted mid-rename (atomic tmp+rename)', async () => {
    const { store, filePath } = await createStore()
    await store.record(entry(0))

    const ioError = Object.assign(new Error('disk error'), { code: 'EIO' })
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(ioError)

    await expect(store.record(entry(1))).rejects.toBe(ioError)

    const reloaded = new IdleAgentCleanupLogStore(filePath)
    const entries = await reloaded.listRecent()
    expect(entries).toHaveLength(1)
    expect(entries[0].command).toBe('cmd-0')

    const dirEntries = await fs.readdir(path.dirname(filePath))
    expect(dirEntries.filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

// Architecture §3: co-located with the log entry type since main's listRecent()
// callers and the renderer's list component both need to agree on it.
describe('IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS', () => {
  it('is 25 — the UI display cap, distinct from the 200-entry storage cap', () => {
    expect(IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS).toBe(25)
  })
})
