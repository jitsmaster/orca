import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, scheduleWatcherSyncMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  scheduleWatcherSyncMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: handleMock, removeHandler: vi.fn() }
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(),
  gitSpawn: vi.fn()
}))

vi.mock('../git/repo', () => ({
  isGitRepo: vi.fn(),
  getRepoName: vi.fn(),
  getBaseRefDefault: vi.fn(),
  searchBaseRefs: vi.fn()
}))

vi.mock('./filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: vi.fn()
}))

vi.mock('./worktree-base-directory-watcher', () => ({
  scheduleCurrentWorktreeBaseDirectoryWatcherSync: scheduleWatcherSyncMock
}))

import { registerRepoHandlers } from './repos'

type Handler = (event: unknown, args: unknown) => unknown

const handlers = new Map<string, Handler>()
const mainWindow = {
  isDestroyed: () => false,
  webContents: { send: vi.fn() }
}
const store = {
  removeFolderWorkspace: vi.fn(),
  deleteProjectGroup: vi.fn()
}
const runtime = {
  deleteFolderWorkspace: vi.fn(),
  deleteProjectGroup: vi.fn()
}

function register(runtimeOverride?: typeof runtime): void {
  if (runtimeOverride) {
    registerRepoHandlers(mainWindow as never, store as never, runtimeOverride as never)
    return
  }
  registerRepoHandlers(mainWindow as never, store as never)
}

beforeEach(() => {
  handlers.clear()
  handleMock.mockReset()
  handleMock.mockImplementation((channel: string, handler: Handler) => {
    handlers.set(channel, handler)
  })
  mainWindow.webContents.send.mockReset()
  store.removeFolderWorkspace.mockReset()
  store.deleteProjectGroup.mockReset()
  runtime.deleteFolderWorkspace.mockReset()
  runtime.deleteProjectGroup.mockReset()
  scheduleWatcherSyncMock.mockReset()
})

describe('repo IPC folder workspace teardown delegation', () => {
  it('awaits runtime-owned folder workspace deletion and preserves the boolean reply', async () => {
    runtime.deleteFolderWorkspace.mockResolvedValue({ deleted: true })
    register(runtime)

    await expect(
      handlers.get('folderWorkspaces:delete')!(null, { folderWorkspaceId: 'folder-1' })
    ).resolves.toBe(true)

    expect(runtime.deleteFolderWorkspace).toHaveBeenCalledWith('folder-1', { notify: false })
    expect(store.removeFolderWorkspace).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('skips desktop notification when runtime-owned group deletion reports no match', async () => {
    runtime.deleteProjectGroup.mockResolvedValue({ deleted: false })
    register(runtime)

    await expect(handlers.get('projectGroups:delete')!(null, { groupId: 'group-1' })).resolves.toBe(
      false
    )

    expect(runtime.deleteProjectGroup).toHaveBeenCalledWith('group-1', { notify: false })
    expect(store.deleteProjectGroup).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
    expect(scheduleWatcherSyncMock).not.toHaveBeenCalled()
  })

  it('keeps direct store deletion as the two-argument registration fallback', async () => {
    store.removeFolderWorkspace.mockReturnValue(true)
    store.deleteProjectGroup.mockReturnValue(true)
    register()

    await expect(
      handlers.get('folderWorkspaces:delete')!(null, { folderWorkspaceId: 'folder-1' })
    ).resolves.toBe(true)
    await expect(handlers.get('projectGroups:delete')!(null, { groupId: 'group-1' })).resolves.toBe(
      true
    )

    expect(store.removeFolderWorkspace).toHaveBeenCalledWith('folder-1')
    expect(store.deleteProjectGroup).toHaveBeenCalledWith('group-1')
  })
})
