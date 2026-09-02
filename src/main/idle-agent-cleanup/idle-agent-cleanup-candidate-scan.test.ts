import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

const { getFreshProcessTableSnapshotMock } = vi.hoisted(() => ({
  getFreshProcessTableSnapshotMock: vi.fn()
}))

const { killOrphanedAgentProcessByPidMock } = vi.hoisted(() => ({
  killOrphanedAgentProcessByPidMock: vi.fn()
}))

// Resolution E: platform-branch reads go through getFreshProcessTableSnapshot on
// POSIX; tests below force darwin and mock only that reader.
vi.mock('../../shared/process-table-snapshot', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, getFreshProcessTableSnapshot: getFreshProcessTableSnapshotMock }
})

// Only the actual OS-level kill (file 6) is mocked. `killVerifiedOrphanedAgentProcess`
// — this file's own re-verify/skip decision — is exercised for real via the
// mocked verify-scan rows below, so the PID-reuse guard gets genuine coverage
// rather than being mocked away.
vi.mock('./idle-agent-process-kill', () => ({
  killOrphanedAgentProcessByPid: killOrphanedAgentProcessByPidMock
}))

import {
  killVerifiedOrphanedAgentProcess,
  runIdleAgentCleanupTick
} from './idle-agent-cleanup-candidate-scan'
import { DEFAULT_RETENTION_GRACE_MS } from './pane-close-descendant-retention'
import { collectPaneDescendantPids } from './pane-descendant-observation'
import {
  paneObservedDescendants,
  retainedClosedPaneDescendants
} from './pane-descendant-tracking-state'

