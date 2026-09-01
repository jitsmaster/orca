// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { join } from 'node:path'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS,
  type IdleAgentCleanupLogEntry
} from '../../../../shared/idle-agent-cleanup-log-entry'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

// Real Radix Select relies on a popover/portal that happy-dom cannot drive
// reliably (no pointer capture, no layout). Mirror ExperimentalPane.test.tsx's
// convention: swap in a plain-DOM stand-in so onValueChange wiring is
// verifiable without fighting the popover.
vi.mock('../ui/select', async () => {
  const React = await import('react')
  const SelectContext = React.createContext<{ onValueChange?: (value: string) => void }>({})

  return {
    Select: ({
      value,
      onValueChange,
      children
    }: {
      value: string
      onValueChange: (value: string) => void
      children: React.ReactNode
    }) => {
      const contextValue = React.useMemo(() => ({ onValueChange }), [onValueChange])
      return (
        <SelectContext.Provider value={contextValue}>
          <div data-slot="idle-agent-cleanup-interval-select" data-value={value}>
            {children}
          </div>
        </SelectContext.Provider>
      )
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<'button'> & { size?: string }) => (
      <button type="button" data-slot="select-trigger" {...props}>
        {children}
      </button>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div data-slot="select-content">{children}</div>
    ),
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const { onValueChange } = React.useContext(SelectContext)
      return (
        <button
          type="button"
          data-slot="select-item"
          data-value={value}
          onClick={() => onValueChange?.(value)}
        >
          {children}
        </button>
      )
    }
  }
})

import { IdleAgentCleanupSection } from './IdleAgentCleanupSection'

function makeEntry(overrides: Partial<IdleAgentCleanupLogEntry> = {}): IdleAgentCleanupLogEntry {
  return {
    pid: 1000,
    command: 'claude --resume some-very-long-session-id-that-should-be-truncated',
    agentName: 'claude',
    timestamp: 1_700_000_000_000,
    outcome: 'killed',
    ...overrides
  }
}

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    ...getDefaultSettings(join('test', 'home')),
    idleAgentCleanupEnabled: false,
    idleAgentCleanupIntervalMs: 300_000,
    ...overrides
  }
}

