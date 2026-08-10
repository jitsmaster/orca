import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  createCompatibleRuntimeStatusResponse,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { toRemoteRuntimePtyId } from '../../runtime/runtime-terminal-stream'
import { createTestStore, makeTab } from './store-test-helpers'

const disposeRemovedWorktreeParkedTerminalWatchers = vi.hoisted(() => vi.fn())
const capturedPanesByTabId = vi.hoisted(() => new Map())

vi.mock('@/components/terminal-pane/terminal-parked-watcher-registry', () => ({
  capturedPanesByTabId,
  disposeParkedTerminalWatchersForPtyIds: vi.fn(),
  disposeRemovedWorktreeParkedTerminalWatchers,
  retireParkedTerminalTab: vi.fn()
}))

const folderWorkspacesDelete = vi.fn()
const folderWorkspacesList = vi.fn()
const projectGroupsDelete = vi.fn()
const runtimeEnvironmentCall = vi.fn()

const rootGroup: ProjectGroup = {
  id: 'root-group',
  name: 'Root',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1,
  executionHostId: 'local'
}

function makeGroup(id: string, parentGroupId: string | null): ProjectGroup {
  return { ...rootGroup, id, parentGroupId, name: id }
}

function makeFolderWorkspace(
  id: string,
  projectGroupId: string,
  overrides: Partial<FolderWorkspace> = {}
): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: `/workspace/${id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

function seedTerminalRows(
  store: ReturnType<typeof createTestStore>,
  workspaces: readonly FolderWorkspace[]
): void {
  store.setState({
    tabsByWorktree: Object.fromEntries(
      workspaces.map((workspace) => {
        const workspaceKey = folderWorkspaceKey(workspace.id)
        return [workspaceKey, [makeTab({ id: `tab-${workspace.id}`, worktreeId: workspaceKey })]]
      })
    ),
    ptyIdsByTabId: Object.fromEntries(
      workspaces.map((workspace) => [`tab-${workspace.id}`, [`pty-${workspace.id}`]])
    ),
    lastVisitedAtByWorktreeId: Object.fromEntries(
      workspaces.map((workspace, index) => [folderWorkspaceKey(workspace.id), index + 1])
    )
  })
}

function instrumentRendererTeardown(store: ReturnType<typeof createTestStore>, events?: string[]) {
  const canonicalPurge = store.getState().purgeWorktreeTerminalState
  const shutdownWorktreeBrowsers = vi.fn().mockResolvedValue(undefined)
  const shutdownWorktreeTerminals = vi.fn().mockResolvedValue(undefined)
  const purgeWorktreeTerminalState = vi.fn((workspaceKeys: string[]) => {
    events?.push('purge')
    canonicalPurge(workspaceKeys)
  })
  store.setState({
    shutdownWorktreeBrowsers,
    shutdownWorktreeTerminals,
    purgeWorktreeTerminalState
  })
  return { shutdownWorktreeBrowsers, shutdownWorktreeTerminals, purgeWorktreeTerminalState }
}

function mockRuntimeFolderCatalog(backendOwnsPtyTeardown: boolean, events?: string[]): void {
  const status = createCompatibleRuntimeStatusResponse('runtime-owner')
  if (status.ok && !backendOwnsPtyTeardown) {
    status.result.capabilities = status.result.capabilities?.filter(
      (capability) => capability !== FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY
    )
  }
  runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
    if (request.method === 'status.get') {
      return status
    }
    if (request.method === 'folderWorkspace.list') {
      return {
        id: 'rpc-folder-list',
        ok: true,
        result: { folderWorkspaces: [] },
        _meta: { runtimeId: 'runtime-owner' }
      }
    }
    if (request.method === 'terminal.close') {
      events?.push('close')
      return {
        id: 'rpc-terminal-close',
        ok: true,
        result: { close: { closed: true } },
        _meta: { runtimeId: 'runtime-owner' }
      }
    }
    throw new Error(`Unexpected runtime method: ${request.method}`)
  })
}

beforeEach(() => {
  capturedPanesByTabId.clear()
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  runtimeEnvironmentCall.mockReset()
  folderWorkspacesDelete.mockResolvedValue(true)
  folderWorkspacesList.mockResolvedValue([])
  projectGroupsDelete.mockResolvedValue(true)
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: {
        delete: folderWorkspacesDelete,
        list: folderWorkspacesList
      },
      projectGroups: { delete: projectGroupsDelete },
      runtimeEnvironments: { call: runtimeEnvironmentCall }
    }
  })
})

describe('folder workspace renderer teardown', () => {
  it('retires the exact folder scope after direct deletion and preserves its sibling', async () => {
    const removedWorkspace = makeFolderWorkspace('removed', rootGroup.id)
    const siblingWorkspace = makeFolderWorkspace('sibling', rootGroup.id)
    const removedKey = folderWorkspaceKey(removedWorkspace.id)
    const siblingKey = folderWorkspaceKey(siblingWorkspace.id)
    const store = createTestStore()
    store.setState({
      projectGroups: [rootGroup],
      folderWorkspaces: [removedWorkspace, siblingWorkspace],
      activeWorktreeId: siblingKey,
      activeWorkspaceKey: siblingKey
    })
    seedTerminalRows(store, [removedWorkspace, siblingWorkspace])
    const teardown = instrumentRendererTeardown(store)

    await expect(store.getState().deleteFolderWorkspace(removedWorkspace.id)).resolves.toBe(true)

    expect(teardown.shutdownWorktreeBrowsers).toHaveBeenCalledWith(removedKey)
    expect(teardown.shutdownWorktreeTerminals).toHaveBeenCalledWith(removedKey, {
      shutdownReason: 'remove-worktree',
      backendOwnsPtyTeardown: true
    })
    expect(disposeRemovedWorktreeParkedTerminalWatchers).toHaveBeenCalledWith(removedKey, [
      'pty-removed'
    ])
    expect(teardown.purgeWorktreeTerminalState).toHaveBeenCalledWith([removedKey])
    expect(store.getState().folderWorkspaces).toEqual([siblingWorkspace])
    expect(store.getState().tabsByWorktree[removedKey]).toBeUndefined()
    expect(store.getState().tabsByWorktree[siblingKey]).toHaveLength(1)
    expect(store.getState().activeWorktreeId).toBe(siblingKey)
  })

  it('tears down a deleted project-group subtree without touching a sibling workspace', async () => {
    const childGroup = makeGroup('child-group', rootGroup.id)
    const siblingGroup = makeGroup('sibling-group', null)
    const directWorkspace = makeFolderWorkspace('direct', rootGroup.id)
    const childWorkspace = makeFolderWorkspace('child', childGroup.id)
    const siblingWorkspace = makeFolderWorkspace('sibling', siblingGroup.id)
    const directKey = folderWorkspaceKey(directWorkspace.id)
    const childKey = folderWorkspaceKey(childWorkspace.id)
    const siblingKey = folderWorkspaceKey(siblingWorkspace.id)
    const store = createTestStore()
    store.setState({
      projectGroups: [rootGroup, childGroup, siblingGroup],
      folderWorkspaces: [directWorkspace, childWorkspace, siblingWorkspace],
      activeWorktreeId: siblingKey,
      activeWorkspaceKey: siblingKey
    })
    seedTerminalRows(store, [directWorkspace, childWorkspace, siblingWorkspace])
    const teardown = instrumentRendererTeardown(store)

    await expect(store.getState().deleteProjectGroup(rootGroup.id)).resolves.toBe(true)

    expect(teardown.shutdownWorktreeBrowsers.mock.calls).toEqual([[directKey], [childKey]])
    expect(teardown.shutdownWorktreeTerminals.mock.calls).toEqual([
      [directKey, { shutdownReason: 'remove-worktree', backendOwnsPtyTeardown: true }],
      [childKey, { shutdownReason: 'remove-worktree', backendOwnsPtyTeardown: true }]
    ])
    expect(disposeRemovedWorktreeParkedTerminalWatchers.mock.calls).toEqual([
      [directKey, ['pty-direct']],
      [childKey, ['pty-child']]
    ])
    expect(teardown.purgeWorktreeTerminalState).toHaveBeenCalledWith([directKey, childKey])
    expect(store.getState().folderWorkspaces).toEqual([siblingWorkspace])
    expect(store.getState().tabsByWorktree[directKey]).toBeUndefined()
    expect(store.getState().tabsByWorktree[childKey]).toBeUndefined()
    expect(store.getState().tabsByWorktree[siblingKey]).toHaveLength(1)
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ [siblingKey]: 3 })
  })

  it('tears down stale scopes removed by an authoritative folder catalog', async () => {
    const staleWorkspace = makeFolderWorkspace('stale', rootGroup.id)
    const siblingWorkspace = makeFolderWorkspace('sibling', rootGroup.id)
    const staleKey = folderWorkspaceKey(staleWorkspace.id)
    const siblingKey = folderWorkspaceKey(siblingWorkspace.id)
    folderWorkspacesList.mockResolvedValue([{ ...siblingWorkspace, executionHostId: undefined }])
    const store = createTestStore()
    store.setState({
      projectGroups: [rootGroup],
      folderWorkspaces: [staleWorkspace, siblingWorkspace]
    })
    seedTerminalRows(store, [staleWorkspace, siblingWorkspace])
    const teardown = instrumentRendererTeardown(store)

    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })

    expect(teardown.shutdownWorktreeBrowsers).toHaveBeenCalledWith(staleKey)
    expect(teardown.shutdownWorktreeTerminals).toHaveBeenCalledWith(staleKey, {
      shutdownReason: 'remove-worktree',
      backendOwnsPtyTeardown: true
    })
    expect(teardown.purgeWorktreeTerminalState).toHaveBeenCalledWith([staleKey])
    expect(store.getState().folderWorkspaces.map((workspace) => workspace.id)).toEqual([
      siblingWorkspace.id
    ])
    expect(store.getState().tabsByWorktree[staleKey]).toBeUndefined()
    expect(store.getState().tabsByWorktree[siblingKey]).toHaveLength(1)
  })

  it('closes only owner-qualified handles before purging a legacy runtime omission', async () => {
    const environmentId = 'env/owner'
    const workspace = makeFolderWorkspace('legacy', rootGroup.id, {
      executionHostId: toRuntimeExecutionHostId(environmentId)
    })
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const ownerPtyId = toRemoteRuntimePtyId('term_handle', environmentId)
    const siblingPtyId = toRemoteRuntimePtyId('sibling_handle', `${environmentId}-sibling`)
    const unownedPtyId = 'remote:unqualified_handle'
    const tab = makeTab({ id: 'tab-legacy', worktreeId: workspaceKey, ptyId: ownerPtyId })
    const events: string[] = []
    mockRuntimeFolderCatalog(false, events)
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...rootGroup, executionHostId: toRuntimeExecutionHostId(environmentId) }],
      folderWorkspaces: [workspace],
      tabsByWorktree: { [workspaceKey]: [tab] },
      ptyIdsByTabId: { [tab.id]: [ownerPtyId, siblingPtyId, unownedPtyId] }
    })
    const teardown = instrumentRendererTeardown(store, events)

    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })

    const closeRequests = runtimeEnvironmentCall.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method === 'terminal.close')
    expect(closeRequests).toEqual([
      expect.objectContaining({
        selector: environmentId,
        params: { terminal: 'term_handle' },
        timeoutMs: 15_000
      })
    ])
    expect(events).toEqual(['close', 'purge'])
    expect(teardown.shutdownWorktreeTerminals).toHaveBeenCalledWith(workspaceKey, {
      shutdownReason: 'remove-worktree',
      backendOwnsPtyTeardown: true
    })
    expect(store.getState().tabsByWorktree[workspaceKey]).toBeUndefined()
  })

  it('preserves a same-ID sibling host while closing the omitted legacy owner', async () => {
    const environmentId = 'env/owner'
    const ownerHostId = toRuntimeExecutionHostId(environmentId)
    const siblingHostId = toRuntimeExecutionHostId(`${environmentId}-sibling`)
    const owner = makeFolderWorkspace('shared', rootGroup.id, {
      executionHostId: ownerHostId
    })
    const sibling = makeFolderWorkspace('shared', rootGroup.id, {
      name: 'Sibling',
      executionHostId: siblingHostId
    })
    const workspaceKey = folderWorkspaceKey(owner.id)
    const ownerPtyId = toRemoteRuntimePtyId('owner_handle', environmentId)
    const siblingPtyId = toRemoteRuntimePtyId('sibling_handle', `${environmentId}-sibling`)
    const mixedOwnerPtyId = toRemoteRuntimePtyId('mixed_owner_handle', environmentId)
    const targetTab = makeTab({ id: 'tab-target', worktreeId: workspaceKey, ptyId: ownerPtyId })
    const siblingTab = makeTab({
      id: 'tab-sibling',
      worktreeId: workspaceKey,
      ptyId: siblingPtyId
    })
    const mixedTab = makeTab({ id: 'tab-mixed', worktreeId: workspaceKey, ptyId: siblingPtyId })
    const unknownTab = makeTab({
      id: 'tab-unknown',
      worktreeId: workspaceKey,
      ptyId: 'remote:unqualified_handle'
    })
    capturedPanesByTabId.set(mixedTab.id, {
      worktreeId: workspaceKey,
      panes: [
        {
          ptyId: mixedOwnerPtyId,
          paneId: 7,
          leafId: 'owner-leaf',
          drivesTabTitle: false
        },
        {
          ptyId: siblingPtyId,
          paneId: 8,
          leafId: 'sibling-leaf',
          drivesTabTitle: true
        }
      ]
    })
    mockRuntimeFolderCatalog(false)
    const store = createTestStore()
    store.setState({
      projectGroups: [
        { ...rootGroup, executionHostId: ownerHostId },
        { ...rootGroup, executionHostId: siblingHostId }
      ],
      folderWorkspaces: [owner, sibling],
      tabsByWorktree: {
        [workspaceKey]: [targetTab, siblingTab, mixedTab, unknownTab]
      },
      ptyIdsByTabId: {
        [targetTab.id]: [ownerPtyId],
        [siblingTab.id]: [siblingPtyId],
        [mixedTab.id]: [mixedOwnerPtyId, siblingPtyId],
        [unknownTab.id]: ['remote:unqualified_handle']
      },
      terminalLayoutsByTabId: {
        [mixedTab.id]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'owner-leaf' },
            second: { type: 'leaf', leafId: 'sibling-leaf' }
          },
          activeLeafId: 'owner-leaf',
          expandedLeafId: 'owner-leaf',
          ptyIdsByLeafId: {
            'owner-leaf': mixedOwnerPtyId,
            'sibling-leaf': siblingPtyId
          },
          buffersByLeafId: { 'owner-leaf': 'removed', 'sibling-leaf': 'preserved' },
          titlesByLeafId: { 'owner-leaf': 'Owner', 'sibling-leaf': 'Sibling' }
        }
      },
      lastKnownRelayPtyIdByTabId: { [mixedTab.id]: mixedOwnerPtyId },
      deferredSshSessionIdsByTabId: { [mixedTab.id]: mixedOwnerPtyId },
      pendingReconnectPtyIdByTabId: { [mixedTab.id]: mixedOwnerPtyId },
      runtimePaneTitlesByTabId: { [mixedTab.id]: { 7: 'Owner', 8: 'Sibling' } }
    })
    const teardown = instrumentRendererTeardown(store)

    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })

    const closedHandles = runtimeEnvironmentCall.mock.calls.flatMap(([request]) =>
      request.method === 'terminal.close' ? [(request.params as { terminal: string }).terminal] : []
    )
    expect(closedHandles).toEqual(['owner_handle', 'mixed_owner_handle'])
    expect(teardown.shutdownWorktreeBrowsers).not.toHaveBeenCalled()
    expect(teardown.shutdownWorktreeTerminals).not.toHaveBeenCalled()
    expect(teardown.purgeWorktreeTerminalState).not.toHaveBeenCalled()
    expect(store.getState().folderWorkspaces).toEqual([sibling])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([
      siblingTab,
      mixedTab,
      unknownTab
    ])
    expect(store.getState().ptyIdsByTabId[targetTab.id]).toBeUndefined()
    expect(store.getState().ptyIdsByTabId[siblingTab.id]).toEqual([siblingPtyId])
    expect(store.getState().ptyIdsByTabId[mixedTab.id]).toEqual([siblingPtyId])
    expect(store.getState().terminalLayoutsByTabId[mixedTab.id]).toEqual({
      root: { type: 'leaf', leafId: 'sibling-leaf' },
      activeLeafId: 'sibling-leaf',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'sibling-leaf': siblingPtyId },
      buffersByLeafId: { 'sibling-leaf': 'preserved' },
      titlesByLeafId: { 'sibling-leaf': 'Sibling' }
    })
    expect(store.getState().lastKnownRelayPtyIdByTabId[mixedTab.id]).toBe(siblingPtyId)
    expect(store.getState().deferredSshSessionIdsByTabId[mixedTab.id]).toBeUndefined()
    expect(store.getState().pendingReconnectPtyIdByTabId[mixedTab.id]).toBeUndefined()
    expect(store.getState().runtimePaneTitlesByTabId[mixedTab.id]).toEqual({ 8: 'Sibling' })
    expect(store.getState().ptyIdsByTabId[unknownTab.id]).toEqual(['remote:unqualified_handle'])
  })

  it('removes only the exact direct-SSH owner from a same-key workspace', async () => {
    const ownerTargetId = 'ssh-owner'
    const siblingTargetId = 'ssh-sibling'
    const ownerHostId = toSshExecutionHostId(ownerTargetId)
    const siblingHostId = toSshExecutionHostId(siblingTargetId)
    const owner = makeFolderWorkspace('ssh-shared', rootGroup.id, {
      connectionId: ownerTargetId,
      executionHostId: ownerHostId
    })
    const sibling = makeFolderWorkspace('ssh-shared', rootGroup.id, {
      connectionId: siblingTargetId,
      executionHostId: siblingHostId
    })
    const workspaceKey = folderWorkspaceKey(owner.id)
    const ownerPtyId = toAppSshPtyId(ownerTargetId, 'owner-pty')
    const siblingPtyId = toAppSshPtyId(siblingTargetId, 'sibling-pty')
    const localPtyId = 'local-pty'
    const ownerTab = makeTab({ id: 'tab-ssh-owner', worktreeId: workspaceKey, ptyId: ownerPtyId })
    const siblingTab = makeTab({
      id: 'tab-ssh-sibling',
      worktreeId: workspaceKey,
      ptyId: siblingPtyId
    })
    const localTab = makeTab({ id: 'tab-local', worktreeId: workspaceKey, ptyId: localPtyId })
    const store = createTestStore()
    store.setState({
      projectGroups: [rootGroup],
      folderWorkspaces: [owner, sibling],
      tabsByWorktree: { [workspaceKey]: [ownerTab, siblingTab, localTab] },
      ptyIdsByTabId: {
        [ownerTab.id]: [ownerPtyId],
        [siblingTab.id]: [siblingPtyId],
        [localTab.id]: [localPtyId]
      }
    })
    const teardown = instrumentRendererTeardown(store)

    await expect(
      store.getState().deleteFolderWorkspace(owner.id, { hostId: ownerHostId })
    ).resolves.toBe(true)

    expect(teardown.purgeWorktreeTerminalState).not.toHaveBeenCalled()
    expect(store.getState().folderWorkspaces).toEqual([sibling])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([siblingTab, localTab])
    expect(store.getState().ptyIdsByTabId[ownerTab.id]).toBeUndefined()
    expect(store.getState().ptyIdsByTabId[siblingTab.id]).toEqual([siblingPtyId])
    expect(store.getState().ptyIdsByTabId[localTab.id]).toEqual([localPtyId])
  })

  it('retires only the active owner unbound tab and retargets a same-key sibling', async () => {
    const environmentId = 'env-unbound-owner'
    const siblingEnvironmentId = 'env-unbound-sibling'
    const ownerHostId = toRuntimeExecutionHostId(environmentId)
    const siblingHostId = toRuntimeExecutionHostId(siblingEnvironmentId)
    const owner = makeFolderWorkspace('unbound-shared', rootGroup.id, {
      executionHostId: ownerHostId
    })
    const sibling = makeFolderWorkspace('unbound-shared', rootGroup.id, {
      name: 'Unbound sibling',
      executionHostId: siblingHostId
    })
    const workspaceKey = folderWorkspaceKey(owner.id)
    const ownerTab = makeTab({ id: 'tab-unbound-owner', worktreeId: workspaceKey })
    const siblingTab = makeTab({ id: 'tab-unbound-sibling', worktreeId: workspaceKey })
    mockRuntimeFolderCatalog(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [
        { ...rootGroup, executionHostId: ownerHostId },
        { ...rootGroup, executionHostId: siblingHostId }
      ],
      folderWorkspaces: [owner, sibling],
      activeWorktreeId: workspaceKey,
      activeWorkspaceKey: workspaceKey,
      activeWorkspaceExecutionHostId: ownerHostId,
      activeTabId: ownerTab.id,
      tabsByWorktree: { [workspaceKey]: [ownerTab, siblingTab] }
    })
    const teardown = instrumentRendererTeardown(store)

    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })

    expect(teardown.purgeWorktreeTerminalState).not.toHaveBeenCalled()
    expect(store.getState().folderWorkspaces).toEqual([sibling])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([siblingTab])
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(siblingHostId)
  })

  it('preserves an active same-key sibling unbound tab over stale restored ownership', async () => {
    const environmentId = 'env-stale-restored-owner'
    const siblingEnvironmentId = 'env-active-sibling'
    const ownerHostId = toRuntimeExecutionHostId(environmentId)
    const siblingHostId = toRuntimeExecutionHostId(siblingEnvironmentId)
    const owner = makeFolderWorkspace('stale-owner-shared', rootGroup.id, {
      executionHostId: ownerHostId
    })
    const sibling = makeFolderWorkspace('stale-owner-shared', rootGroup.id, {
      name: 'Active sibling',
      executionHostId: siblingHostId
    })
    const workspaceKey = folderWorkspaceKey(owner.id)
    const siblingTab = makeTab({ id: 'tab-active-sibling', worktreeId: workspaceKey })
    mockRuntimeFolderCatalog(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [
        { ...rootGroup, executionHostId: ownerHostId },
        { ...rootGroup, executionHostId: siblingHostId }
      ],
      folderWorkspaces: [owner, sibling],
      activeWorktreeId: workspaceKey,
      activeWorkspaceKey: workspaceKey,
      activeWorkspaceExecutionHostId: siblingHostId,
      activeTabId: siblingTab.id,
      restoredRuntimeHostIdByWorkspaceSessionKey: { [workspaceKey]: ownerHostId },
      tabsByWorktree: { [workspaceKey]: [siblingTab] }
    })
    const teardown = instrumentRendererTeardown(store)

    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })

    expect(teardown.purgeWorktreeTerminalState).not.toHaveBeenCalled()
    expect(store.getState().folderWorkspaces).toEqual([sibling])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([siblingTab])
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(siblingHostId)
  })

  it('uses restored ownership for an active unbound tab with no explicit host', async () => {
    const environmentId = 'env-restored-owner'
    const siblingEnvironmentId = 'env-restored-sibling'
    const ownerHostId = toRuntimeExecutionHostId(environmentId)
    const siblingHostId = toRuntimeExecutionHostId(siblingEnvironmentId)
    const owner = makeFolderWorkspace('restored-owner-shared', rootGroup.id, {
      executionHostId: ownerHostId
    })
    const sibling = makeFolderWorkspace('restored-owner-shared', rootGroup.id, {
      name: 'Restored sibling',
      executionHostId: siblingHostId
    })
    const workspaceKey = folderWorkspaceKey(owner.id)
    const ownerTab = makeTab({ id: 'tab-restored-owner', worktreeId: workspaceKey })
    const siblingTab = makeTab({ id: 'tab-restored-sibling', worktreeId: workspaceKey })
    mockRuntimeFolderCatalog(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [
        { ...rootGroup, executionHostId: ownerHostId },
        { ...rootGroup, executionHostId: siblingHostId }
      ],
      folderWorkspaces: [owner, sibling],
      activeWorktreeId: workspaceKey,
      activeWorkspaceKey: workspaceKey,
      activeWorkspaceExecutionHostId: null,
      activeTabId: ownerTab.id,
      restoredRuntimeHostIdByWorkspaceSessionKey: { [workspaceKey]: ownerHostId },
      tabsByWorktree: { [workspaceKey]: [ownerTab, siblingTab] }
    })

    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })

    expect(store.getState().folderWorkspaces).toEqual([sibling])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([siblingTab])
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(siblingHostId)
  })

  it('leaves terminal teardown to a capable runtime after catalog removal', async () => {
    const environmentId = 'env-modern'
    const workspace = makeFolderWorkspace('modern', rootGroup.id, {
      executionHostId: toRuntimeExecutionHostId(environmentId)
    })
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const ptyId = toRemoteRuntimePtyId('modern_handle', environmentId)
    const tab = makeTab({ id: 'tab-modern', worktreeId: workspaceKey, ptyId })
    mockRuntimeFolderCatalog(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...rootGroup, executionHostId: toRuntimeExecutionHostId(environmentId) }],
      folderWorkspaces: [workspace],
      tabsByWorktree: { [workspaceKey]: [tab] },
      ptyIdsByTabId: { [tab.id]: [ptyId] }
    })
    const teardown = instrumentRendererTeardown(store)

    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: environmentId })

    expect(
      runtimeEnvironmentCall.mock.calls.some(([request]) => request.method === 'terminal.close')
    ).toBe(false)
    expect(teardown.shutdownWorktreeTerminals).toHaveBeenCalledWith(workspaceKey, {
      shutdownReason: 'remove-worktree',
      backendOwnsPtyTeardown: true
    })
    expect(teardown.purgeWorktreeTerminalState).toHaveBeenCalledWith([workspaceKey])
  })
})
