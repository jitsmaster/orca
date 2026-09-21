import { agentHookServer } from '../agent-hooks/server'
import { mainProcessState as state } from './main-process-state'

// Per-tab generation counter so an out-of-order-resolving async lookup for a stale cwd can never
// overwrite a newer one; see the check before `send()` below. The counter is global (never reset
// per tab) so a generation number is never reused — clearing the map still safely invalidates any
// in-flight resolution without risking it colliding with a freshly assigned generation.
let nextGeneration = 0
const latestGenerationByTabId = new Map<string, number>()

/** Forwards Claude's live-cwd worktree resolution to the Source Control panel's own
 *  IPC channel — separate from `agentStatus:set`/`AgentStatusEntry`, never folded into them.
 *  Why: keyed by tabId only, not paneKey — a tab with multiple panes running different Claude
 *  sessions gets last-write-wins across panes; no pane-focus precedence yet, by design for this
 *  initial scope. */
export function installSourceControlLiveWorktreeListener(): void {
  agentHookServer.setClaudeLiveWorktreeCwdListener(({ paneKey, tabId, cwd }) => {
    if (!tabId || state.mainWindow?.isDestroyed()) {
      return
    }
    // Why: async resolutions for the same tab can complete out of order; only the send whose
    // generation is still current may reach the renderer, so a stale cwd never overwrites a newer one.
    const generation = ++nextGeneration
    latestGenerationByTabId.set(tabId, generation)
    void state.runtime?.resolveCwdWorktreeId(cwd).then((worktreeId) => {
      if (!worktreeId || state.mainWindow?.isDestroyed()) {
        return
      }
      if (latestGenerationByTabId.get(tabId) !== generation) {
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
  latestGenerationByTabId.clear()
}
