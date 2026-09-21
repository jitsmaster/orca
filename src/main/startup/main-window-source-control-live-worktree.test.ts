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
})
