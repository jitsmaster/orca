import type { ExecutionHostId } from '../../../../shared/execution-host'
import { disposeRemovedWorktreeParkedTerminalWatchers } from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import type { AppState } from '../types'
import {
  closeLegacyRuntimeCatalogTerminals,
  type FolderWorkspaceRuntimeTerminalRemoval
} from './folder-workspace-legacy-terminal-close'
import { teardownSelectiveFolderWorkspaceOwner } from './folder-workspace-selective-renderer-teardown'
import { folderWorkspaceTerminalOwnerOwnsPty } from './folder-workspace-terminal-owner'

export type FolderWorkspaceRendererTeardownSnapshot = {
  workspaceKey: string
  ptyIds: string[]
  purgeRendererState: boolean
  retireTabIds: string[]
  ownerRemoval: FolderWorkspaceRendererOwnerRemoval | null
  runtimeCatalogRemoval: FolderWorkspaceRuntimeTerminalRemoval | null
}

export type FolderWorkspaceRendererOwnerRemoval =
  | {
      kind: 'local'
      hostId: ExecutionHostId
      workspaceKeys: readonly string[]
    }
  | {
      kind: 'ssh'
      hostId: ExecutionHostId
      targetId: string
      workspaceKeys: readonly string[]
    }
  | {
      kind: 'runtime'
      environmentId: string
      expectedEnvironmentPairingRevision?: number
      hostId: ExecutionHostId
      workspaceKeys: readonly string[]
      closeLegacyRuntimeTerminals?: boolean
    }

type FolderWorkspaceRendererTeardownSnapshotState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'lastKnownRelayPtyIdByTabId'
  | 'deferredSshSessionIdsByTabId'
  | 'directSshLivePtyBindingByTabId'
  | 'pendingReconnectPtyIdByTabId'
  | 'activeWorktreeId'
  | 'activeWorkspaceKey'
  | 'activeWorkspaceExecutionHostId'
  | 'activeTabId'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

type FolderWorkspaceRendererTeardownSet = (
  updater: (state: AppState) => AppState | Partial<AppState>
) => void

function collectTerminalTabBoundPtyIds(
  state: FolderWorkspaceRendererTeardownSnapshotState,
  tab: { id: string; ptyId: string | null }
): string[] {
  return [
    ...new Set(
      [
        ...(state.ptyIdsByTabId[tab.id] ?? []),
        tab.ptyId,
        ...Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}),
        state.lastKnownRelayPtyIdByTabId[tab.id],
        state.deferredSshSessionIdsByTabId[tab.id],
        state.directSshLivePtyBindingByTabId[tab.id]?.ptyId,
        state.pendingReconnectPtyIdByTabId[tab.id]
      ].filter((ptyId): ptyId is string => Boolean(ptyId))
    )
  ]
}

function unboundTabsBelongToRemovedOwner(
  state: FolderWorkspaceRendererTeardownSnapshotState,
  workspaceKey: string,
  tabId: string,
  ownerRemoval: FolderWorkspaceRendererOwnerRemoval
): boolean {
  if (state.activeTabId !== tabId) {
    return false
  }
  if (state.activeWorktreeId !== workspaceKey && state.activeWorkspaceKey !== workspaceKey) {
    return false
  }
  return state.activeWorkspaceExecutionHostId === null
    ? state.restoredRuntimeHostIdByWorkspaceSessionKey[workspaceKey] === ownerRemoval.hostId
    : state.activeWorkspaceExecutionHostId === ownerRemoval.hostId
}

function getRuntimeTerminalHandlesFromPtyIds(
  ptyIds: readonly string[],
  environmentId: string
): string[] {
  return [
    ...new Set(
      ptyIds.flatMap((ptyId) => {
        const remote = parseRemoteRuntimePtyId(ptyId)
        return remote?.environmentId === environmentId && remote.handle ? [remote.handle] : []
      })
    )
  ]
}

export function snapshotFolderWorkspaceRuntimeTerminalHandles(
  state: FolderWorkspaceRendererTeardownSnapshotState,
  workspaceKeys: readonly string[],
  environmentId: string
): string[] {
  return getRuntimeTerminalHandlesFromPtyIds(
    [
      ...new Set(
        workspaceKeys.flatMap((workspaceKey) =>
          (state.tabsByWorktree[workspaceKey] ?? []).flatMap((tab) =>
            collectTerminalTabBoundPtyIds(state, tab)
          )
        )
      )
    ],
    environmentId
  )
}

