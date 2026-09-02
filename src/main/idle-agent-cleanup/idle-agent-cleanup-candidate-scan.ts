import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'
import type { RetainedPaneDescendantsWireRecord } from '../daemon/types'
import type { IdleAgentCleanupLogEntry } from '../../shared/idle-agent-cleanup-log-entry'
import {
  matchIdleAgentCleanupCandidate,
  matchIdleAgentCleanupSignature
} from '../../shared/idle-agent-cleanup-signatures'
import { killOrphanedAgentProcessByPid } from './idle-agent-process-kill'
import {
  DEFAULT_RETENTION_GRACE_MS,
  evictExpiredRetainedPanes
} from './pane-close-descendant-retention'
import { collectPaneDescendantPids } from './pane-descendant-observation'
import { retainedClosedPaneDescendants } from './pane-descendant-tracking-state'

type IdleAgentCleanupTickSettings = { idleAgentCleanupEnabled: boolean }
type IdleAgentCleanupTickLog = {
  record(entry: IdleAgentCleanupLogEntry): Promise<void>
  /** Called once after a tick's kills settle, so N kills broadcast one refreshed list, not N. */
  flush(): Promise<void>
}

type IdleAgentCleanupTickDeps = {
  /**
   * Retained closed-pane descendants from every daemon-hosted PTY host, pulled
   * fresh each tick over RPC -- the daemon runs as a separate OS process, so
   * its own copy of the equivalent in-memory map is otherwise unreachable from
   * here. Must never reject: a host that cannot answer should resolve to `[]`
   * (degrade to local-pty-only cleanup for this tick) rather than fail it.
   */
  fetchDaemonRetainedPaneDescendants?: () => Promise<RetainedPaneDescendantsWireRecord[]>
}

/**
 * Minimal row shape both POSIX (`ProcessTableRow`) and Windows
 * (`WindowsProcessRow`) satisfy. `creationTimeMs` is Windows-only (present
 * when `isWindowsProcessStartTimeAvailable()`) and absent on POSIX rows.
 */
type MinimalProcessRow = {
  pid: number
  ppid: number
  command: string
  creationTimeMs?: number
}

type IdleAgentCleanupCandidate = {
  pid: number
  command: string
  agentName: string
  paneId: string
  rootCommandLine: string
  shellPid: number
  creationTimeMs?: number
}

type TrackedDescendant = {
  pid: number
  paneId: string
  rootCommandLine: string
  shellPid: number
}

async function readFreshProcessTableRows(): Promise<MinimalProcessRow[]> {
  return process.platform === 'win32'
    ? readWindowsProcessTableFresh()
    : getFreshProcessTableSnapshot()
}

function indexByPid(rows: readonly MinimalProcessRow[]): Map<number, MinimalProcessRow> {
  return new Map(rows.map((row) => [row.pid, row]))
}

/**
 * Every tracked descendant pid of a *closed* pane, tagged with its owning
 * pane. Live panes are deliberately excluded: a descendant that legitimately
 * detaches from its shell while the pane is still open (a daemonizing dev
 * server, an MCP server, anything double-forking) is not "an agent process
 * left running after its pane closed" — the feature's own stated scope — and
 * must never become a kill candidate just because it stopped being a
 * reachable descendant of a shell that never actually exited.
 *
 * `daemonRetained` supplies the same shape for daemon-hosted panes, whose
 * in-memory retention lives in a separate OS process; entries past their own
 * grace period are dropped here too, in case a daemon generation failed to
 * self-prune (see pane-close-descendant-retention.ts's eviction comment).
 */
