import type { IdleAgentCleanupLogEntry } from '../../shared/idle-agent-cleanup-log-entry'

export type IdleAgentCleanupApi = {
  getRecentActivity: () => Promise<IdleAgentCleanupLogEntry[]>
  onActivityChanged: (callback: (entries: IdleAgentCleanupLogEntry[]) => void) => () => void
}
