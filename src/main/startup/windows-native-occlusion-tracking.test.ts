import { afterEach, describe, expect, it, vi } from 'vitest'

// Split out of configure-process.test.ts (capped for file size).
vi.mock('electron', () => {
  const paths = new Map<string, string>([['appData', '/tmp/app-data']])
  return {
    app: {
      getPath: vi.fn((name: string) => paths.get(name) ?? ''),
      setPath: vi.fn((name: string, value: string) => {
        paths.set(name, value)
      }),
      quit: vi.fn(),
      exit: vi.fn(),
      isPackaged: false,
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn(),
        getSwitchValue: vi.fn(() => '')
      }
    }
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('optOutOfWindowsNativeOcclusionTracking', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('disables native window-occlusion tracking on win32', async () => {
    const { app } = await import('electron')
    const { optOutOfWindowsNativeOcclusionTracking } = await import('./configure-process')

    setPlatform('win32')
    vi.mocked(app.commandLine.appendSwitch).mockClear()
    optOutOfWindowsNativeOcclusionTracking()

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith(
      'disable-features',
      'CalculateNativeWinOcclusion'
    )
  })

  it('does nothing on macOS/Linux', async () => {
    const { app } = await import('electron')
    const { optOutOfWindowsNativeOcclusionTracking } = await import('./configure-process')

    for (const platform of ['darwin', 'linux'] as const) {
      setPlatform(platform)
      vi.mocked(app.commandLine.appendSwitch).mockClear()
      optOutOfWindowsNativeOcclusionTracking()
      expect(app.commandLine.appendSwitch).not.toHaveBeenCalled()
    }
  })
})