function collectTrackedDescendants(
  daemonRetained: readonly RetainedPaneDescendantsWireRecord[]
): TrackedDescendant[] {
  const tracked: TrackedDescendant[] = []
  for (const [paneId, retained] of retainedClosedPaneDescendants) {
    for (const pid of retained.descendantPids) {
      tracked.push({
        pid,
        paneId,
        rootCommandLine: retained.rootCommandLine,
        shellPid: retained.shellPid
      })
    }
  }
  const now = Date.now()
  for (const retained of daemonRetained) {
    if (now - retained.retainedAtMs > DEFAULT_RETENTION_GRACE_MS) {
      continue
    }
    for (const pid of retained.descendantPids) {
      tracked.push({
        pid,
        paneId: retained.paneId,
        rootCommandLine: retained.rootCommandLine,
        shellPid: retained.shellPid
      })
    }
  }
  return tracked
}

/**
 * Memoizes the reachable-descendant-pid set per distinct shellPid over one
 * rows snapshot, since multiple tracked descendants commonly share a shellPid
 * and the underlying tree-walk is O(rows). `collectPaneDescendantPids` itself
 * memoizes the parent->children index per rows array, so distinct shellPids
 * sharing this snapshot still only pay one O(rows) index build between them.
 */
function makeReachableDescendantsLookup(
  rows: readonly MinimalProcessRow[]
): (shellPid: number) => ReadonlySet<number> {
  const cache = new Map<number, ReadonlySet<number>>()
  return (shellPid) => {
    let reachable = cache.get(shellPid)
    if (!reachable) {
      reachable = new Set(collectPaneDescendantPids(rows, shellPid))
      cache.set(shellPid, reachable)
    }
    return reachable
  }
}

/**
 * Orphaned + signature-matched tracked descendants, deduped by pid.
 *
 * "Orphaned" is decided by fresh reachability from the descendant's own
 * tracked shellPid, not by whether *any* row happens to sit at `ppid` — POSIX
 * reparents an orphan to a subreaper (pid 1 or similar) that is always
 * present in a full snapshot, so an "is ppid present" check could never see a
 * real orphan on POSIX.
 *
 * Two different closed panes can end up tracking the same live pid after it
 * gets recycled; when that happens neither claim is trustworthy, so both are
 * dropped rather than letting the later one silently win.
 */
function buildCandidates(
  rows: MinimalProcessRow[],
  byPid: Map<number, MinimalProcessRow>,
  daemonRetained: readonly RetainedPaneDescendantsWireRecord[]
): IdleAgentCleanupCandidate[] {
  const candidatesByPid = new Map<number, IdleAgentCleanupCandidate>()
  const ambiguousPids = new Set<number>()
  const reachableFromShell = makeReachableDescendantsLookup(rows)
  for (const { pid, paneId, rootCommandLine, shellPid } of collectTrackedDescendants(
    daemonRetained
  )) {
    if (ambiguousPids.has(pid)) {
      continue
    }
    const row = byPid.get(pid)
    if (!row) {
      continue // gone
    }
    if (reachableFromShell(shellPid).has(pid)) {
      continue // still a live descendant of its own shell -> not orphaned
    }
    const signature = matchIdleAgentCleanupCandidate(row.command, rootCommandLine)
    if (!signature) {
      continue // orphaned but not a recognized agent process
    }
    const existing = candidatesByPid.get(pid)
    if (existing && existing.paneId !== paneId) {
      candidatesByPid.delete(pid)
      ambiguousPids.add(pid)
      continue
    }
    candidatesByPid.set(pid, {
      pid,
      command: row.command,
      agentName: signature.agentName,
      paneId,
      rootCommandLine,
      shellPid,
      creationTimeMs: row.creationTimeMs
    })
  }
  return [...candidatesByPid.values()]
}

