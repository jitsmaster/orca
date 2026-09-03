import { ipcRenderer } from 'electron'
import type { IdleAgentCleanupLogEntry } from '../../shared/idle-agent-cleanup-log-entry'
import type { PreloadApi } from '../api-types'

export const idleAgentCleanupApi = {
  getRecentActivity: (): Promise<IdleAgentCleanupLogEntry[]> =>
    ipcRenderer.invoke('idleAgentCleanup:getRecentActivity'),
  onActivityChanged: (callback: (entries: IdleAgentCleanupLogEntry[]) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      entries: IdleAgentCleanupLogEntry[]
    ): void => callback(entries)
    ipcRenderer.on('idleAgentCleanup:activityChanged', listener)
    return () => ipcRenderer.removeListener('idleAgentCleanup:activityChanged', listener)
  }
} satisfies PreloadApi['idleAgentCleanup']