export function snapshotFolderWorkspaceRendererTeardown(
  state: FolderWorkspaceRendererTeardownSnapshotState,
  purgeWorkspaceKeys: readonly string[],
  ownerRemoval?: FolderWorkspaceRendererOwnerRemoval
): FolderWorkspaceRendererTeardownSnapshot[] {
  const purgeKeys = new Set(purgeWorkspaceKeys)
  const ownerRemovalKeys = new Set(ownerRemoval?.workspaceKeys ?? [])
  const runtimeCatalogRemoval =
    ownerRemoval?.kind === 'runtime' && ownerRemoval.closeLegacyRuntimeTerminals === true
      ? ownerRemoval
      : null
  const workspaceKeys = new Set([...purgeKeys, ...ownerRemovalKeys])
  return [...workspaceKeys].map((workspaceKey) => {
    const tabs = state.tabsByWorktree[workspaceKey] ?? []
    const ptyIdsByTabId = new Map(
      tabs.map((tab) => [tab.id, collectTerminalTabBoundPtyIds(state, tab)])
    )
    const ptyIds = [...new Set([...ptyIdsByTabId.values()].flat())]
    const terminalHandles = runtimeCatalogRemoval
      ? getRuntimeTerminalHandlesFromPtyIds(ptyIds, runtimeCatalogRemoval.environmentId)
      : []
    return {
      workspaceKey,
      ptyIds,
      purgeRendererState: purgeKeys.has(workspaceKey),
      ownerRemoval: ownerRemoval && ownerRemovalKeys.has(workspaceKey) ? ownerRemoval : null,
      retireTabIds:
        ownerRemoval && ownerRemovalKeys.has(workspaceKey)
          ? tabs
              .filter((tab) => {
                const tabPtyIds = ptyIdsByTabId.get(tab.id) ?? []
                return (
                  (tabPtyIds.length > 0 &&
                    tabPtyIds.every((ptyId) =>
                      folderWorkspaceTerminalOwnerOwnsPty(ownerRemoval, ptyId)
                    )) ||
                  (tabPtyIds.length === 0 &&
                    unboundTabsBelongToRemovedOwner(state, workspaceKey, tab.id, ownerRemoval))
                )
              })
              .map((tab) => tab.id)
          : [],
      runtimeCatalogRemoval:
        runtimeCatalogRemoval && ownerRemovalKeys.has(workspaceKey) && terminalHandles.length > 0
          ? {
              environmentId: runtimeCatalogRemoval.environmentId,
              expectedEnvironmentPairingRevision:
                runtimeCatalogRemoval.expectedEnvironmentPairingRevision,
              terminalHandles
            }
          : null
    }
  })
}

export async function teardownDeletedFolderWorkspaceRendererState(
  set: FolderWorkspaceRendererTeardownSet,
  get: () => AppState,
  snapshots: readonly FolderWorkspaceRendererTeardownSnapshot[],
  options: { isCurrent?: () => boolean } = {}
): Promise<void> {
  if (snapshots.length === 0) {
    return
  }
  const isCurrent = options.isCurrent ?? (() => true)
  const backendTeardownByEnvironment = new Map<string, Promise<boolean>>()
  for (const snapshot of snapshots) {
    await closeLegacyRuntimeCatalogTerminals(
      snapshot.runtimeCatalogRemoval,
      backendTeardownByEnvironment,
      isCurrent
    )
  }
  for (const snapshot of snapshots) {
    if (snapshot.purgeRendererState || !isCurrent()) {
      continue
    }
    teardownSelectiveFolderWorkspaceOwner({
      get,
      isCurrent,
      ownerRemoval: snapshot.ownerRemoval,
      retireTabIds: snapshot.retireTabIds,
      set,
      workspaceKey: snapshot.workspaceKey
    })
  }
  const purgeSnapshots = snapshots.filter((snapshot) => snapshot.purgeRendererState)
  for (const { workspaceKey, ptyIds } of purgeSnapshots) {
    if (!isCurrent()) {
      break
    }
    try {
      await get().shutdownWorktreeBrowsers(workspaceKey)
    } catch (error) {
      console.warn('Failed to shut down deleted folder workspace browsers:', error)
    }
    if (!isCurrent()) {
      break
    }
    try {
      await get().shutdownWorktreeTerminals(workspaceKey, {
        shutdownReason: 'remove-worktree',
        backendOwnsPtyTeardown: true
      })
    } catch (error) {
      // Why: backend deletion is authoritative, so renderer binding failure cannot retain the workspace.
      console.warn('Failed to retire deleted folder workspace terminals:', error)
    }
    if (!isCurrent()) {
      break
    }
    disposeRemovedWorktreeParkedTerminalWatchers(workspaceKey, ptyIds)
  }
  if (purgeSnapshots.length > 0 && isCurrent()) {
    get().purgeWorktreeTerminalState(purgeSnapshots.map(({ workspaceKey }) => workspaceKey))
  }
}
