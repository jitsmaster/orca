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

describe('registerSettingsHandlers terminal and mobile-pairing normalization', () => {
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

  it('normalizes terminal scrollback row updates and drops legacy byte updates', async () => {
    store.getSettings.mockReturnValue({ terminalScrollbackRows: 5_000 })
    store.updateSettings.mockReturnValue({ terminalScrollbackRows: 50_000 })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, {
      terminalScrollbackRows: 75_000,
      terminalScrollbackBytes: 250_000_000
    })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { terminalScrollbackRows: 50_000 },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('normalizes terminal line height updates before persistence', async () => {
    store.getSettings.mockReturnValue({ terminalLineHeight: 1 })
    store.updateSettings.mockReturnValue({ terminalLineHeight: 1 })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { terminalLineHeight: 0.85 })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { terminalLineHeight: 1 },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('normalizes custom mobile pairing addresses before persistence', async () => {
    store.getSettings.mockReturnValue({
      mobilePairingCustomAddress: null,
      mobilePairingCustomAddresses: []
    })
    store.updateSettings.mockReturnValue({
      mobilePairingCustomAddress: '100.126.117.25:6768',
      mobilePairingCustomAddresses: ['first.example:6768']
    })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, {
      mobilePairingCustomAddress: ' 100.126.117.25:6768 ',
      mobilePairingCustomAddresses: [' first.example:6768 ', 'host:99999', 'first.example:6768']
    })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {
        mobilePairingCustomAddress: '100.126.117.25:6768',
        mobilePairingCustomAddresses: ['first.example:6768']
      },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('clears malformed custom mobile pairing addresses before persistence', async () => {
    store.getSettings.mockReturnValue({ mobilePairingCustomAddress: '100.126.117.25:6768' })
    store.updateSettings.mockReturnValue({ mobilePairingCustomAddress: null })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, { mobilePairingCustomAddress: 'host:99999' })

    expect(store.updateSettings).toHaveBeenCalledWith(
      { mobilePairingCustomAddress: null },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })

  it('normalizes custom terminal themes from renderer settings IPC', async () => {
    store.getSettings.mockReturnValue({ terminalCustomThemes: [] })
    store.updateSettings.mockReturnValue({ terminalCustomThemes: [] })
    registerSettingsHandlers(store as never)

    const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1] as (
      _event: unknown,
      args: unknown
    ) => Promise<unknown>

    await handler(settingsInvokeEvent, {
      terminalCustomThemes: [
        {
          id: 'warp:Test Theme',
          name: 'Test Theme',
          source: 'warp',
          mode: 'dark',
          terminal: {
            background: '000',
            foreground: 'fff',
            black: '123',
            red: 'nope'
          },
          sourcePath: '/Users/alice/.warp/themes/test.yaml'
        }
      ]
    })

    expect(store.updateSettings).toHaveBeenCalledWith(
      {
        terminalCustomThemes: [
          expect.objectContaining({
            id: 'warp:test-theme',
            terminal: {
              background: '#000000',
              foreground: '#ffffff',
              black: '#112233'
            }
          })
        ]
      },
      { notifyListeners: true, originWebContentsId: 1 }
    )
  })
})
