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
// — this file's own re-verify/skip decision, per architecture §4's pseudocode
// block co-locating it with runIdleAgentCleanupTick — is exercised for real via
// the mocked verify-scan rows below, so the PID-reuse guard (decision #9) gets
// genuine coverage rather than being mocked away. See the flagged ambiguity in
// the final summary: item 7's instructions say to mock "those two kill-path
// functions", which is internally inconsistent with its own opening clause that
// this file defines killVerifiedOrphanedAgentProcess.
vi.mock('./idle-agent-process-kill', () => ({
  killOrphanedAgentProcessByPid: killOrphanedAgentProcessByPidMock
}))

import {
  killVerifiedOrphanedAgentProcess,
  runIdleAgentCleanupTick
} from './idle-agent-cleanup-candidate-scan'
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
type MinimalLog = { record: ReturnType<typeof vi.fn<(entry: unknown) => Promise<void>>> }

function row(pid: number, ppid: number, command: string): ProcessTableRow {
  return { pid, ppid, stat: 'S', command }
}

function byPidMap(rows: ProcessTableRow[]): Map<number, ProcessTableRow> {
  return new Map(rows.map((r) => [r.pid, r]))
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
  log = { record: vi.fn() }
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
  it('never treats a live pane descendant that is still parented as a candidate', async () => {
    paneObservedDescendants.set('pane-1', {
      paneId: 'pane-1',
      rootCommandLine: 'bash -l --claude',
      descendantPids: new Set([101]),
      observedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([
      row(1, 0, 'init'),
      row(100, 1, 'bash -l --claude'),
      row(101, 100, 'node claude-cli') // ppid 100 is present -> still parented
    ])

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('never treats a live pane descendant that is orphaned but matches no registered signature as a candidate', async () => {
    paneObservedDescendants.set('pane-1', {
      paneId: 'pane-1',
      rootCommandLine: 'bash -l',
      descendantPids: new Set([101]),
      observedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([
      row(101, 999, 'python unrelated.py') // ppid 999 absent -> orphaned, but no signature match
    ])

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('treats a retained (closed-pane) descendant still within grace, orphaned, matching a signature as a candidate', async () => {
    retainedClosedPaneDescendants.set('pane-2', {
      paneId: 'pane-2',
      rootCommandLine: 'bash -l --claude',
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
      descendantPids: new Set([301]),
      retainedAtMs: Date.now() - (10 * 60_000 + 1)
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([row(301, 999, 'node claude-cli')])

    await runIdleAgentCleanupTick(settings, log)

    expect(retainedClosedPaneDescendants.has('pane-3')).toBe(false)
    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('dedupes by pid — the same pid tracked by two stale entries is only killed once', async () => {
    paneObservedDescendants.set('pane-4', {
      paneId: 'pane-4',
      rootCommandLine: 'bash -l --claude',
      descendantPids: new Set([401]),
      observedAtMs: Date.now()
    })
    retainedClosedPaneDescendants.set('pane-4-closed', {
      paneId: 'pane-4-closed',
      rootCommandLine: 'bash -l --claude',
      descendantPids: new Set([401]),
      retainedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockResolvedValue([row(401, 999, 'node claude-cli')])
    killOrphanedAgentProcessByPidMock.mockResolvedValue('killed')

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledTimes(1)
    expect(log.record).toHaveBeenCalledTimes(1)
  })

  it('aborts the whole tick with no partial kills and no false log entries when the candidate-building process-table read fails', async () => {
    paneObservedDescendants.set('pane-5', {
      paneId: 'pane-5',
      rootCommandLine: 'bash -l --claude',
      descendantPids: new Set([501]),
      observedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock.mockRejectedValue(new Error('process table unavailable'))

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('performs exactly one shared fresh scan for the whole kill phase, regardless of candidate count (architecture §4)', async () => {
    paneObservedDescendants.set('pane-6', {
      paneId: 'pane-6',
      rootCommandLine: 'bash -l --claude',
      descendantPids: new Set([601, 602, 603]),
      observedAtMs: Date.now()
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
    paneObservedDescendants.set('pane-7', {
      paneId: 'pane-7',
      rootCommandLine: 'bash -l --claude',
      descendantPids: new Set([701]),
      observedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock
      .mockResolvedValueOnce([row(701, 999, 'node claude-cli')]) // candidate-building scan
      .mockRejectedValueOnce(new Error('verify scan unavailable')) // shared verify scan

    await runIdleAgentCleanupTick(settings, log)

    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
    expect(log.record).not.toHaveBeenCalled()
  })

  it('skips a candidate re-parented or PID-recycled by the time of the SHARED verify scan', async () => {
    paneObservedDescendants.set('pane-8', {
      paneId: 'pane-8',
      rootCommandLine: 'bash -l --claude',
      descendantPids: new Set([801]),
      observedAtMs: Date.now()
    })
    getFreshProcessTableSnapshotMock
      .mockResolvedValueOnce([row(801, 999, 'node claude-cli')]) // candidate-building: orphaned + matches
      .mockResolvedValueOnce([row(1, 0, 'init'), row(801, 1, 'node claude-cli')]) // verify: now has a live parent

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
})

describe('killVerifiedOrphanedAgentProcess', () => {
  const candidate = {
    pid: 901,
    command: 'node claude-cli',
    agentName: 'Claude Code',
    paneId: 'pane-9',
    rootCommandLine: 'bash -l --claude'
  }

  it('proceeds to kill when the pid is still orphaned and still matches the same signature at re-verify time', async () => {
    const verifyByPid = byPidMap([row(901, 999, 'node claude-cli')])
    killOrphanedAgentProcessByPidMock.mockResolvedValue('killed')

    await expect(killVerifiedOrphanedAgentProcess(candidate, verifyByPid)).resolves.toBe('killed')
    expect(killOrphanedAgentProcessByPidMock).toHaveBeenCalledWith(901)
  })

  it('skips without killing when the pid now has a live parent at re-verify time (re-parented or recycled to a non-orphan)', async () => {
    const verifyByPid = byPidMap([row(1, 0, 'init'), row(901, 1, 'node claude-cli')])

    await expect(killVerifiedOrphanedAgentProcess(candidate, verifyByPid)).resolves.toBe('skipped')
    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
  })

  it('skips when the pid no longer matches ANY signature at re-verify time (recycled to something unrelated)', async () => {
    // Test-bug fix: the shared `candidate` fixture's rootCommandLine
    // ('bash -l --claude') carries the 'claude' substring, so the
    // pane-lineage fallback (idle-agent-cleanup-signatures.ts) would still
    // resolve 'python unrelated.py' to the Claude Code signature through the
    // pane root, defeating this test's own premise of "no longer matches ANY
    // signature". A candidate with a lineage-free root command line is
    // needed to genuinely exercise that scenario.
    const unrelatedLineageCandidate = { ...candidate, rootCommandLine: 'bash -l' }
    const verifyByPid = byPidMap([row(901, 999, 'python unrelated.py')])

    await expect(
      killVerifiedOrphanedAgentProcess(unrelatedLineageCandidate, verifyByPid)
    ).resolves.toBe('skipped')
    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
  })

  it('skips when the pid now matches a DIFFERENT signature than at candidate time (changed identity, do not kill)', async () => {
    const verifyByPid = byPidMap([row(901, 999, 'node codex-cli')])

    await expect(killVerifiedOrphanedAgentProcess(candidate, verifyByPid)).resolves.toBe('skipped')
    expect(killOrphanedAgentProcessByPidMock).not.toHaveBeenCalled()
  })
})
