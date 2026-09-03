import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import { IDLE_AGENT_CLEANUP_INTERVAL_MS_MAX } from '../../shared/idle-agent-cleanup-interval-policy'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'
import { collectPaneDescendantPids } from './pane-descendant-observation'
import {
  paneObservedDescendants,
  retainedClosedPaneDescendants
} from './pane-descendant-tracking-state'

// Exported for idle-agent-cleanup-candidate-scan.ts, which applies the same
// grace window to daemon-sourced retained records pulled over RPC each tick.
//
// Derived from (not just longer than) the largest configurable scan
// interval: a retained entry must survive until a tick slow enough to use
// that interval actually runs, or it would be evicted -- by this same
// module's own self-pruning, or by the tick's own eviction pass -- before
// ever being examined. The x2 margin covers a pane closing just after a
// tick fires, which must still survive a full interval before the next one.
export const DEFAULT_RETENTION_GRACE_MS = IDLE_AGENT_CLEANUP_INTERVAL_MS_MAX * 2

/**
 * Pane-close handler: takes one immediate fresh process-table snapshot and
 * retains the pane's descendants for a grace period, so a cleanup tick can
 * still find and kill orphans that outlive the pane itself.
 *
 * `isStillCurrent` guards against a pane id being reused by a brand-new spawn
 * while this scan was in flight (a stable, caller-supplied session id can be
 * respawned under the same id almost immediately) — a caller that can check
 * "is my closing occupant still the current one for this id" should pass that
 * check so a stale scan can't overwrite the new occupant's live tracking.
 * Callers with no such check (or no risk of id reuse) can omit it.
 */
export async function retainDescendantsOnPaneClose(
  paneId: string,
  shellPid: number,
  isStillCurrent: () => boolean = () => true
): Promise<void> {
  // Captured before the fresh scan below — the shell itself is exiting as
  // part of this close, so it may already be gone from a fresh snapshot by
  // the time it runs; the rolling record is the reliable source for it.
  const lastRootCommandLine = paneObservedDescendants.get(paneId)?.rootCommandLine ?? ''

  const rows = await (
    process.platform === 'win32' ? readWindowsProcessTableFresh() : getFreshProcessTableSnapshot()
  ).catch(() => null)

  // Self-pruning: this write is the only reliable, flag-independent moment to
  // evict expired retained entries — the cleanup tick's own eviction only
  // runs while the feature is enabled, so retained entries would otherwise
  // never be reclaimed for any user who hasn't opted in.
  evictExpiredRetainedPanes(Date.now())

  if (!isStillCurrent()) {
    // A new occupant has already been assigned to this pane id; this scan's
    // result belongs to the pane that just closed, not the one live here now.
    return
  }

  const descendants =
    rows !== null
      ? collectPaneDescendantPids(rows, shellPid)
      : Array.from(paneObservedDescendants.get(paneId)?.descendantPids ?? [])

  paneObservedDescendants.delete(paneId)
  if (descendants.length > 0) {
    retainedClosedPaneDescendants.set(paneId, {
      paneId,
      rootCommandLine: lastRootCommandLine,
      shellPid,
      descendantPids: new Set(descendants),
      retainedAtMs: Date.now()
    })
  }
}

/** Evicts retained closed-pane entries whose grace period has strictly elapsed. */
export function evictExpiredRetainedPanes(
  nowMs: number,
  graceMs = DEFAULT_RETENTION_GRACE_MS
): void {
  for (const [paneId, retained] of retainedClosedPaneDescendants) {
    if (nowMs - retained.retainedAtMs > graceMs) {
      retainedClosedPaneDescendants.delete(paneId)
    }
  }
}
