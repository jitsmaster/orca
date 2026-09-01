import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  paneObservedDescendants,
  retainedClosedPaneDescendants
} from './pane-descendant-tracking-state'

/**
 * Walks a process-table snapshot for every descendant pid of `shellPid`,
 * excluding the shell itself. A self-contained walk kept separate from the
 * similarly-shaped helpers in agent-foreground-process.ts /
 * windows-foreground-process-rows.ts by design (architecture §1.2) — those
 * are private to modules with a different purpose (foreground-process
 * identity, not cleanup tracking), and hoisting a shared export would couple
 * unrelated call sites for a walk cheap enough to duplicate.
 */
export function collectPaneDescendantPids(
  rows: readonly { pid: number; ppid: number }[],
  shellPid: number
): number[] {
  const childrenByParent = new Map<number, number[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row.pid)
    childrenByParent.set(row.ppid, children)
  }

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
  rows: ProcessTableRow[]
): void
/** Windows overload: descendants and root command line are already resolved by the caller. */
export function recordPaneDescendantObservation(
  paneId: string,
  shellPid: number,
  descendants: { pid: number }[],
  rootCommandLine: string
): void
export function recordPaneDescendantObservation(
  paneId: string,
  shellPid: number,
  rowsOrDescendants: ProcessTableRow[] | { pid: number }[],
  rootCommandLine?: string
): void {
  // A late-resolving observation for a pane that already closed must not
  // resurrect a live-tracking entry alongside its retained one.
  if (retainedClosedPaneDescendants.has(paneId)) {
    return
  }

  if (rootCommandLine !== undefined) {
    paneObservedDescendants.set(paneId, {
      paneId,
      rootCommandLine,
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
  paneObservedDescendants.set(paneId, {
    paneId,
    rootCommandLine: shellRow.command,
    descendantPids: new Set(collectPaneDescendantPids(rows, shellPid)),
    observedAtMs: Date.now()
  })
}
