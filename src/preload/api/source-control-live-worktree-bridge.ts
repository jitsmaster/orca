import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export type SourceControlLiveWorktreeEvent = {
  paneKey: string
  tabId: string
  worktreeId: string
}

export type SourceControlLiveWorktreeApi = {
  /** Listen for Claude's live-cwd worktree resolution, forwarded on its own channel — never folded into `agentStatus:set`. */
  onSet: (callback: (data: SourceControlLiveWorktreeEvent) => void) => () => void
}

export const sourceControlLiveWorktreeApi = {
  onSet: (callback: (data: SourceControlLiveWorktreeEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SourceControlLiveWorktreeEvent) =>
      callback(data)
    ipcRenderer.on('sourceControlLiveWorktree:set', listener)
    return () => ipcRenderer.removeListener('sourceControlLiveWorktree:set', listener)
  }
} satisfies PreloadApi['sourceControlLiveWorktree']
