import { agentHookServer } from '../agent-hooks/server'
import { mainProcessState as state } from './main-process-state'

/** Forwards Claude's live-cwd worktree resolution to the Source Control panel's own
 *  IPC channel — separate from `agentStatus:set`/`AgentStatusEntry`, never folded into them. */
export function installSourceControlLiveWorktreeListener(): void {
  agentHookServer.setClaudeLiveWorktreeCwdListener(({ paneKey, tabId, cwd }) => {
    if (!tabId || state.mainWindow?.isDestroyed()) {
      return
    }
    void state.runtime?.resolveCwdWorktreeId(cwd).then((worktreeId) => {
      if (!worktreeId || state.mainWindow?.isDestroyed()) {
        return
      }
      state.mainWindow?.webContents.send('sourceControlLiveWorktree:set', {
        paneKey,
        tabId,
        worktreeId
      })
    })
  })
}

export function clearSourceControlLiveWorktreeListener(): void {
  agentHookServer.setClaudeLiveWorktreeCwdListener(null)
}
