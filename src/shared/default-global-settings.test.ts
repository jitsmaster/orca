import { describe, expect, it } from 'vitest'
import { buildDefaultSettings } from './default-global-settings'

function buildMinimalDefaultSettings(): ReturnType<typeof buildDefaultSettings> {
  return buildDefaultSettings({
    workspaceDir: '/workspace',
    appFontFamily: 'Inter',
    editorAutoSaveDelayMs: 1_000,
    primarySelectionMiddleClickPaste: false,
    primarySelectionDefaultedForLinux: false,
    terminalFontFamily: 'monospace',
    terminalInactivePaneOpacity: 1,
    terminalRightClickToPaste: false,
    notifications: {} as never,
    voice: {} as never
  })
}

describe('buildDefaultSettings — idle agent process cleanup defaults', () => {
  it('defaults idleAgentCleanupEnabled to false', () => {
    const settings = buildMinimalDefaultSettings()

    expect(settings.idleAgentCleanupEnabled).toBe(false)
  })

  it('defaults idleAgentCleanupIntervalMs to 300000 (5 minutes)', () => {
    const settings = buildMinimalDefaultSettings()

    expect(settings.idleAgentCleanupIntervalMs).toBe(300_000)
  })
})
