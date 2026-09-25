import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  applyAppIconMock,
  applyAgentStatusHooksEnabledMock,
  applyElectronProxySettingsMock,
  browserWindowGetAllWindowsMock,
  handleMock,
  onMock,
  previewGhosttyImportMock,
  previewWarpThemeImportMock,
  prepareLocalWorktreeRootsForReposMock,
  resolveEnvironmentMock,
  rebuildAppMenuMock,
  applyBrowserSessionProxiesMock,
  applySessionSearchSettingsChangeMock,
  listProfilesMock
} = vi.hoisted(() => ({
  applyAppIconMock: vi.fn(),
  applyAgentStatusHooksEnabledMock: vi.fn(),
  applyElectronProxySettingsMock: vi.fn(),
  browserWindowGetAllWindowsMock: vi.fn(),
  handleMock: vi.fn(),
  onMock: vi.fn(),
  previewGhosttyImportMock: vi.fn(),
  previewWarpThemeImportMock: vi.fn(),
  prepareLocalWorktreeRootsForReposMock: vi.fn(),
  resolveEnvironmentMock: vi.fn(),
  rebuildAppMenuMock: vi.fn(),
  applyBrowserSessionProxiesMock: vi.fn(),
  applySessionSearchSettingsChangeMock: vi.fn(),
  listProfilesMock: vi.fn(() => [])
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/test/user-data') },
  BrowserWindow: { getAllWindows: browserWindowGetAllWindowsMock },
  ipcMain: { handle: handleMock, on: onMock },
  nativeTheme: { themeSource: 'system' }
}))

vi.mock('../ghostty/index', () => ({
  previewGhosttyImport: previewGhosttyImportMock
}))

vi.mock('../warp-themes', () => ({
  previewWarpThemeImport: previewWarpThemeImportMock
}))

vi.mock('../network/proxy-settings', () => ({
  applyElectronProxySettings: applyElectronProxySettingsMock
}))

vi.mock('../browser/browser-session-proxy', () => ({
  applyBrowserSessionProxies: applyBrowserSessionProxiesMock
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: { listProfiles: listProfilesMock }
}))

vi.mock('../app-icon', () => ({
  applyAppIcon: applyAppIconMock
}))

vi.mock('../ai-vault-search/session-search-enablement', () => ({
  applySessionSearchSettingsChange: applySessionSearchSettingsChangeMock
}))

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootsForRepos: prepareLocalWorktreeRootsForReposMock
}))

vi.mock('../menu/register-app-menu', () => ({
  rebuildAppMenu: rebuildAppMenuMock
}))

vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: resolveEnvironmentMock
}))

import { registerSettingsHandlers } from './settings'

const settingsInvokeEvent = { sender: { id: 1 } }

const store = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getGitHubCache: vi.fn(),
  setGitHubCache: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {})
}

