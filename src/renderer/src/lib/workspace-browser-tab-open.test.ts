import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { openWorkspaceBrowserTab, resolveWorkspaceBrowserOwner } from './workspace-browser-tab-open'

const mocks = vi.hoisted(() => ({
  createRemote: vi.fn(),
  getState: vi.fn(),
  state: {} as Record<string, unknown>
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.getState() }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: (...args: unknown[]) => mocks.createRemote(...args)
}))

const WORKSPACE_ID = 'repo-1::/repo/worktree'

function ownerState(hostId?: string, runtimeOwnerEnvironmentId?: string): Record<string, unknown> {
  return {
    worktreesByRepo: {
      'repo-1': [
        {
          id: WORKSPACE_ID,
          repoId: 'repo-1',
          ...(hostId ? { hostId } : {}),
          ...(runtimeOwnerEnvironmentId ? { runtimeOwnerEnvironmentId } : {})
        }
      ]
    }
  }
}

beforeEach(() => {
  mocks.createRemote.mockReset().mockResolvedValue(true)
  mocks.getState.mockReset().mockImplementation(() => mocks.state)
  mocks.state = {}
})

describe('resolveWorkspaceBrowserOwner', () => {
  it('preserves client-local and direct-SSH ownership', () => {
    expect(
      resolveWorkspaceBrowserOwner(
        { activeWorktreeId: WORKSPACE_ID, activeWorkspaceExecutionHostId: 'local' },
        WORKSPACE_ID
      )
    ).toEqual({
      status: 'resolved',
      owner: { kind: 'client', workspaceExecutionHostId: 'local' }
    })
    const sshHost = toSshExecutionHostId('ssh-target')
    expect(resolveWorkspaceBrowserOwner(ownerState(sshHost) as never, WORKSPACE_ID)).toEqual({
      status: 'resolved',
      owner: { kind: 'client', workspaceExecutionHostId: sshHost }
    })
  })

  it('preserves proxied hosts and synthesizes only absent legacy runtime hosts', () => {
    const sshHost = toSshExecutionHostId('private-target')
    expect(
      resolveWorkspaceBrowserOwner(ownerState(sshHost, 'hub-a') as never, WORKSPACE_ID)
    ).toEqual({
      status: 'resolved',
      owner: {
        kind: 'runtime',
        environmentId: 'hub-a',
        workspaceExecutionHostId: sshHost
      }
    })
    expect(
      resolveWorkspaceBrowserOwner(ownerState(undefined, 'hub-a') as never, WORKSPACE_ID)
    ).toEqual({
      status: 'resolved',
      owner: {
        kind: 'runtime',
        environmentId: 'hub-a',
        workspaceExecutionHostId: toRuntimeExecutionHostId('hub-a')
      }
    })
  })

  it('rejects missing, malformed, and mismatched ownership', () => {
    expect(resolveWorkspaceBrowserOwner({}, WORKSPACE_ID)).toEqual({
      status: 'unresolved',
      reason: 'missing'
    })
    expect(
      resolveWorkspaceBrowserOwner(ownerState('not-a-host', 'hub-a') as never, WORKSPACE_ID)
    ).toEqual({ status: 'unresolved', reason: 'invalid-workspace-host' })
    expect(
      resolveWorkspaceBrowserOwner(
        ownerState(toRuntimeExecutionHostId('hub-b'), 'hub-a') as never,
        WORKSPACE_ID
      )
    ).toEqual({ status: 'unresolved', reason: 'invalid-workspace-host' })
  })

  it('uses canonical folder and competing-HUB route behavior', () => {
    const folderKey = folderWorkspaceKey('folder-1')
    expect(
      resolveWorkspaceBrowserOwner(
        {
          folderWorkspaces: [
            {
              id: 'folder-1',
              projectGroupId: 'group-1',
              connectionId: null,
              executionHostId: 'local'
            }
          ]
        },
        folderKey
      )
    ).toEqual({
      status: 'resolved',
      owner: { kind: 'client', workspaceExecutionHostId: 'local' }
    })

    const sshHost = toSshExecutionHostId('private-target')
    const competing = {
      worktreesByRepo: {
        'repo-1': [
          ...((ownerState(sshHost, 'hub-a').worktreesByRepo as Record<string, unknown[]>)[
            'repo-1'
          ] ?? []),
          ...((ownerState(sshHost, 'hub-b').worktreesByRepo as Record<string, unknown[]>)[
            'repo-1'
          ] ?? [])
        ]
      }
    }
    expect(resolveWorkspaceBrowserOwner(competing as never, WORKSPACE_ID)).toEqual({
      status: 'unresolved',
      reason: 'ambiguous'
    })
    expect(
      resolveWorkspaceBrowserOwner(
        {
          ...competing,
          activeWorktreeId: WORKSPACE_ID,
          activeWorkspaceExecutionHostId: sshHost
        } as never,
        WORKSPACE_ID
      )
    ).toEqual({
      status: 'resolved',
      owner: { kind: 'client', workspaceExecutionHostId: sshHost }
    })
  })
})

