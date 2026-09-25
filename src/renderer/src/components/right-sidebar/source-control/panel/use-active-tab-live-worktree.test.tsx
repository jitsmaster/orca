// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type LiveWorktreeEvent = { paneKey: string; tabId: string; worktreeId: string }

let capturedCallback: ((event: LiveWorktreeEvent) => void) | null = null
const unsubscribeMock = vi.fn()

beforeEach(() => {
  capturedCallback = null
  unsubscribeMock.mockReset()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only global stub of the preload bridge.
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: {
      sourceControlLiveWorktree: {
        onSet: (callback: (event: LiveWorktreeEvent) => void) => {
          capturedCallback = callback
          return unsubscribeMock
        }
      }
    }
  }
})

const { useActiveTabLiveWorktreeId } = await import('./use-active-tab-live-worktree')

function Harness({ tabId }: { tabId: string | null }): React.JSX.Element {
  const worktreeId = useActiveTabLiveWorktreeId(tabId)
  return <span data-testid="worktree">{worktreeId ?? 'none'}</span>
}

afterEach(cleanup)

describe('useActiveTabLiveWorktreeId', () => {
  it('returns undefined until an event arrives for the given tab', () => {
    render(<Harness tabId="tab-1" />)
    expect(screen.getByTestId('worktree').textContent).toBe('none')
  })

  it('returns the worktreeId reported for the given tab', async () => {
    render(<Harness tabId="tab-1" />)
    capturedCallback?.({ paneKey: 'tab-1:leaf-a', tabId: 'tab-1', worktreeId: 'wt-feature' })
    await waitFor(
      () => {
        expect(screen.getByTestId('worktree').textContent).toBe('wt-feature')
      },
      { container: document as unknown as HTMLElement }
    )
  })

  it('ignores an event for a different tab', async () => {
    render(<Harness tabId="tab-1" />)
    capturedCallback?.({ paneKey: 'tab-2:leaf-a', tabId: 'tab-2', worktreeId: 'wt-other' })
    await waitFor(
      () => {
        expect(screen.getByTestId('worktree').textContent).toBe('none')
      },
      { container: document as unknown as HTMLElement }
    )
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<Harness tabId="tab-1" />)
    unmount()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })
})
