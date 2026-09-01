import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { IdleAgentCleanupLogEntry } from '../../shared/idle-agent-cleanup-log-entry'
import type { IdleAgentCleanupLogStore } from '../idle-agent-cleanup/idle-agent-cleanup-log-store'

const { browserWindowGetAllWindowsMock, handleMock } = vi.hoisted(() => ({
  browserWindowGetAllWindowsMock: vi.fn(),
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: browserWindowGetAllWindowsMock },
  ipcMain: { handle: handleMock }
}))

import {
  registerIdleAgentCleanupHandlers,
  notifyIdleAgentCleanupActivityChanged,
  createNotifyingIdleAgentCleanupLog
} from './idle-agent-cleanup'

function makeEntry(overrides: Partial<IdleAgentCleanupLogEntry> = {}): IdleAgentCleanupLogEntry {
  return {
    pid: 1234,
    command: 'claude --resume',
    agentName: 'claude',
    timestamp: 1_000,
    outcome: 'killed',
    ...overrides
  }
}

function makeWindow(overrides: { isDestroyed?: boolean; send?: ReturnType<typeof vi.fn> } = {}) {
  return {
    isDestroyed: vi.fn(() => overrides.isDestroyed ?? false),
    webContents: { send: overrides.send ?? vi.fn() }
  }
}

describe('registerIdleAgentCleanupHandlers', () => {
  const logStore = {
    record: vi.fn(),
    listRecent: vi.fn()
  }

  beforeEach(() => {
    handleMock.mockClear()
    logStore.record.mockReset()
    logStore.listRecent.mockReset()
  })

  it('registers idleAgentCleanup:getRecentActivity via ipcMain.handle', () => {
    registerIdleAgentCleanupHandlers(logStore as unknown as IdleAgentCleanupLogStore)

    const channels = handleMock.mock.calls.map((call) => call[0])
    expect(channels).toContain('idleAgentCleanup:getRecentActivity')
  })

  it('answers idleAgentCleanup:getRecentActivity with logStore.listRecent()', async () => {
    const entries = [makeEntry()]
    logStore.listRecent.mockResolvedValue(entries)
    registerIdleAgentCleanupHandlers(logStore as unknown as IdleAgentCleanupLogStore)

    const handler = handleMock.mock.calls.find(
      (call) => call[0] === 'idleAgentCleanup:getRecentActivity'
    )?.[1] as () => Promise<IdleAgentCleanupLogEntry[]>

    await expect(handler()).resolves.toEqual(entries)
    expect(logStore.listRecent).toHaveBeenCalledTimes(1)
  })
})

describe('notifyIdleAgentCleanupActivityChanged', () => {
  beforeEach(() => {
    browserWindowGetAllWindowsMock.mockReset()
  })

  it('sends idleAgentCleanup:activityChanged to every non-destroyed window', () => {
    const entries = [makeEntry()]
    const liveWindow = makeWindow()
    browserWindowGetAllWindowsMock.mockReturnValue([liveWindow])

    notifyIdleAgentCleanupActivityChanged(entries)

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(
      'idleAgentCleanup:activityChanged',
      entries
    )
  })

  it('skips destroyed windows', () => {
    const entries = [makeEntry()]
    const destroyedWindow = makeWindow({ isDestroyed: true })
    browserWindowGetAllWindowsMock.mockReturnValue([destroyedWindow])

    notifyIdleAgentCleanupActivityChanged(entries)

    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('is a no-op when there are zero windows', () => {
    browserWindowGetAllWindowsMock.mockReturnValue([])

    expect(() => notifyIdleAgentCleanupActivityChanged([makeEntry()])).not.toThrow()
  })
})

describe('createNotifyingIdleAgentCleanupLog', () => {
  const logStore = {
    record: vi.fn(),
    listRecent: vi.fn()
  }

  beforeEach(() => {
    logStore.record.mockReset()
    logStore.listRecent.mockReset()
    browserWindowGetAllWindowsMock.mockReset()
  })

  it('records the entry then pushes the resulting listRecent() array to every window', async () => {
    const entry = makeEntry()
    const refreshedEntries = [entry, makeEntry({ pid: 5678 })]
    logStore.record.mockResolvedValue(undefined)
    logStore.listRecent.mockResolvedValue(refreshedEntries)
    const window = makeWindow()
    browserWindowGetAllWindowsMock.mockReturnValue([window])

    const notifyingLog = createNotifyingIdleAgentCleanupLog(
      logStore as unknown as IdleAgentCleanupLogStore
    )
    await notifyingLog.record(entry)

    expect(logStore.record).toHaveBeenCalledWith(entry)
    expect(logStore.listRecent).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledWith(
      'idleAgentCleanup:activityChanged',
      refreshedEntries
    )
  })

  it('propagates a rejection from logStore.record without calling listRecent or notifying', async () => {
    const entry = makeEntry()
    const failure = new Error('disk full')
    logStore.record.mockRejectedValue(failure)
    const window = makeWindow()
    browserWindowGetAllWindowsMock.mockReturnValue([window])

    const notifyingLog = createNotifyingIdleAgentCleanupLog(
      logStore as unknown as IdleAgentCleanupLogStore
    )

    await expect(notifyingLog.record(entry)).rejects.toThrow('disk full')
    expect(logStore.listRecent).not.toHaveBeenCalled()
    expect(window.webContents.send).not.toHaveBeenCalled()
  })
})