type MinimalSettings = { idleAgentCleanupEnabled: boolean }
// Test-bug fix: an uninstantiated `ReturnType<typeof vi.fn>` resolves T to
// vi.fn's constraint (`Procedure | Constructable`), and distributing Mock<T>'s
// conditional type over that union yields a branch with only a construct
// signature and no call signature — the type becomes structurally uncallable
// in TS regardless of any production signature. Instantiating vi.fn's type
// param with the real record signature keeps the same runtime mock (still
// `vi.fn()` below) while producing a genuinely callable type.
type MinimalLog = {
  record: ReturnType<typeof vi.fn<(entry: unknown) => Promise<void>>>
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function row(pid: number, ppid: number, command: string): ProcessTableRow {
  return { pid, ppid, stat: 'S', command }
}

let platform: PropertyDescriptor | undefined
let settings: MinimalSettings
let log: MinimalLog

beforeEach(() => {
  paneObservedDescendants.clear()
  retainedClosedPaneDescendants.clear()
  getFreshProcessTableSnapshotMock.mockReset()
  killOrphanedAgentProcessByPidMock.mockReset()
  settings = { idleAgentCleanupEnabled: true }
  log = { record: vi.fn(), flush: vi.fn() }
  platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (platform) {
    Object.defineProperty(process, 'platform', platform)
  }
})

describe('runIdleAgentCleanupTick', () => {
  it('never treats a live (still-open) pane descendant as a candidate, even when it is orphaned and matches a signature — only a closed pane is in scope', async () => {
    // A daemonizing descendant (an MCP server, a dev server, anything that
    // double-forks) legitimately detaches from its shell while the pane is
    // still open and in active use. That must never be read as "left running
    // after the pane closed" just because it stopped being reachable.
    paneObservedDescendants.set('pane-1', {
      paneId: 'pane-1',
      rootCommandLine: 'bash -l --claude',
      shellPid: 100,
      descendantPids: new Set([101]),
      observedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([
      row(1, 0, 'init'),
      row(101, 1, 'node claude-cli') // orphaned (reparented to init) and signature-matched -- but pane-1 is still open
    ])

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('never treats a live pane descendant that is still parented (a real parent-child chain rooted at shellPid) as a candidate', async () => {
    retainedClosedPaneDescendants.set('pane-1-closed', {
      paneId: 'pane-1-closed',
      rootCommandLine: 'bash -l --claude',
      shellPid: 100,
      descendantPids: new Set([101]),
      retainedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([
      row(1, 0, 'init'),
      row(100, 1, 'bash -l --claude'),
      row(101, 100, 'node claude-cli') // still a live descendant of its own shellPid (100)
    ])

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('treats a descendant reparented to a live subreaper (e.g. pid 1) as orphaned, not "still parented" — presence of ANY row at ppid must not suffice', async () => {
    retainedClosedPaneDescendants.set('pane-10', {
      paneId: 'pane-10',
      rootCommandLine: 'bash -l --claude',
      shellPid: 100,
      descendantPids: new Set([101]),
      retainedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([
      row(1, 0, 'init'), // a present subreaper -- but NOT this descendant's tracked shellPid (100)
      row(101, 1, 'node claude-cli') // reparented to init, not back to its own shell
    ])
    killOrphanedAgentProcessByPidMock.mockResolvedValue('killed')

    await runIdleAgentCleanupTick(settings, log)

    // A check that only asks "is ANY row present at ppid" would see pid 1 and
    // wrongly call this "still parented". The fix requires reachability from
    // the descendant's own tracked shellPid (100), which pid 1 is not.
    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledWith(101)
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 101, outcome: 'killed' })
    )
  })

  it('never treats an orphaned retained descendant that matches no registered signature as a candidate', async () => {
    retainedClosedPaneDescendants.set('pane-1b', {
      paneId: 'pane-1b',
      rootCommandLine: 'bash -l',
      shellPid: 100,
      descendantPids: new Set([101]),
      retainedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([
      row(101, 999, 'python unrelated.py') // not reachable from shellPid 100 -> orphaned, but no signature match
    ])

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('treats a retained (closed-pane) descendant still within grace, orphaned, matching a signature as a candidate', async () => {
    retainedClosedPaneDescendants.set('pane-2', {
      paneId: 'pane-2',
      rootCommandLine: 'bash -l --claude',
      shellPid: 200,
      descendantPids: new Set([201]),
      retainedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([row(201, 999, 'node claude-cli')])
    killOrphanedAgentProcessByPidMock.mockResolvedValue('killed')

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledWith(201)
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 201, outcome: 'killed' })
    )
  })

  it('never treats a retained descendant past its grace period as a candidate — it was already evicted before candidate-building', async () => {
    retainedClosedPaneDescendants.set('pane-3', {
      paneId: 'pane-3',
      rootCommandLine: 'bash -l --claude',
      shellPid: 300,
      descendantPids: new Set([301]),
      retainedAtMs: Date.now() - (DEFAULT_RETENTION_GRACE_MS + 1)
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([row(301, 999, 'node claude-cli')])

    await runIdleAgentCleanupTick(settings, log)

    expect(retainedClosedPaneDescendants.has('pane-3')).toBe(false)
    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('treats the same pid tracked by two DIFFERENT closed panes as ambiguous and kills neither (a recycled pid must never resolve to "kill it")', async () => {
    retainedClosedPaneDescendants.set('pane-4a', {
      paneId: 'pane-4a',
      rootCommandLine: 'bash -l --claude',
      shellPid: 400,
      descendantPids: new Set([401]),
      retainedAtMs: Date.now()
    })
    retainedClosedPaneDescendants.set('pane-4b', {
      paneId: 'pane-4b',
      rootCommandLine: 'bash -l --claude',
      shellPid: 450,
      descendantPids: new Set([401]),
      retainedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([row(401, 999, 'node claude-cli')])

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('aborts the whole tick with no partial kills and no false log entries when the candidate-building process-table read fails', async () => {
    retainedClosedPaneDescendants.set('pane-5', {
      paneId: 'pane-5',
      rootCommandLine: 'bash -l --claude',
      shellPid: 500,
      descendantPids: new Set([501]),
      retainedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockRejectedValue(new Error('process table unavailable'))

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('performs exactly one shared fresh scan for the whole kill phase, regardless of candidate count', async () => {
    retainedClosedPaneDescendants.set('pane-6', {
      paneId: 'pane-6',
      rootCommandLine: 'bash -l --claude',
      shellPid: 600,
      descendantPids: new Set([601, 602, 603]),
      retainedAtMs: Date.now()
    })
    const rows = [
      row(601, 999, 'node claude-cli'),
      row(602, 999, 'node claude-cli'),
      row(603, 999, 'node claude-cli')
    ]
    getFreshProcessTableSnapshotMock.mockResolvedValue(rows)
    killOrphanedAgentProcessByPidMock.mockResolvedValue('killed')

    await runIdleAgentCleanupTick(settings, log)

    // 1 candidate-building scan + 1 shared verify scan = 2, not 1-per-candidate.
    expect(getFreshProcessTableSnapshotMock).toHaveBeenCalledTimes(2)
    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledTimes(3)
  })

  it('aborts the whole kill phase with no partial kills and no log entries when the shared verify scan fails (mirrors the candidate-building scan failure rule)', async () => {
    retainedClosedPaneDescendants.set('pane-7', {
      paneId: 'pane-7',
      rootCommandLine: 'bash -l --claude',
      shellPid: 700,
      descendantPids: new Set([701]),
      retainedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock
      .mockResolvedValueOnce([row(701, 999, 'node claude-cli')]) // candidate-building scan
      .mockRejectedValueOnce(new Error('verify scan unavailable')) // shared verify scan

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('skips a candidate re-parented back to its own shell by the time of the SHARED verify scan', async () => {
    retainedClosedPaneDescendants.set('pane-8', {
      paneId: 'pane-8',
      rootCommandLine: 'bash -l --claude',
      shellPid: 800,
      descendantPids: new Set([801]),
      retainedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock
      .mockResolvedValueOnce([row(801, 999, 'node claude-cli')]) // candidate-building: orphaned + matches
      .mockResolvedValueOnce([
        row(800, 1, 'bash -l --claude'), // its own shell, alive again
        row(801, 800, 'node claude-cli') // and 801 is once more its descendant
      ])

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('skips the verify scan entirely when candidates.length === 0 (no wasted scan when there is nothing to kill)', async () => {
    // No tracked descendants at all -> zero candidates.
    getFreshProcessTableSnapshotMock.mockResolvedValue([row(1, 0, 'init')])

    await runIdleAgentCleanupTick(settings, log)

    expect(getFreshProcessTableSnapshotMock).toHaveBeenCalledTimes(1)
    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
  })

  it('a log.record() rejection for one candidate does not abort killing the rest of the tick', async () => {
    retainedClosedPaneDescendants.set('pane-11a', {
      paneId: 'pane-11a',
      rootCommandLine: 'bash -l --claude',
      shellPid: 1100,
      descendantPids: new Set([1101]),
      retainedAtMs: Date.now()
    })
    retainedClosedPaneDescendants.set('pane-11b', {
      paneId: 'pane-11b',
      rootCommandLine: 'bash -l --claude',
      shellPid: 1200,
      descendantPids: new Set([1201]),
      retainedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([
      row(1101, 999, 'node claude-cli'),
      row(1201, 999, 'node claude-cli')
    ])
    killOrphanedAgentProcessByPidMock.mockResolvedValue('killed')
    log.record = vi
      .fn()
      .mockRejectedValueOnce(new Error('log write failed'))
      .mockResolvedValueOnce(undefined)

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledWith(1101)
    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledWith(1201)
    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledTimes(2)
  })

  it('kills an orphaned, signature-matched descendant reported by a daemon-hosted pane, merged in via fetchDaemonRetainedPaneDescendants', async () => {
    // The daemon runs as a separate OS process -- its own retention map is
    // never visible here, so this is the only path that can ever surface a
    // daemon-hosted pane's retained descendants to this tick.
    getFreshProcessTableSnapshotMock.mockResolvedValue([row(1301, 999, 'node claude-cli')])
    killOrphanedAgentProcessByPidMock.mockResolvedValue('killed')
    const fetchDaemonRetainedPaneDescendants = vi.fn().mockResolvedValue([
      {
        paneId: 'daemon-pane-1',
        descendantPids: [1301],
        rootCommandLine: 'bash -l --claude',
        shellPid: 1300,
        retainedAtMs: Date.now()
      }
    ])

    await runIdleAgentCleanupTick(settings, log, { fetchDaemonRetainedPaneDescendants })

    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledWith(1301)
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 1301, paneId: 'daemon-pane-1', outcome: 'killed' })
    )
  })

  it('drops a daemon-reported retained record past its own grace period, the same as a locally-tracked one', async () => {
    getFreshProcessTableSnapshotMock.mockResolvedValue([row(1401, 999, 'node claude-cli')])
    const fetchDaemonRetainedPaneDescendants = vi.fn().mockResolvedValue([
      {
        paneId: 'daemon-pane-2',
        descendantPids: [1401],
        rootCommandLine: 'bash -l --claude',
        shellPid: 1400,
        retainedAtMs: Date.now() - (DEFAULT_RETENTION_GRACE_MS + 1)
      }
    ])

    await runIdleAgentCleanupTick(settings, log, { fetchDaemonRetainedPaneDescendants })

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('proceeds with local-pty-only candidates when fetchDaemonRetainedPaneDescendants is omitted', async () => {
    retainedClosedPaneDescendants.set('pane-12', {
      paneId: 'pane-12',
      rootCommandLine: 'bash -l --claude',
      shellPid: 1500,
      descendantPids: new Set([1501]),
      retainedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([row(1501, 999, 'node claude-cli')])
    killOrphanedAgentProcessByPidMock.mockResolvedValue('killed')

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledWith(1501)
  })
})

describe('killVerifiedOrphanedAgentProcess', () => {
  const candidate = {
    pid: 901,
    command: 'node claude-cli',
    agentName: 'Claude Code',
    paneId: 'pane-9',
    rootCommandLine: 'bash -l --claude',
    shellPid: 900
  }

  // Builds the same (verifyByPid, reachableFromShell) pair
  // runIdleAgentCleanupTick precomputes once per tick and passes into every
  // call, so these direct-call tests exercise the real signature.
  function buildVerifyLookup(
    verifyRows: ReturnType<typeof row>[]
  ): [Map<number, ReturnType<typeof row>>, (shellPid: number) => ReadonlySet<number>] {
    const verifyByPid = new Map(verifyRows.map((r) => [r.pid, r]))
    const reachableFromShell = (shellPid: number): ReadonlySet<number> =>
      new Set(collectPaneDescendantPids(verifyRows, shellPid))
    return [verifyByPid, reachableFromShell]
  }

  it('proceeds to kill when the pid still matches its OWN signature at re-verify time', async () => {
    const [verifyByPid, reachableFromShell] = buildVerifyLookup([row(901, 999, 'node claude-cli')])
    killOrphanedAgentProcessByPidMock.mockResolvedValue('killed')

    await expect(
      killVerifiedOrphanedAgentProcess(candidate, verifyByPid, reachableFromShell)
    ).resolves.toBe('killed')
    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledWith(901)
  })

  it('skips without killing when the pid is reachable from its own shellPid again at re-verify time (re-parented back to its own shell)', async () => {
    const [verifyByPid, reachableFromShell] = buildVerifyLookup([
      row(900, 1, 'bash -l --claude'),
      row(901, 900, 'node claude-cli')
    ])

    await expect(
      killVerifiedOrphanedAgentProcess(candidate, verifyByPid, reachableFromShell)
    ).resolves.toBe('skipped')
    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
  })

  it('skips when the pid no longer matches ANY signature at re-verify time (recycled to something unrelated)', async () => {
    // Test-bug fix: the shared `candidate` fixture's rootCommandLine
    // ('bash -l --claude') carries the 'claude' substring, so the
    // pane-lineage fallback would still resolve 'python unrelated.py' to the
    // Claude Code signature through the pane root, defeating this test's own
    // premise of "no longer matches ANY signature". A candidate with a
    // lineage-free root command line is needed to genuinely exercise this.
    const unrelatedLineageCandidate = { ...candidate, rootCommandLine: 'bash -l' }
    const [verifyByPid, reachableFromShell] = buildVerifyLookup([
      row(901, 999, 'python unrelated.py')
    ])

    await expect(
      killVerifiedOrphanedAgentProcess(unrelatedLineageCandidate, verifyByPid, reachableFromShell)
    ).resolves.toBe('skipped')
    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
  })

  it('skips when the pid now matches a DIFFERENT signature than at candidate time (changed identity, do not kill)', async () => {
    const [verifyByPid, reachableFromShell] = buildVerifyLookup([row(901, 999, 'node codex-cli')])

    await expect(
      killVerifiedOrphanedAgentProcess(candidate, verifyByPid, reachableFromShell)
    ).resolves.toBe('skipped')
    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
  })

  it('skips a fallback-only-matched candidate (own command line matches no signature) when the live command line has changed since build time — the pane-root fallback would otherwise rubber-stamp any recycled pid', async () => {
    // find.exe-style candidate: no signature of its own, matched only through
    // rootCommandLine at build time. At verify time the live command line is
    // NOT byte-identical to what was captured -> must not be trusted.
    const fallbackMatchedCandidate = { ...candidate, command: 'find . -iname "*.md"' }
    const [verifyByPid, reachableFromShell] = buildVerifyLookup([
      row(901, 999, 'find . -iname "*.txt"') // same pid, subtly different command line
    ])

    await expect(
      killVerifiedOrphanedAgentProcess(fallbackMatchedCandidate, verifyByPid, reachableFromShell)
    ).resolves.toBe('skipped')
    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
  })

  it('kills a fallback-only-matched candidate when the live command line is still byte-identical to build time', async () => {
    const fallbackMatchedCandidate = { ...candidate, command: 'find . -iname "*.md"' }
    const [verifyByPid, reachableFromShell] = buildVerifyLookup([
      row(901, 999, 'find . -iname "*.md"') // unchanged
    ])
    killOrphanedAgentProcessByPidMock.mockResolvedValue('killed')

    await expect(
      killVerifiedOrphanedAgentProcess(fallbackMatchedCandidate, verifyByPid, reachableFromShell)
    ).resolves.toBe('killed')
    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledWith(901)
  })

  it('skips when Windows creation time is present on both sides and differs, even though the command line is byte-identical (pid recycled to a relaunch of the same command)', async () => {
    const winCandidate = { ...candidate, creationTimeMs: 1_000 }
    const verifyByPid = new Map([
      [901, { pid: 901, ppid: 999, command: 'node claude-cli', creationTimeMs: 2_000 }]
    ])
    const reachableFromShell = (): ReadonlySet<number> => new Set()

    await expect(
      killVerifiedOrphanedAgentProcess(winCandidate, verifyByPid, reachableFromShell)
    ).resolves.toBe('skipped')
    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
  })

  it('kills when Windows creation time is present on both sides and matches', async () => {
    const winCandidate = { ...candidate, creationTimeMs: 1_000 }
    const verifyByPid = new Map([
      [901, { pid: 901, ppid: 999, command: 'node claude-cli', creationTimeMs: 1_000 }]
    ])
    const reachableFromShell = (): ReadonlySet<number> => new Set()
    killOrphanedAgentProcessByPidMock.mockResolvedValue('killed')

    await expect(
      killVerifiedOrphanedAgentProcess(winCandidate, verifyByPid, reachableFromShell)
    ).resolves.toBe('killed')
    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledWith(901)
  })
})
