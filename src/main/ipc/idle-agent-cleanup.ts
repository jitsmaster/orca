import { BrowserWindow, ipcMain } from 'electron'
import type { IdleAgentCleanupLogEntry } from '../../shared/idle-agent-cleanup-log-entry'
import type { IdleAgentCleanupLogStore } from '../idle-agent-cleanup/idle-agent-cleanup-log-store'

export function registerIdleAgentCleanupHandlers(logStore: IdleAgentCleanupLogStore): void {
  ipcMain.handle('idleAgentCleanup:getRecentActivity', () => logStore.listRecent())
}

export function notifyIdleAgentCleanupActivityChanged(entries: IdleAgentCleanupLogEntry[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('idleAgentCleanup:activityChanged', entries)
    }
  }
}

/** Wraps a log store so every record() also pushes the refreshed list to all renderers. */
export function createNotifyingIdleAgentCleanupLog(logStore: IdleAgentCleanupLogStore): {
  record(entry: IdleAgentCleanupLogEntry): Promise<void>
} {
  return {
    record: async (entry) => {
      await logStore.record(entry)
      notifyIdleAgentCleanupActivityChanged(await logStore.listRecent())
    }
  }
}
