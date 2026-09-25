export type IdleAgentCleanupLogEntry = {
  pid: number
  /** Full command line captured at kill time. */
  command: string
  agentName: string
  /** Originating pane id, when the candidate was still traceable to one at kill time. */
  paneId?: string
  timestamp: number
  outcome: 'killed' | 'kill-failed'
}

// Architecture §3: storage cap (idle-agent-cleanup-log-store.ts) is 200; the UI
// display cap is smaller and lives here since both main's listRecent() callers
// and the renderer's list component need to agree on it.
export const IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS = 25
