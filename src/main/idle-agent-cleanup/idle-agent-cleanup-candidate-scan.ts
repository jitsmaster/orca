import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'
import type { IdleAgentCleanupLogEntry } from '../../shared/idle-agent-cleanup-log-entry'
import { matchIdleAgentCleanupCandidate } from '../../shared/idle-agent-cleanup-signatures'
import { killOrphanedAgentProcessByPid } from './idle-agent-process-kill'
import { evictExpiredRetainedPanes } from './pane-close-descendant-retention'
import {
  paneObservedDescendants,
  retainedClosedPaneDescendants
} from './pane-descendant-tracking-state'

type IdleAgentCleanupTickSettings = { idleAgentCleanupEnabled: boolean }
type IdleAgentCleanupTickLog = { record(entry: IdleAgentCleanupLogEntry): Promise<void> }

/** Minimal row shape both POSIX (`ProcessTableRow`) and Windows (`WindowsProcessRow`) satisfy. */
type MinimalProcessRow = { pid: number; ppid: number; command: string }

type IdleAgentCleanupCandidate = {
  pid: number
  command: string
  agentName: string
  paneId: string
  rootCommandLine: string
}

type TrackedDescendant = { pid: number; paneId: string; rootCommandLine: string }

async function readFreshProcessTableRows(): Promise<MinimalProcessRow[]> {
  return process.platform === 'win32'
    ? readWindowsProcessTableFresh()
    : getFreshProcessTableSnapshot()
}

function indexByPid(rows: readonly MinimalProcessRow[]): Map<number, MinimalProcessRow> {
  return new Map(rows.map((row) => [row.pid, row]))
}

/** Union of every tracked descendant pid, live and retained, tagged with its owning pane. */
function collectTrackedDescendants(): TrackedDescendant[] {
  const tracked: TrackedDescendant[] = []
  for (const [paneId, observed] of paneObservedDescendants) {
    for (const pid of observed.descendantPids) {
      tracked.push({ pid, paneId, rootCommandLine: observed.rootCommandLine })
    }
  }
  for (const [paneId, retained] of retainedClosedPaneDescendants) {
    for (const pid of retained.descendantPids) {
      tracked.push({ pid, paneId, rootCommandLine: retained.rootCommandLine })
    }
  }
  return tracked
}

/** Orphaned + signature-matched tracked descendants, deduped by pid. */
function buildCandidates(byPid: Map<number, MinimalProcessRow>): IdleAgentCleanupCandidate[] {
  const candidatesByPid = new Map<number, IdleAgentCleanupCandidate>()
  for (const { pid, paneId, rootCommandLine } of collectTrackedDescendants()) {
    const row = byPid.get(pid)
    if (!row || byPid.has(row.ppid)) {
      continue // gone, or still parented -> not orphaned
    }
    const signature = matchIdleAgentCleanupCandidate(row.command, rootCommandLine)
    if (!signature) {
      continue // orphaned but not a recognized agent process
    }
    candidatesByPid.set(pid, {
      pid,
      command: row.command,
      agentName: signature.agentName,
      paneId,
      rootCommandLine
    })
  }
  return [...candidatesByPid.values()]
}

/** Re-verifies a candidate against the tick's shared verify snapshot before killing (decision #9). */
export async function killVerifiedOrphanedAgentProcess(
  candidate: IdleAgentCleanupCandidate,
  verifyByPid: Map<number, MinimalProcessRow>
): Promise<'killed' | 'kill-failed' | 'skipped'> {
  const row = verifyByPid.get(candidate.pid)
  if (!row) {
    return 'skipped' // gone since candidate-building
  }
  if (verifyByPid.has(row.ppid)) {
    return 'skipped' // re-parented since candidate-building
  }
  const signature = matchIdleAgentCleanupCandidate(row.command, candidate.rootCommandLine)
  if (signature?.agentName !== candidate.agentName) {
    // PID recycled to something unrelated, or to a different agent identity.
    return 'skipped'
  }
  return killOrphanedAgentProcessByPid(candidate.pid)
}

/**
 * Periodic cleanup tick (architecture §4's re-verify-scan delta): one fresh
 * scan builds candidates, then — only when there is at least one candidate —
 * a second shared fresh scan re-verifies the whole kill phase in one read
 * rather than one read per candidate.
 */
export async function runIdleAgentCleanupTick(
  settings: IdleAgentCleanupTickSettings,
  log: IdleAgentCleanupTickLog
): Promise<void> {
  if (!settings.idleAgentCleanupEnabled) {
    return
  }
  evictExpiredRetainedPanes(Date.now())

  let rows: MinimalProcessRow[]
  try {
    rows = await readFreshProcessTableRows()
  } catch {
    // Unavailable table must not be read as "nothing to clean" -- skip this tick.
    return
  }

  const candidates = buildCandidates(indexByPid(rows))
  if (candidates.length === 0) {
    return
  }

  let verifyByPid: Map<number, MinimalProcessRow>
  try {
    verifyByPid = indexByPid(await readFreshProcessTableRows())
  } catch {
    // Cannot re-verify anything this tick -> no kills, no log entries.
    return
  }

  for (const candidate of candidates) {
    const outcome = await killVerifiedOrphanedAgentProcess(candidate, verifyByPid)
    if (outcome === 'skipped') {
      continue
    }
    await log.record({
      pid: candidate.pid,
      command: candidate.command,
      agentName: candidate.agentName,
      paneId: candidate.paneId,
      timestamp: Date.now(),
      outcome
    })
  }
}
