import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot'
import { readWindowsProcessTableFresh } from '../windows/windows-process-table'
import { collectPaneDescendantPids } from './pane-descendant-observation'
import {
  paneObservedDescendants,
  retainedClosedPaneDescendants
} from './pane-descendant-tracking-state'

const DEFAULT_RETENTION_GRACE_MS = 10 * 60_000

/**
 * Pane-close handler: takes one immediate fresh process-table snapshot and
 * retains the pane's descendants for a grace period, so a cleanup tick can
 * still find and kill orphans that outlive the pane itself.
 */
export async function retainDescendantsOnPaneClose(
  paneId: string,
  shellPid: number
): Promise<void> {
  // Captured before the fresh scan below — the shell itself is exiting as
  // part of this close, so it may already be gone from a fresh snapshot by
  // the time it runs; the rolling record is the reliable source for it.
  const lastRootCommandLine = paneObservedDescendants.get(paneId)?.rootCommandLine ?? ''

  const rows = await (
    process.platform === 'win32' ? readWindowsProcessTableFresh() : getFreshProcessTableSnapshot()
  ).catch(() => null)

  const descendants =
    rows !== null
      ? collectPaneDescendantPids(rows, shellPid)
      : Array.from(paneObservedDescendants.get(paneId)?.descendantPids ?? [])

  paneObservedDescendants.delete(paneId)
  if (descendants.length > 0) {
    retainedClosedPaneDescendants.set(paneId, {
      paneId,
      rootCommandLine: lastRootCommandLine,
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