describe('openWorkspaceBrowserTab', () => {
  it('opens client-owned searches with a safe title and host-specific profile', async () => {
    const createBrowserTab = vi.fn()
    const sshHost = toSshExecutionHostId('ssh-target')
    mocks.state = {
      ...ownerState(sshHost),
      createBrowserTab,
      defaultBrowserSessionProfileId: 'focused-profile',
      defaultBrowserSessionProfileIdByHostId: { [sshHost]: 'ssh-profile' }
    }

    await openWorkspaceBrowserTab({
      workspaceId: WORKSPACE_ID,
      targetGroupId: 'group-1',
      url: 'https://www.google.com/search?q=private%20query',
      intent: { kind: 'search', engine: 'google' }
    })

    expect(createBrowserTab).toHaveBeenCalledWith(
      WORKSPACE_ID,
      'https://www.google.com/search?q=private%20query',
      {
        activate: true,
        browserRuntimeEnvironmentId: null,
        focusAddressBar: false,
        sessionProfileId: 'ssh-profile',
        targetGroupId: 'group-1',
        title: 'Search Google'
      }
    )
    expect(mocks.createRemote).not.toHaveBeenCalled()
  })

  it('opens runtime-owned URLs without local fallback or workspace selection', async () => {
    const createBrowserTab = vi.fn()
    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      createBrowserTab,
      defaultBrowserSessionProfileId: 'client-profile',
      defaultBrowserSessionProfileIdByHostId: {}
    }

    await openWorkspaceBrowserTab({
      workspaceId: WORKSPACE_ID,
      url: 'https://example.com/',
      intent: { kind: 'url' }
    })

    expect(mocks.createRemote).toHaveBeenCalledWith({
      worktreeId: WORKSPACE_ID,
      environmentId: 'hub-a',
      url: 'https://example.com/',
      targetGroupId: undefined,
      selectWorktree: false,
      stagedTitle: 'Open URL',
      stagedFocusAddressBar: false,
      failureLogMode: 'operation-only'
    })
    expect(createBrowserTab).not.toHaveBeenCalled()
  })

  it('fails closed for invalid targets and unresolved owners, then falls back locally', async () => {
    const secretUrl = 'https://example.com/?q=secret-value'
    mocks.state = {}
    await expect(
      openWorkspaceBrowserTab({
        workspaceId: WORKSPACE_ID,
        url: 'file:///secret',
        intent: { kind: 'url' }
      })
    ).rejects.toThrow('Unable to open URL.')
    expect(mocks.getState).not.toHaveBeenCalled()

    await expect(
      openWorkspaceBrowserTab({
        workspaceId: WORKSPACE_ID,
        url: secretUrl,
        intent: { kind: 'search', engine: 'kagi' }
      })
    ).rejects.toThrow('Unable to search with Kagi.')
    expect(mocks.createRemote).not.toHaveBeenCalled()

    mocks.state = {
      ...ownerState(toRuntimeExecutionHostId('hub-a')),
      createBrowserTab: vi.fn(),
      defaultBrowserSessionProfileId: 'focused-profile',
      defaultBrowserSessionProfileIdByHostId: { local: 'local-profile' }
    }
    mocks.createRemote.mockResolvedValue(false)
    await openWorkspaceBrowserTab({
      workspaceId: WORKSPACE_ID,
      url: secretUrl,
      intent: { kind: 'search', engine: 'kagi' }
    })
    expect(mocks.state.createBrowserTab).toHaveBeenCalledWith(WORKSPACE_ID, secretUrl, {
      activate: true,
      browserRuntimeEnvironmentId: null,
      focusAddressBar: false,
      sessionProfileId: 'local-profile',
      targetGroupId: undefined,
      title: 'Search Kagi'
    })
  })
})
