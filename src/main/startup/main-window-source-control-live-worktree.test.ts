import { describe, expect, it, vi } from 'vitest'

type LiveWorktreeCwdEvent = { paneKey: string; tabId?: string; cwd: string }

const { sendMock, resolveCwdWorktreeIdMock, listenerBox } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  resolveCwdWorktreeIdMock: vi.fn(),
  listenerBox: { current: null as ((event: LiveWorktreeCwdEvent) => void) | null }
}))

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    setClaudeLiveWorktreeCwdListener: (
      listener: ((event: LiveWorktreeCwdEvent) => void) | null
    ) => {
      listenerBox.current = listener
    }
  }
}))

vi.mock('./main-process-state', () => ({
  mainProcessState: {
    mainWindow: { isDestroyed: () => false, webContents: { send: sendMock } },
    runtime: { resolveCwdWorktreeId: resolveCwdWorktreeIdMock }
  }
}))

import {
  installSourceControlLiveWorktreeListener,
  clearSourceControlLiveWorktreeListener
} from './main-window-source-control-live-worktree'

describe('installSourceControlLiveWorktreeListener', () => {
  it('forwards a resolved worktree id to the main window', async () => {
    resolveCwdWorktreeIdMock.mockResolvedValue('wt-feature')
    installSourceControlLiveWorktreeListener()
    await listenerBox.current?.({
      paneKey: 'tab-1:leaf-a',
      tabId: 'tab-1',
      cwd: '/repo/wt-feature'
    })
    await Promise.resolve()
    expect(sendMock).toHaveBeenCalledWith('sourceControlLiveWorktree:set', {
      paneKey: 'tab-1:leaf-a',
      tabId: 'tab-1',
      worktreeId: 'wt-feature'
    })
  })

  it('sends nothing when the cwd resolves to no known worktree', async () => {
    sendMock.mockClear()
    resolveCwdWorktreeIdMock.mockResolvedValue(null)
    installSourceControlLiveWorktreeListener()
    await listenerBox.current?.({ paneKey: 'tab-1:leaf-a', tabId: 'tab-1', cwd: '/elsewhere' })
    await Promise.resolve()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('sends nothing when the event carries no tabId', async () => {
    sendMock.mockClear()
    resolveCwdWorktreeIdMock.mockClear()
    installSourceControlLiveWorktreeListener()
    await listenerBox.current?.({ paneKey: 'tab-1:leaf-a', cwd: '/repo/wt-feature' })
    expect(resolveCwdWorktreeIdMock).not.toHaveBeenCalled()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('clears the listener', () => {
    clearSourceControlLiveWorktreeListener()
    expect(listenerBox.current).toBeNull()
  })

  it('only forwards the latest event when two resolutions for the same tab race out of order', async () => {
    sendMock.mockClear()
    let resolveFirst: (worktreeId: string) => void = () => {}
    let resolveSecond: (worktreeId: string) => void = () => {}
    resolveCwdWorktreeIdMock
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveSecond = resolve
          })
      )
    installSourceControlLiveWorktreeListener()

    void listenerBox.current?.({ paneKey: 'tab-1:leaf-a', tabId: 'tab-1', cwd: '/repo/wt-stale' })
    void listenerBox.current?.({ paneKey: 'tab-1:leaf-a', tabId: 'tab-1', cwd: '/repo/wt-fresh' })

    // The second (fresher) event's resolution completes first...
    resolveSecond('wt-fresh')
    await Promise.resolve()
    await Promise.resolve()
    // ...then the first (stale) event's resolution completes after it.
    resolveFirst('wt-stale')
    await Promise.resolve()
    await Promise.resolve()

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('sourceControlLiveWorktree:set', {
      paneKey: 'tab-1:leaf-a',
      tabId: 'tab-1',
      worktreeId: 'wt-fresh'
    })
  })

  it('resets generation tracking on clear so a stale in-flight resolution cannot fire after re-install', async () => {
    sendMock.mockClear()
    resolveCwdWorktreeIdMock.mockClear()
    let resolveStale: (worktreeId: string) => void = () => {}
    resolveCwdWorktreeIdMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveStale = resolve
        })
    )
    installSourceControlLiveWorktreeListener()
    void listenerBox.current?.({ paneKey: 'tab-1:leaf-a', tabId: 'tab-1', cwd: '/repo/wt-old' })

    clearSourceControlLiveWorktreeListener()
    resolveCwdWorktreeIdMock.mockResolvedValue('wt-new')
    installSourceControlLiveWorktreeListener()
    await listenerBox.current?.({ paneKey: 'tab-1:leaf-a', tabId: 'tab-1', cwd: '/repo/wt-new' })
    await Promise.resolve()

    resolveStale('wt-old')
    await Promise.resolve()
    await Promise.resolve()

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(sendMock).toHaveBeenCalledWith('sourceControlLiveWorktree:set', {
      paneKey: 'tab-1:leaf-a',
      tabId: 'tab-1',
      worktreeId: 'wt-new'
    })
  })
})
