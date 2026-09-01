import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

const { getFreshProcessTableSnapshotMock } = vi.hoisted(() => ({
  getFreshProcessTableSnapshotMock: vi.fn()
}))

// Resolution E: POSIX reads go through getFreshProcessTableSnapshot; tests below
// force the darwin/posix branch and mock only that reader (see also
// windows-agent-foreground-process-scan-volume.test.ts for the platform-mocking
// precedent this mirrors).
vi.mock('../../shared/process-table-snapshot', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, getFreshProcessTableSnapshot: getFreshProcessTableSnapshotMock }
})

import {
  evictExpiredRetainedPanes,
  retainDescendantsOnPaneClose
} from './pane-close-descendant-retention'
import {
  paneObservedDescendants,
  retainedClosedPaneDescendants
} from './pane-descendant-tracking-state'

function row(pid: number, ppid: number, command: string): ProcessTableRow {
  return { pid, ppid, stat: 'S', command }
}

let platform: PropertyDescriptor | undefined

beforeEach(() => {
  paneObservedDescendants.clear()
  retainedClosedPaneDescendants.clear()
  getFreshProcessTableSnapshotMock.mockReset()
  platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (platform) {
    Object.defineProperty(process, 'platform', platform)
  }
})

describe('retainDescendantsOnPaneClose', () => {
  it('retains a live grandchild the fresh snapshot finds even when the last rolling observation missed it', async () => {
    paneObservedDescendants.set('pane-1', {
      paneId: 'pane-1',
      rootCommandLine: 'bash -l',
      descendantPids: new Set([101]),
      observedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([
      row(100, 1, 'bash -l'),
      row(101, 100, 'node childA'),
      row(102, 101, 'node grandchildB')
    ])

    await retainDescendantsOnPaneClose('pane-1', 100)

    const retained = retainedClosedPaneDescendants.get('pane-1')
    expect(retained?.descendantPids).toEqual(new Set([101, 102]))
  })

  it('falls back to the last rolling observation instead of retaining nothing when the fresh snapshot rejects', async () => {
    paneObservedDescendants.set('pane-1', {
      paneId: 'pane-1',
      rootCommandLine: 'bash -l',
      descendantPids: new Set([101, 102]),
      observedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockRejectedValue(new Error('process table unavailable'))

    await retainDescendantsOnPaneClose('pane-1', 100)

    const retained = retainedClosedPaneDescendants.get('pane-1')
    expect(retained?.descendantPids).toEqual(new Set([101, 102]))
  })

  it('does not retain a pane that had zero observed descendants at close time', async () => {
    paneObservedDescendants.set('pane-1', {
      paneId: 'pane-1',
      rootCommandLine: 'bash -l',
      descendantPids: new Set(),
      observedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([row(100, 1, 'bash -l')])

    await retainDescendantsOnPaneClose('pane-1', 100)

    expect(retainedClosedPaneDescendants.has('pane-1')).toBe(false)
  })

  it('stamps retainedAtMs at call time, not at eventual eviction', async () => {
    paneObservedDescendants.set('pane-1', {
      paneId: 'pane-1',
      rootCommandLine: 'bash -l',
      descendantPids: new Set([101]),
      observedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([
      row(100, 1, 'bash -l'),
      row(101, 100, 'node childA')
    ])

    const before = Date.now()
    await retainDescendantsOnPaneClose('pane-1', 100)
    const after = Date.now()

    const retained = retainedClosedPaneDescendants.get('pane-1')
    expect(retained?.retainedAtMs).toBeGreaterThanOrEqual(before)
    expect(retained?.retainedAtMs).toBeLessThanOrEqual(after)
  })

  it('takes rootCommandLine from the last rolling observation, not a post-close re-scan (the shell may already be gone)', async () => {
    paneObservedDescendants.set('pane-1', {
      paneId: 'pane-1',
      rootCommandLine: 'bash -l --agent claude',
      descendantPids: new Set([101]),
      observedAtMs: Date.now()
    })
    // The fresh snapshot no longer contains the shell row at all.
    getFreshProcessTableSnapshotMock.mockResolvedValue([row(101, 100, 'node childA')])

    await retainDescendantsOnPaneClose('pane-1', 100)

    const retained = retainedClosedPaneDescendants.get('pane-1')
    expect(retained?.rootCommandLine).toBe('bash -l --agent claude')
  })
})

describe('evictExpiredRetainedPanes', () => {
  const GRACE_MS = 10 * 60_000

  // Documented convention: nowMs - retainedAtMs > graceMs evicts (strictly
  // greater than) — an entry exactly at the boundary is retained.
  it('retains an entry exactly at the grace boundary and evicts one past it', () => {
    const now = 1_000_000_000
    retainedClosedPaneDescendants.set('at-boundary', {
      paneId: 'at-boundary',
      rootCommandLine: 'bash',
      descendantPids: new Set([1]),
      retainedAtMs: now - GRACE_MS
    })
    retainedClosedPaneDescendants.set('past-boundary', {
      paneId: 'past-boundary',
      rootCommandLine: 'bash',
      descendantPids: new Set([2]),
      retainedAtMs: now - GRACE_MS - 1
    })

    evictExpiredRetainedPanes(now)

    expect(retainedClosedPaneDescendants.has('at-boundary')).toBe(true)
    expect(retainedClosedPaneDescendants.has('past-boundary')).toBe(false)
  })
})
