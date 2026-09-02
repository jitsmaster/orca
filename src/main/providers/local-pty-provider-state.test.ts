import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'

const { retainDescendantsOnPaneCloseMock } = vi.hoisted(() => ({
  retainDescendantsOnPaneCloseMock: vi.fn()
}))

vi.mock('../idle-agent-cleanup/pane-close-descendant-retention', () => ({
  retainDescendantsOnPaneClose: retainDescendantsOnPaneCloseMock
}))

import { clearPtyState, ptyProcesses } from './local-pty-provider-state'

afterEach(() => {
  vi.restoreAllMocks()
  ptyProcesses.clear()
})

describe('clearPtyState', () => {
  it('logs a warning instead of throwing when retainDescendantsOnPaneClose rejects', async () => {
    const rejection = new Error('process table unavailable')
    retainDescendantsOnPaneCloseMock.mockRejectedValue(rejection)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ptyProcesses.set('pty-1', { pid: 555 } as unknown as pty.IPty)

    clearPtyState('pty-1')

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('[idle-agent-cleanup] retain-on-close failed', rejection)
    })
    expect(retainDescendantsOnPaneCloseMock).toHaveBeenCalledWith(
      'pty-1',
      555,
      expect.any(Function)
    )
  })

  it('passes an isStillCurrent check that reflects the live occupant of the pane id, not a snapshot taken at call time', async () => {
    retainDescendantsOnPaneCloseMock.mockResolvedValue(undefined)
    const proc = { pid: 555 } as unknown as pty.IPty
    ptyProcesses.set('pty-1', proc)

    clearPtyState('pty-1')

    await vi.waitFor(() => {
      expect(retainDescendantsOnPaneCloseMock).toHaveBeenCalled()
    })
    const isStillCurrent = retainDescendantsOnPaneCloseMock.mock.calls[0]?.[2] as () => boolean
    // clearPtyState already deleted its own entry synchronously -- "nothing has claimed
    // this id yet" is the expected, safe case and must pass.
    expect(isStillCurrent()).toBe(true)

    ptyProcesses.set('pty-1', { pid: 777 } as unknown as pty.IPty)
    // A respawn under the same id has since claimed it -- the stale scan must not proceed.
    expect(isStillCurrent()).toBe(false)
  })
})
