/** Rolling record of an open pane's most recently observed descendant PIDs. */
export type PaneObservedDescendants = {
  paneId: string
  /** The pane's root shell/agent command line, captured once and never re-read — used by
   * the pane-lineage signature fallback (idle-agent-cleanup-signatures.ts) so a candidate
   * whose own argv carries no agent signature can still match through what launched it. */
  rootCommandLine: string
  descendantPids: ReadonlySet<number>
  observedAtMs: number
}

/** A closed pane's last-known descendants, held for a grace period. */
export type RetainedPaneDescendants = {
  paneId: string
  rootCommandLine: string
  descendantPids: ReadonlySet<number>
  /** Pane-close time; the grace period is measured from here. */
  retainedAtMs: number
}

// Both maps are process-lifetime, in-memory only — never written to disk.
export const paneObservedDescendants = new Map<string, PaneObservedDescendants>()
export const retainedClosedPaneDescendants = new Map<string, RetainedPaneDescendants>()
