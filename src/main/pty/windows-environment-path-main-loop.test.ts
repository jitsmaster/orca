import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetPersistedWindowsPathCacheForTests,
  readPersistedWindowsPathSegments
} from './windows-environment-path'
import { __setWindowsPathRegistryLoaderForTests } from './windows-path-registry-reader'

const CREATE_PROCESS_DELAY_MS = 160
const delayedExecFileSync = vi.hoisted(() =>
  vi.fn(() => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CREATE_PROCESS_DELAY_MS)
    return '    Path    REG_EXPAND_SZ    C:\\Delayed'
  })
)

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: delayedExecFileSync
}))

describe('persisted Windows PATH process creation', () => {
  afterEach(() => {
    __resetPersistedWindowsPathCacheForTests()
    __setWindowsPathRegistryLoaderForTests()
    delayedExecFileSync.mockClear()
  })

  it('keeps the main loop responsive when child creation is delayed', async () => {
    __setWindowsPathRegistryLoaderForTests(() => ({
      HK: { LM: 1, CU: 2 },
      getRegistryKey: (root) => ({
        Path: { type: 1, value: root === 1 ? 'C:\\Machine' : 'C:\\User' }
      })
    }))
    let lastTick = performance.now()
    let maxGapMs = 0
    const timer = setInterval(() => {
      const now = performance.now()
      maxGapMs = Math.max(maxGapMs, now - lastTick - 5)
      lastTick = now
    }, 5)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const startedAt = performance.now()
    const segments = readPersistedWindowsPathSegments({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' }
    })
    const callMs = performance.now() - startedAt
    await new Promise((resolve) => setTimeout(resolve, 20))
    clearInterval(timer)

    expect(segments).toEqual(['C:\\Machine', 'C:\\User'])
    expect(delayedExecFileSync).not.toHaveBeenCalled()
    expect(callMs).toBeLessThan(CREATE_PROCESS_DELAY_MS / 2)
    expect(maxGapMs).toBeLessThan(CREATE_PROCESS_DELAY_MS / 2)
  })
})