describe('IdleAgentCleanupSection', () => {
  let getRecentActivity: ReturnType<typeof vi.fn>
  let onActivityChanged: ReturnType<typeof vi.fn>
  let unsubscribeMock: ReturnType<typeof vi.fn>
  let capturedActivityCallback: ((entries: IdleAgentCleanupLogEntry[]) => void) | undefined

  beforeEach(() => {
    capturedActivityCallback = undefined
    unsubscribeMock = vi.fn()
    getRecentActivity = vi.fn().mockResolvedValue([])
    onActivityChanged = vi.fn((callback: (entries: IdleAgentCleanupLogEntry[]) => void) => {
      capturedActivityCallback = callback
      return unsubscribeMock
    })

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        idleAgentCleanup: {
          getRecentActivity,
          onActivityChanged
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('fetches recent activity on mount and renders the resolved entries', async () => {
    getRecentActivity.mockResolvedValue([makeEntry({ agentName: 'codex', pid: 4242 })])

    render(<IdleAgentCleanupSection settings={makeSettings()} updateSettings={vi.fn()} />)

    expect(getRecentActivity).toHaveBeenCalledTimes(1)
    // Contract: each recently-cleaned row is a
    // data-testid="idle-agent-cleanup-entry" element whose text content
    // includes at least the agentName and pid.
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid="idle-agent-cleanup-entry"]')).toHaveLength(1)
    )
    const row = document.querySelector('[data-testid="idle-agent-cleanup-entry"]')
    expect(row?.textContent).toContain('codex')
    expect(row?.textContent).toContain('4242')
  })

  it('renders an empty state when there are zero recently-cleaned entries', async () => {
    getRecentActivity.mockResolvedValue([])

    render(<IdleAgentCleanupSection settings={makeSettings()} updateSettings={vi.fn()} />)

    await waitFor(() => expect(getRecentActivity).toHaveBeenCalledTimes(1))
    // Fallback text for settings.idleAgentCleanup.emptyState — the GREEN-phase
    // implementation must render exactly this English fallback.
    expect(await screen.findByText('No idle agent processes cleaned up yet.')).toBeInTheDocument()
  })

  it('caps the rendered recently-cleaned rows at IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS', async () => {
    const manyEntries = Array.from({ length: IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS + 10 }, (_, i) =>
      makeEntry({ pid: 10_000 + i, agentName: `agent-${i}` })
    )
    getRecentActivity.mockResolvedValue(manyEntries)

    render(<IdleAgentCleanupSection settings={makeSettings()} updateSettings={vi.fn()} />)

    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="idle-agent-cleanup-entry"]').length
      ).toBeGreaterThan(0)
    )
    expect(document.querySelectorAll('[data-testid="idle-agent-cleanup-entry"]')).toHaveLength(
      IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS
    )
  })

  it('updates the rendered list when the onActivityChanged push callback fires, without re-fetching', async () => {
    getRecentActivity.mockResolvedValue([makeEntry({ agentName: 'claude', pid: 1 })])

    render(<IdleAgentCleanupSection settings={makeSettings()} updateSettings={vi.fn()} />)

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="idle-agent-cleanup-entry"]')?.textContent
      ).toContain('claude')
    )
    expect(getRecentActivity).toHaveBeenCalledTimes(1)
    expect(capturedActivityCallback).toBeTypeOf('function')

    capturedActivityCallback?.([makeEntry({ agentName: 'codex-pushed', pid: 999 })])

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="idle-agent-cleanup-entry"]')?.textContent
      ).toContain('codex-pushed')
    )
    expect(getRecentActivity).toHaveBeenCalledTimes(1)
  })

  it('calls the unsubscribe function returned by onActivityChanged when unmounted', async () => {
    getRecentActivity.mockResolvedValue([])

    const { unmount } = render(
      <IdleAgentCleanupSection settings={makeSettings()} updateSettings={vi.fn()} />
    )

    await waitFor(() => expect(onActivityChanged).toHaveBeenCalledTimes(1))
    expect(unsubscribeMock).not.toHaveBeenCalled()

    unmount()

    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it('toggling the switch calls updateSettings with the flipped enabled boolean', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn()
    getRecentActivity.mockResolvedValue([])

    render(
      <IdleAgentCleanupSection
        settings={makeSettings({ idleAgentCleanupEnabled: false })}
        updateSettings={updateSettings}
      />
    )
    await waitFor(() => expect(getRecentActivity).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('switch'))

    expect(updateSettings).toHaveBeenCalledWith({ idleAgentCleanupEnabled: true })
  })

  it('does not render the interval control while cleanup is disabled', async () => {
    getRecentActivity.mockResolvedValue([])

    render(
      <IdleAgentCleanupSection
        settings={makeSettings({ idleAgentCleanupEnabled: false })}
        updateSettings={vi.fn()}
      />
    )
    await waitFor(() => expect(getRecentActivity).toHaveBeenCalledTimes(1))

    expect(document.querySelector('[data-slot="idle-agent-cleanup-interval-select"]')).toBeNull()
  })

  it('renders the interval control when cleanup is enabled', async () => {
    getRecentActivity.mockResolvedValue([])

    render(
      <IdleAgentCleanupSection
        settings={makeSettings({ idleAgentCleanupEnabled: true })}
        updateSettings={vi.fn()}
      />
    )
    await waitFor(() => expect(getRecentActivity).toHaveBeenCalledTimes(1))

    expect(
      document.querySelector('[data-slot="idle-agent-cleanup-interval-select"]')
    ).not.toBeNull()
  })

  it('changing the interval select calls updateSettings with the numeric interval', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn()
    getRecentActivity.mockResolvedValue([])

    render(
      <IdleAgentCleanupSection
        settings={makeSettings({
          idleAgentCleanupEnabled: true,
          idleAgentCleanupIntervalMs: 300_000
        })}
        updateSettings={updateSettings}
      />
    )
    await waitFor(() => expect(getRecentActivity).toHaveBeenCalledTimes(1))

    const items = document.querySelectorAll<HTMLButtonElement>('[data-slot="select-item"]')
    expect(items.length).toBeGreaterThan(1)
    const differentItem = [...items].find((item) => item.getAttribute('data-value') !== '300000')
    expect(differentItem).toBeDefined()

    await user.click(differentItem!)

    expect(updateSettings).toHaveBeenCalledWith({
      idleAgentCleanupIntervalMs: expect.any(Number)
    })
    const [update] = updateSettings.mock.calls.at(-1) as [{ idleAgentCleanupIntervalMs: number }]
    expect(update.idleAgentCleanupIntervalMs).not.toBe(300_000)
  })
})
