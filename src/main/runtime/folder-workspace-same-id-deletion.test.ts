import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type {
  FolderWorkspace,
  ProjectGroup,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import type { IPtyProvider } from '../providers/types'
import { OrcaRuntimeService } from './orca-runtime'

const GROUP_ID = 'group-root'

function makeGroup(): ProjectGroup {
  return {
    id: GROUP_ID,
    name: GROUP_ID,
    parentPath: '/workspace',
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeWorkspace(id: string): FolderWorkspace {
  return {
    id,
    projectGroupId: GROUP_ID,
    name: id,
    folderPath: `/workspace/${id}`,
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

function createRuntime(workspace: FolderWorkspace): OrcaRuntimeService {
  let workspaces = [workspace]
  const provider = {
    listProcesses: vi.fn(async () => []),
    shutdown: vi.fn(async () => {})
  } as unknown as IPtyProvider
  return new OrcaRuntimeService(
    {
      getRepos: () => [],
      getProjectGroups: () => [makeGroup()],
      getFolderWorkspaces: () => workspaces,
      removeFolderWorkspace: (workspaceId: string) => {
        const found = workspaces.some((entry) => entry.id === workspaceId)
        workspaces = workspaces.filter((entry) => entry.id !== workspaceId)
        return found
      },
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => ({}),
      removeWorktreeMeta: () => false,
      getSettings: () => ({})
    } as never,
    undefined,
    { getLocalProvider: () => provider }
  )
}

function makeMobileSnapshot(
  worktree: string,
  snapshotVersion = 1
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer:same-id-deletion',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: 'tab::leaf',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'tab::leaf',
        parentTabId: 'tab',
        leafId: 'leaf',
        title: 'Terminal',
        isActive: true
      }
    ]
  }
}

describe('same-id folder workspace deletion', () => {
  it('preserves a paired-runtime graph while deleting the local owner', async () => {
    const workspace = makeWorkspace('shared-workspace')
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const localPtyId = `${workspaceKey}@@local-pty`
    const remotePtyId = 'remote:env-sibling@@term_sibling'
    const runtime = createRuntime(workspace)
    const stopAndWait = vi.fn(async (ptyId: string) => {
      if (ptyId === localPtyId) {
        runtime.onPtyExit(ptyId, 0)
      }
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    const sync = (includeLocal: boolean, snapshotVersion: number): void => {
      const ptys = includeLocal
        ? [
            { tabId: 'local-tab', leafId: 'local-leaf', ptyId: localPtyId },
            { tabId: 'remote-tab', leafId: 'remote-leaf', ptyId: remotePtyId }
          ]
        : [{ tabId: 'remote-tab', leafId: 'remote-leaf', ptyId: remotePtyId }]
      const snapshot = makeMobileSnapshot(workspaceKey, snapshotVersion)
      const terminalTab = snapshot.tabs[0]!
      snapshot.tabs = ptys.map(({ tabId, leafId, ptyId }) => ({
        ...terminalTab,
        type: 'terminal',
        id: `${tabId}::${leafId}`,
        parentTabId: tabId,
        leafId,
        ptyId,
        title: tabId
      }))
      snapshot.activeTabId = snapshot.tabs[0]?.id ?? null
      runtime.syncWindowGraph(1, {
        tabs: ptys.map(({ tabId, leafId }) => ({
          tabId,
          worktreeId: workspaceKey,
          title: tabId,
          activeLeafId: leafId,
          layout: null
        })),
        leaves: ptys.map(({ tabId, leafId, ptyId }, index) => ({
          tabId,
          worktreeId: workspaceKey,
          leafId,
          paneRuntimeId: index + 1,
          ptyId
        })),
        mobileSessionTabs: [snapshot]
      })
    }
    runtime.attachWindow(1)
    sync(true, 1)

    await expect(
      runtime.deleteFolderWorkspace(workspace.id, { preserveRendererWorkspaceKey: true })
    ).resolves.toEqual({ deleted: true })

    const internals = runtime as unknown as {
      rendererDeletedFolderWorkspaceKeys: Set<string>
      rendererDeletedFolderWorkspacePtyIds: Map<string, Set<string>>
      tabs: Map<string, { worktreeId: string }>
      leaves: Map<string, { worktreeId: string; ptyId: string | null }>
      ptysById: Map<string, { worktreeId: string }>
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    expect(stopAndWait).toHaveBeenCalledWith(localPtyId, expect.any(Object))
    expect(stopAndWait).not.toHaveBeenCalledWith(remotePtyId, expect.anything())
    expect([...internals.leaves.values()].map((leaf) => leaf.ptyId)).toEqual([remotePtyId])
    expect(internals.ptysById.has(localPtyId)).toBe(false)
    expect(internals.ptysById.get(remotePtyId)).toEqual(
      expect.objectContaining({ worktreeId: workspaceKey })
    )
    expect(
      internals.mobileSessionTabsByWorktree
        .get(workspaceKey)
        ?.tabs.filter((tab) => tab.type === 'terminal')
        .map((tab) => tab.ptyId)
    ).toEqual([remotePtyId])
    expect(internals.rendererDeletedFolderWorkspaceKeys.has(workspaceKey)).toBe(false)
    expect(internals.rendererDeletedFolderWorkspacePtyIds.get(workspaceKey)).toEqual(
      new Set([localPtyId])
    )

    sync(true, 2)
    expect([...internals.leaves.values()].map((leaf) => leaf.ptyId)).toEqual([remotePtyId])
    expect(internals.ptysById.has(localPtyId)).toBe(false)
    expect(
      internals.mobileSessionTabsByWorktree
        .get(workspaceKey)
        ?.tabs.filter((tab) => tab.type === 'terminal')
        .map((tab) => tab.ptyId)
    ).toEqual([remotePtyId])
    expect(internals.rendererDeletedFolderWorkspacePtyIds.has(workspaceKey)).toBe(true)

    sync(false, 3)
    expect([...internals.tabs.values()].map((tab) => tab.worktreeId)).toEqual([workspaceKey])
    expect([...internals.leaves.values()].map((leaf) => leaf.ptyId)).toEqual([remotePtyId])
    expect(internals.rendererDeletedFolderWorkspacePtyIds.has(workspaceKey)).toBe(false)
  })

  it('fences a snapshot-only owner PTY and preserves the surviving split layout', async () => {
    const workspace = makeWorkspace('snapshot-shared')
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const localPtyId = `${workspaceKey}@@snapshot-only`
    const remotePtyIds = ['remote:env-sibling@@remote-a', 'remote:env-sibling@@remote-b']
    const leafIds = ['local', 'remote-a', 'remote-b']
    const survivingLayoutRoot: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.4,
      first: { type: 'leaf', leafId: leafIds[1]! },
      second: { type: 'leaf', leafId: leafIds[2]! }
    }
    const layout: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.25,
        first: { type: 'leaf', leafId: leafIds[0]! },
        second: survivingLayoutRoot
      },
      activeLeafId: leafIds[0]!,
      expandedLeafId: leafIds[0]!,
      ptyIdsByLeafId: {
        [leafIds[0]!]: localPtyId,
        [leafIds[1]!]: remotePtyIds[0]!,
        [leafIds[2]!]: remotePtyIds[1]!
      },
      buffersByLeafId: { local: 'local-buffer', 'remote-a': 'a-buffer' },
      scrollbackRefsByLeafId: { local: 'local-ref', 'remote-b': 'b-ref' },
      titlesByLeafId: { local: 'Local', 'remote-a': 'Remote A', 'remote-b': 'Remote B' }
    }
    const runtime = createRuntime(workspace)
    runtime.preAllocateHandleForPty(localPtyId)
    const stopAndWait = vi.fn().mockResolvedValue(true)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      stopAndWait,
      getForegroundProcess: async () => null
    })
    const snapshot = makeMobileSnapshot(workspaceKey)
    snapshot.tabs = [localPtyId, ...remotePtyIds].map((ptyId, index) => ({
      type: 'terminal',
      id: `shared::${leafIds[index]}`,
      parentTabId: 'shared',
      leafId: leafIds[index]!,
      ptyId,
      title: leafIds[index]!,
      parentLayout: layout,
      isActive: index === 0
    }))
    snapshot.activeTabId = snapshot.tabs[0]!.id
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'shared',
          worktreeId: workspaceKey,
          title: 'shared',
          activeLeafId: leafIds[1]!,
          layout: survivingLayoutRoot
        }
      ],
      leaves: remotePtyIds.map((ptyId, index) => ({
        tabId: 'shared',
        worktreeId: workspaceKey,
        leafId: leafIds[index + 1]!,
        paneRuntimeId: index + 1,
        ptyId
      })),
      mobileSessionTabs: [snapshot]
    })

    await expect(runtime.deleteFolderWorkspace(workspace.id)).resolves.toEqual({ deleted: true })

    const internals = runtime as unknown as {
      rendererDeletedFolderWorkspacePtyIds: Map<string, Set<string>>
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      handleByPtyId: Map<string, string>
    }
    const stored = internals.mobileSessionTabsByWorktree.get(workspaceKey)!
    const expectedLayout: TerminalLayoutSnapshot = {
      root: survivingLayoutRoot,
      activeLeafId: leafIds[1]!,
      expandedLeafId: null,
      ptyIdsByLeafId: { 'remote-a': remotePtyIds[0]!, 'remote-b': remotePtyIds[1]! },
      buffersByLeafId: { 'remote-a': 'a-buffer' },
      scrollbackRefsByLeafId: { 'remote-b': 'b-ref' },
      titlesByLeafId: { 'remote-a': 'Remote A', 'remote-b': 'Remote B' }
    }
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(internals.rendererDeletedFolderWorkspacePtyIds.get(workspaceKey)).toEqual(
      new Set([localPtyId])
    )
    expect(internals.handleByPtyId.has(localPtyId)).toBe(false)
    expect(stored).toMatchObject({ activeTabId: 'shared::remote-a', activeTabType: 'terminal' })
    expect(stored.tabs.map((tab) => tab.id)).toEqual(['shared::remote-a', 'shared::remote-b'])
    expect(stored.tabs.map((tab) => tab.isActive)).toEqual([true, false])
    expect(stored.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentLayout : null))).toEqual([
      expectedLayout,
      expectedLayout
    ])
  })
})
