import { afterEach, describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  capturedPanesByTabId,
  disposeParkedTabWatchers,
  parkedWatchersByTabId
} from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { registerRuntimeTerminalTab } from '@/runtime/sync-runtime-graph'
import { teardownSelectiveFolderWorkspaceOwner } from './folder-workspace-selective-renderer-teardown'
import { createTestStore, makeTab } from './store-test-helpers'

const OWNER_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF_ID = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
  for (const tabId of parkedWatchersByTabId.keys()) {
    disposeParkedTabWatchers(tabId)
  }
  capturedPanesByTabId.clear()
})

describe('selective folder workspace renderer teardown', () => {
  it('cleans a live direct-SSH binding through its mounted pane identity', () => {
    const workspaceKey = folderWorkspaceKey('shared')
    const tabId = 'mixed-tab'
    const ownerTargetId = 'ssh-owner'
    const siblingTargetId = 'ssh-sibling'
    const ownerPtyId = toAppSshPtyId(ownerTargetId, 'owner-pty')
    const siblingPtyId = toAppSshPtyId(siblingTargetId, 'sibling-pty')
    const tab = makeTab({ id: tabId, worktreeId: workspaceKey, ptyId: siblingPtyId })
    const authority = {
      targetId: ownerTargetId,
      providerEpoch: 'epoch' as never,
      connectionGeneration: 1
    }
    const watcherDispose = vi.fn()
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { [workspaceKey]: [tab] },
      ptyIdsByTabId: { [tabId]: [siblingPtyId] },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf', leafId: SIBLING_LEAF_ID },
          activeLeafId: SIBLING_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [SIBLING_LEAF_ID]: siblingPtyId }
        }
      },
      directSshLivePtyBindingByTabId: {
        [tabId]: {
          attemptId: 'attempt' as never,
          authority,
          tabGeneration: 1,
          ptyId: ownerPtyId
        }
      },
      runtimePaneTitlesByTabId: { [tabId]: { 7: 'Owner', 8: 'Sibling' } },
      unreadTerminalTabs: { [tabId]: true },
      codexRestartNoticeByPtyId: {
        [ownerPtyId]: { previousAccountLabel: 'Old', nextAccountLabel: 'New' }
      },
      pendingCodexPaneRestartIds: { [ownerPtyId]: true },
      pendingSnapshotByPtyId: { [ownerPtyId]: { snapshot: 'owner snapshot' } },
      pendingColdRestoreByPtyId: {
        [ownerPtyId]: { scrollback: 'owner scrollback', cwd: '/workspace' }
      }
    })
    parkedWatchersByTabId.set(tabId, {
      worktreeId: workspaceKey,
      tabPtyId: siblingPtyId,
      paneIdByPtyId: new Map([[ownerPtyId, 7]]),
      disposersByPtyId: new Map([[ownerPtyId, watcherDispose]])
    })
    const unregister = registerRuntimeTerminalTab({
      tabId,
      worktreeId: workspaceKey,
      getContainer: () => null,
      getManager: () =>
        ({
          getPanes: () => [
            { id: 7, leafId: OWNER_LEAF_ID },
            { id: 8, leafId: SIBLING_LEAF_ID }
          ]
        }) as never,
      getPtyIdForPane: (paneId) => (paneId === 7 ? ownerPtyId : siblingPtyId)
    })

    try {
      teardownSelectiveFolderWorkspaceOwner({
        get: store.getState,
        isCurrent: () => true,
        ownerRemoval: {
          kind: 'ssh',
          hostId: toSshExecutionHostId(ownerTargetId),
          targetId: ownerTargetId,
          workspaceKeys: [workspaceKey]
        },
        retireTabIds: [],
        set: (updater) => store.setState(updater),
        workspaceKey
      })
    } finally {
      unregister()
    }

    const state = store.getState()
    expect(state.directSshLivePtyBindingByTabId[tabId]).toBeUndefined()
    expect(state.runtimePaneTitlesByTabId[tabId]).toEqual({ 8: 'Sibling' })
    expect(state.unreadTerminalTabs[tabId]).toBe(true)
    expect(watcherDispose).toHaveBeenCalledOnce()
    expect(state.codexRestartNoticeByPtyId[ownerPtyId]).toBeUndefined()
    expect(state.pendingCodexPaneRestartIds[ownerPtyId]).toBeUndefined()
    expect(state.pendingSnapshotByPtyId[ownerPtyId]).toBeUndefined()
    expect(state.pendingColdRestoreByPtyId[ownerPtyId]).toBeUndefined()
  })
})