describe('registerSettingsHandlers proxy settings', () => {
  beforeEach(() => {
    handleMock.mockClear()
    onMock.mockClear()
    applyAppIconMock.mockClear()
    applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
    applyElectronProxySettingsMock.mockClear()
    applyElectronProxySettingsMock.mockResolvedValue({ source: 'settings' })
    previewGhosttyImportMock.mockClear()
    previewWarpThemeImportMock.mockClear()
    prepareLocalWorktreeRootsForReposMock.mockReset().mockResolvedValue(undefined)
    resolveEnvironmentMock.mockReset()
    rebuildAppMenuMock.mockClear()
    applyBrowserSessionProxiesMock.mockReset().mockResolvedValue(undefined)
    applySessionSearchSettingsChangeMock.mockClear()
    listProfilesMock.mockReset().mockReturnValue([])
    browserWindowGetAllWindowsMock.mockReset()
    store.getSettings.mockReset()
    store.updateSettings.mockReset()
    store.onSettingsChanged.mockClear()
  })

  it('sanitizes and applies proxy settings from renderer settings IPC', async () => {
    store.getSettings.mockReturnValue({ httpProxyUrl: '' })
    store.updateSettings.mockReturnValue({
      httpProxyUrl: 'http://proxy.example:8080',
      httpProxyBypassRules: 'localhost;*.internal'
    })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, {
      httpProxyUrl: ' http://proxy.example:8080/path#frag ',
      httpProxyBypassRules: 'localhost, *.internal'
    })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {
        httpProxyUrl: 'http://proxy.example:8080',
        httpProxyBypassRules: 'localhost;*.internal'
      },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    expect(applyElectronProxySettingsMock).toHaveBeenCalledWith({
      httpProxyUrl: 'http://proxy.example:8080',
      httpProxyBypassRules: 'localhost;*.internal'
    })
  })

  it('does not sweep sessions for a no-op proxy save', async () => {
    const settings = {
      httpProxyUrl: 'http://proxy.example:8080',
      httpProxyBypassRules: 'localhost'
    }
    store.getSettings.mockReturnValue(settings)
    store.updateSettings.mockReturnValue(settings)
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      event: typeof settingsInvokeEvent,
      args: { httpProxyUrl: string }
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { httpProxyUrl: 'http://proxy.example:8080' })

    expect(applyElectronProxySettingsMock).not.toHaveBeenCalled()
    expect(listProfilesMock).not.toHaveBeenCalled()
    expect(applyBrowserSessionProxiesMock).not.toHaveBeenCalled()
  })

  it('queues every proxy snapshot on both authorities before either apply settles', async () => {
    store.getSettings.mockReturnValue({ httpProxyUrl: '', httpProxyBypassRules: '' })
    store.updateSettings.mockImplementation((args) =>
      args.httpProxyUrl !== undefined
        ? { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: '' }
        : { httpProxyUrl: 'socks5://127.0.0.1:1080', httpProxyBypassRules: 'late.example' }
    )
    let releaseFirstApply = (): void => {}
    let markFirstApplyStarted = (): void => {}
    const firstApplyStarted = new Promise<void>((resolve) => (markFirstApplyStarted = resolve))
    applyElectronProxySettingsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirstApply = () => resolve({ source: 'settings' })
          markFirstApplyStarted()
        })
    )
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      event: typeof settingsInvokeEvent,
      args: { httpProxyUrl?: string; httpProxyBypassRules?: string }
    ) => Promise<unknown>

    const first = handler(settingsInvokeEvent, { httpProxyUrl: 'socks5://127.0.0.1:1080' })
    await firstApplyStarted
    expect(applyBrowserSessionProxiesMock).toHaveBeenCalledWith([], {
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    })
    const second = handler(settingsInvokeEvent, { httpProxyBypassRules: 'late.example' })
    await second
    releaseFirstApply()
    await first

    expect(applyBrowserSessionProxiesMock.mock.calls.map((call) => call[1])).toEqual([
      {
        httpProxyUrl: 'socks5://127.0.0.1:1080',
        httpProxyBypassRules: ''
      },
      {
        httpProxyUrl: 'socks5://127.0.0.1:1080',
        httpProxyBypassRules: 'late.example'
      }
    ])
  })

  it('orders proxy writes before unrelated settings reconciliation can suspend', async () => {
    store.getSettings.mockReturnValue({
      httpProxyUrl: '',
      httpProxyBypassRules: '',
      agentStatusHooksEnabled: false,
      disabledTuiAgents: []
    })
    store.updateSettings.mockImplementation((args) => ({
      httpProxyUrl: args.httpProxyUrl,
      httpProxyBypassRules: '',
      agentStatusHooksEnabled: args.agentStatusHooksEnabled ?? true,
      disabledTuiAgents: []
    }))
    let releaseHookReconciliation = (): void => {}
    let markHookReconciliationStarted = (): void => {}
    const hookReconciliationStarted = new Promise<void>(
      (resolve) => (markHookReconciliationStarted = resolve)
    )
    applyAgentStatusHooksEnabledMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseHookReconciliation = () => resolve([])
          markHookReconciliationStarted()
        })
    )
    registerSettingsHandlers(store as never)
    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      event: typeof settingsInvokeEvent,
      args: { httpProxyUrl: string; agentStatusHooksEnabled?: boolean }
    ) => Promise<unknown>

    const first = handler(settingsInvokeEvent, {
      httpProxyUrl: 'http://old.example:8080',
      agentStatusHooksEnabled: true
    })
    await hookReconciliationStarted
    await handler(settingsInvokeEvent, { httpProxyUrl: 'http://new.example:8080' })
    releaseHookReconciliation()
    await first

    expect(applyElectronProxySettingsMock.mock.calls.map((call) => call[0].httpProxyUrl)).toEqual([
      'http://old.example:8080',
      'http://new.example:8080'
    ])
  })

  it('drops invalid proxy URLs at the settings boundary', async () => {
    store.getSettings.mockReturnValue({ httpProxyUrl: 'http://proxy.example:8080' })
    store.updateSettings.mockReturnValue({ httpProxyUrl: '' })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { httpProxyUrl: 'ftp://proxy.example:2121' })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { httpProxyUrl: '' },
      { notifyListeners: true, originWebContentsId: 1 }
    )
    expect(applyElectronProxySettingsMock).toHaveBeenCalledWith({ httpProxyUrl: '' })
  })
})
