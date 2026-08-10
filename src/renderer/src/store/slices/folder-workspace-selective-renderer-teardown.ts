import {
  capturedPanesByTabId,
  disposeParkedTerminalWatchersForPtyIds
} from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { resolveMountedRuntimeTerminalPaneIdByPtyId } from '@/runtime/sync-runtime-graph'
import type { AppState } from '../types'
import { pruneFolderWorkspaceTerminalBindings } from './folder-workspace-terminal-binding-pruning'
import { reconcileDeletedFolderWorkspaceActiveOwner } from './folder-workspace-terminal-owner'
import type { FolderWorkspaceRendererOwnerRemoval } from './folder-workspace-renderer-teardown'

type TeardownSet = (updater: (state: AppState) => AppState | Partial<AppState>) => void

function resolveRemovedRuntimePaneId(tabId: string, ptyId: string): number | null {
  const mounted = resolveMountedRuntimeTerminalPaneIdByPtyId(tabId, ptyId)
  if (mounted.status === 'resolved') {
    return mounted.paneId
  }
  if (mounted.status === 'missing') {
    return null
  }
  return (
    capturedPanesByTabId.get(tabId)?.panes.find((candidate) => candidate.ptyId === ptyId)?.paneId ??
    null
  )
}

export function teardownSelectiveFolderWorkspaceOwner(args: {
  get: () => AppState
  isCurrent: () => boolean
  ownerRemoval: FolderWorkspaceRendererOwnerRemoval | null
  retireTabIds: readonly string[]
  set: TeardownSet
  workspaceKey: string
}): void {
  for (const tabId of args.retireTabIds) {
    if (!args.isCurrent()) {
      return
    }
    args.get().closeTab(tabId, {
      reason: 'cleanup',
      remoteCloseOwnedByHost: true,
      localPtyTeardownOwnedExternally: true
    })
  }
  if (!args.ownerRemoval || !args.isCurrent()) {
    return
  }
  let removedPaneKeys: string[] = []
  let removedPtyBindings: { ptyId: string; tabId: string }[] = []
  let removedPtyIds: string[] = []
  args.set((state) => {
    if (!args.isCurrent()) {
      return state
    }
    const result = pruneFolderWorkspaceTerminalBindings(
      state,
      args.workspaceKey,
      args.ownerRemoval!
    )
    removedPaneKeys = result.removedPaneKeys
    removedPtyBindings = result.removedPtyBindings
    removedPtyIds = result.removedPtyIds
    const activeOwnerPatch = reconcileDeletedFolderWorkspaceActiveOwner(
      state,
      args.workspaceKey,
      args.ownerRemoval!.hostId
    )
    return result.patch || activeOwnerPatch ? { ...result.patch, ...activeOwnerPatch } : state
  })
  if (removedPtyIds.length > 0 && args.isCurrent()) {
    for (const { ptyId, tabId } of removedPtyBindings) {
      const paneId = resolveRemovedRuntimePaneId(tabId, ptyId)
      if (paneId !== null) {
        args.get().clearRuntimePaneTitle(tabId, paneId)
      }
    }
    disposeParkedTerminalWatchersForPtyIds(removedPtyIds)
    for (const ptyId of removedPtyIds) {
      args.get().clearCodexRestartNotice(ptyId)
      args.get().consumePendingSnapshot(ptyId)
      args.get().consumePendingColdRestore(ptyId)
    }
  }
  if (args.isCurrent()) {
    removedPaneKeys.forEach((paneKey) => args.get().retireAgentPaneAuthority(paneKey))
  }
}