/**
 * Re-verifies a candidate against the tick's shared verify snapshot before
 * killing. `verifyByPid` and `reachableFromShell` are built once per tick by
 * the caller and shared across every candidate, so this function never
 * re-walks the process tree itself.
 *
 * No process-start-time signal is available cross-platform to distinguish
 * "this exact process instance" from "a different process the pid was
 * recycled to since candidate-building" (Windows exposes a creation
 * timestamp; POSIX's process-table row shape does not), so the baseline
 * check is requiring the live command line to be byte-identical to what was
 * captured at candidate-building time -- for BOTH an own-signature match and
 * the pane-lineage fallback match alike. On Windows, when both rows carry
 * `creationTimeMs`, an exact-match requirement on that field is layered on
 * top: a recycled pid whose new occupant happens to share an identical
 * command line (e.g. the same script re-launched) still fails this stronger
 * check. A candidate matched only through the fallback (its own command line
 * carries no signature) has no live signal of its own to re-derive beyond
 * this, since re-checking against the pane's root command line would always
 * re-confirm itself (that string is a stored constant unrelated to whatever
 * now holds this pid).
 */
export async function killVerifiedOrphanedAgentProcess(
  candidate: IdleAgentCleanupCandidate,
  verifyByPid: Map<number, MinimalProcessRow>,
  reachableFromShell: (shellPid: number) => ReadonlySet<number>
): Promise<'killed' | 'kill-failed' | 'skipped'> {
  const row = verifyByPid.get(candidate.pid)
  if (!row) {
    return 'skipped' // gone since candidate-building
  }
  if (reachableFromShell(candidate.shellPid).has(candidate.pid)) {
    return 'skipped' // re-parented back to its own shell since candidate-building
  }
  if (row.command !== candidate.command) {
    return 'skipped' // pid recycled to a different process instance since candidate-building
  }
  if (
    candidate.creationTimeMs !== undefined &&
    row.creationTimeMs !== undefined &&
    row.creationTimeMs !== candidate.creationTimeMs
  ) {
    return 'skipped' // pid recycled since candidate-building, despite an identical command line
  }
  const ownSignature = matchIdleAgentCleanupSignature(row.command)
  if (ownSignature) {
    if (ownSignature.agentName !== candidate.agentName) {
      return 'skipped' // pid recycled to a different agent identity
    }
  } else {
    const fallbackSignature = matchIdleAgentCleanupSignature(candidate.rootCommandLine)
    if (fallbackSignature?.agentName !== candidate.agentName) {
      return 'skipped' // pid recycled to something unrelated
    }
  }
  return killOrphanedAgentProcessByPid(candidate.pid)
}

/**
 * Periodic cleanup tick: one fresh scan builds candidates, then — only when
 * there is at least one candidate — a second shared fresh scan re-verifies
 * the whole kill phase in one read rather than one read per candidate.
 */
export async function runIdleAgentCleanupTick(
  settings: IdleAgentCleanupTickSettings,
  log: IdleAgentCleanupTickLog,
  deps: IdleAgentCleanupTickDeps = {}
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

  const daemonRetained = (await deps.fetchDaemonRetainedPaneDescendants?.()) ?? []
  const candidates = buildCandidates(rows, indexByPid(rows), daemonRetained)
  if (candidates.length === 0) {
    return
  }

  let verifyRows: MinimalProcessRow[]
  try {
    verifyRows = await readFreshProcessTableRows()
  } catch {
    // Cannot re-verify anything this tick -> no kills, no log entries.
    return
  }

  const verifyByPid = indexByPid(verifyRows)
  const verifyReachableFromShell = makeReachableDescendantsLookup(verifyRows)
  let recordedAny = false
  await Promise.allSettled(
    candidates.map(async (candidate) => {
      const outcome = await killVerifiedOrphanedAgentProcess(
        candidate,
        verifyByPid,
        verifyReachableFromShell
      )
      if (outcome === 'skipped') {
        return
      }
      try {
        await log.record({
          pid: candidate.pid,
          command: candidate.command,
          agentName: candidate.agentName,
          paneId: candidate.paneId,
          timestamp: Date.now(),
          outcome
        })
        recordedAny = true
      } catch (error) {
        // One candidate's log-write failure must not abort any other
        // candidate's already-verified kill.
        console.warn('[idle-agent-cleanup] failed to record cleanup log entry', error)
      }
    })
  )
  if (recordedAny) {
    // One broadcast of the refreshed list for the whole tick, not one per kill.
    await log.flush()
  }
}
