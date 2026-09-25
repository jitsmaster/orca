import { BrowserWindow, ipcMain } from 'electron'
import type { IdleAgentCleanupLogEntry } from '../../shared/idle-agent-cleanup-log-entry'
import type { IdleAgentCleanupLogStore } from '../idle-agent-cleanup/idle-agent-cleanup-log-store'
import { createRegisterOnceGuard } from './register-once-guard'

const hasRegistered = createRegisterOnceGuard()

export function registerIdleAgentCleanupHandlers(logStore: IdleAgentCleanupLogStore): void {
  if (!hasRegistered()) {
    return
  }
  ipcMain.handle('idleAgentCleanup:getRecentActivity', () => logStore.listRecent())
}

export function notifyIdleAgentCleanupActivityChanged(entries: IdleAgentCleanupLogEntry[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('idleAgentCleanup:activityChanged', entries)
    }
  }
}

/** Wraps a log store so a tick's flush() (after all its record() calls settle) pushes the refreshed list to all renderers once. */
export function createNotifyingIdleAgentCleanupLog(logStore: IdleAgentCleanupLogStore): {
  record(entry: IdleAgentCleanupLogEntry): Promise<void>
  flush(): Promise<void>
} {
  return {
    record: (entry) => logStore.record(entry),
    flush: async () => {
      notifyIdleAgentCleanupActivityChanged(await logStore.listRecent())
    }
  }
}
