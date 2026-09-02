import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  paneObservedDescendants,
  retainedClosedPaneDescendants
} from './pane-descendant-tracking-state'

type MinimalRow = { pid: number; ppid: number }

// Why a WeakMap keyed by the rows array: the per-pane foreground scan runs on
// a 750ms-15s cadence across every open pane, and panes polling within the
// same process-table-snapshot TTL window share the identical rows array
// reference. Without this cache, each pane independently rebuilt the same
// parent->children index from scratch every call; keying by the array itself
// lets every pane sharing one snapshot reuse a single O(rows) build instead
// of paying it once per pane, and lets an unreferenced snapshot's index be
// collected instead of retained forever.
const childrenByParentIndexCache = new WeakMap<readonly MinimalRow[], Map<number, number[]>>()

function getChildrenByParentIndex(rows: readonly MinimalRow[]): Map<number, number[]> {
  let index = childrenByParentIndexCache.get(rows)
  if (!index) {
    index = new Map<number, number[]>()
    for (const row of rows) {
      const children = index.get(row.ppid) ?? []
      children.push(row.pid)
      index.set(row.ppid, children)
    }
    childrenByParentIndexCache.set(rows, index)
  }
  return index
}

/**
 * Walks a process-table snapshot for every descendant pid of `shellPid`,
 * excluding the shell itself. A self-contained walk kept separate from the
 * similarly-shaped helpers in agent-foreground-process.ts /
 * windows-foreground-process-rows.ts by design (architecture §1.2) — those
 * are private to modules with a different purpose (foreground-process
 * identity, not cleanup tracking), and hoisting a shared export would couple
 * unrelated call sites for a walk cheap enough to duplicate.
 *
 * Known residual limitation (deferred, not fixed): this walk trusts `ppid` at
 * face value. Windows does not reparent an orphan to a subreaper the way
 * POSIX does, so a live, unrelated process could in principle reuse the
 * tracked shell's exact former pid as its own (unrelated) ppid, fabricating
 * lineage into a shell that already exited. Closing this fully would mean
 * capturing the tracked shell's own creation time at pane-open time and
 * threading it through `PaneObservedDescendants`/`RetainedPaneDescendants`
 * and both spawn call sites (local-pty and daemon-hosted) so this walk could
 * reject a ppid match whose row's creation time predates the tracked shell's
 * spawn. Left as documented residual risk given the required plumbing size
 * relative to how rarely a coincidental pid/ppid collision actually lines up
 * with a live agent-signature match — the kill-verify step's byte-identical
 * command-line check (and, on Windows, its `creationTimeMs` check; see
 * idle-agent-cleanup-candidate-scan.ts) already catches the pid the moment
 * it's about to be killed, so a spurious lineage match here still cannot
 * itself cause a wrong kill.
 */
export function collectPaneDescendantPids(
  rows: readonly { pid: number; ppid: number }[],
  shellPid: number
): number[] {
  const childrenByParent = getChildrenByParentIndex(rows)

  const pids: number[] = []
  const stack = [...(childrenByParent.get(shellPid) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop()!
    pids.push(pid)
    for (const child of childrenByParent.get(pid) ?? []) {
      stack.push(child)
    }
  }
  return pids
}

/** POSIX overload: derives the shell row and descendants from an already-fetched rows snapshot. */
export function recordPaneDescendantObservation(
  paneId: string,
  shellPid: number,
  rows: ProcessTableRow[],
  isStillCurrent?: () => boolean
): void
/** Windows overload: descendants and root command line are already resolved by the caller. */
export function recordPaneDescendantObservation(
  paneId: string,
  shellPid: number,
  descendants: { pid: number }[],
  rootCommandLine: string,
  isStillCurrent?: () => boolean
): void
export function recordPaneDescendantObservation(
  paneId: string,
  shellPid: number,
  rowsOrDescendants: ProcessTableRow[] | { pid: number }[],
  rootCommandLineOrIsStillCurrent?: string | (() => boolean),
  isStillCurrentIfRootCommandLineGiven?: () => boolean
): void {
  const rootCommandLine =
    typeof rootCommandLineOrIsStillCurrent === 'string'
      ? rootCommandLineOrIsStillCurrent
      : undefined
  const isStillCurrent =
    (typeof rootCommandLineOrIsStillCurrent === 'function'
      ? rootCommandLineOrIsStillCurrent
      : isStillCurrentIfRootCommandLineGiven) ?? (() => true)

  // A late-resolving observation for a pane that already closed must not
  // resurrect a live-tracking entry alongside its retained one.
  if (retainedClosedPaneDescendants.has(paneId)) {
    return
  }

  if (rootCommandLine !== undefined) {
    // Checked as late as possible, right before the write: a scan started for
    // one shell can outlive a respawn under the same paneId, and must not
    // overwrite the new occupant's live tracking with stale descendants.
    if (!isStillCurrent()) {
      return
    }
    paneObservedDescendants.set(paneId, {
      paneId,
      rootCommandLine,
      shellPid,
      descendantPids: new Set((rowsOrDescendants as { pid: number }[]).map((d) => d.pid)),
      observedAtMs: Date.now()
    })
    return
  }

  const rows = rowsOrDescendants as ProcessTableRow[]
  const shellRow = rows.find((row) => row.pid === shellPid)
  if (!shellRow) {
    // Shell itself not in this snapshot; nothing reliable to record this pass.
    return
  }
  if (!isStillCurrent()) {
    return
  }
  paneObservedDescendants.set(paneId, {
    paneId,
    rootCommandLine: shellRow.command,
    shellPid,
    descendantPids: new Set(collectPaneDescendantPids(rows, shellPid)),
    observedAtMs: Date.now()
  })
}
