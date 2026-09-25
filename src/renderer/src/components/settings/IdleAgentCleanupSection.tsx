import type React from 'react'
import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS,
  type IdleAgentCleanupLogEntry
} from '../../../../shared/idle-agent-cleanup-log-entry'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitch } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type IdleAgentCleanupSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const INTERVAL_OPTIONS_MS = [60_000, 300_000, 900_000, 1_800_000] as const

function formatIntervalOptionLabel(ms: number): string {
  const minutes = ms / 60_000
  return translate(
    'settings.idleAgentCleanup.intervalOptionMinutes',
    `${minutes} minute${minutes === 1 ? '' : 's'}`
  )
}

function IdleAgentCleanupRecentActivity({
  entries
}: {
  entries: IdleAgentCleanupLogEntry[]
}): React.JSX.Element {
  if (entries.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {translate(
          'settings.idleAgentCleanup.emptyState',
          'No idle agent processes cleaned up yet.'
        )}
      </p>
    )
  }

  return (
    <div className="space-y-2">
      {entries.slice(0, IDLE_AGENT_CLEANUP_LOG_DISPLAY_ROWS).map((entry, index) => (
        <div
          key={`${entry.pid}-${entry.timestamp}-${index}`}
          data-testid="idle-agent-cleanup-entry"
          className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {entry.agentName} ({entry.pid})
            </div>
            <div className="text-muted-foreground truncate text-xs">{entry.command}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
            <Trash2 className="size-3.5" />
            {new Date(entry.timestamp).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  )
}

export function IdleAgentCleanupSection({
  settings,
  updateSettings
}: IdleAgentCleanupSectionProps): React.JSX.Element {
  const [entries, setEntries] = useState<IdleAgentCleanupLogEntry[]>([])

  useEffect(() => {
    let cancelled = false
    window.api.idleAgentCleanup
      .getRecentActivity()
      .then((fetched) => {
        if (!cancelled) {
          setEntries(fetched)
        }
      })
      .catch(() => {
        // Best-effort hydration; the push channel still keeps the list current.
      })
    // Push updates replace state directly — never re-fetch on push, per contract.
    const unsubscribe = window.api.idleAgentCleanup.onActivityChanged(setEntries)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title={translate('settings.idleAgentCleanup.title', 'Idle Agent Cleanup')}
        description={translate(
          'settings.idleAgentCleanup.description',
          'Periodically clean up orphaned Claude/Codex CLI processes left behind when a terminal pane closes.'
        )}
      />

      <SearchableSetting
        title={translate('settings.idleAgentCleanup.toggleLabel', 'Idle Agent Cleanup')}
        description={translate(
          'settings.idleAgentCleanup.toggleDescription',
          'Automatically kill orphaned agent processes on a schedule.'
        )}
        keywords={['idle', 'agent', 'cleanup', 'orphan', 'process']}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>{translate('settings.idleAgentCleanup.toggleLabel', 'Idle Agent Cleanup')}</Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.idleAgentCleanup.toggleDescription',
              'Automatically kill orphaned agent processes on a schedule.'
            )}
          </p>
        </div>
        <SettingsSwitch
          ariaLabel={translate('settings.idleAgentCleanup.toggleLabel', 'Idle Agent Cleanup')}
          checked={settings.idleAgentCleanupEnabled}
          onChange={() =>
            updateSettings({ idleAgentCleanupEnabled: !settings.idleAgentCleanupEnabled })
          }
        />
      </SearchableSetting>

      {settings.idleAgentCleanupEnabled && (
        <SearchableSetting
          title={translate('settings.idleAgentCleanup.intervalLabel', 'Cleanup Interval')}
          description={translate(
            'settings.idleAgentCleanup.intervalDescription',
            'How often to scan for and clean up orphaned agent processes.'
          )}
          keywords={['idle', 'agent', 'cleanup', 'interval', 'schedule']}
          className="flex items-center justify-between gap-4 py-2 pl-7"
        >
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label>
              {translate('settings.idleAgentCleanup.intervalLabel', 'Cleanup Interval')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'settings.idleAgentCleanup.intervalDescription',
                'How often to scan for and clean up orphaned agent processes.'
              )}
            </p>
          </div>
          <Select
            value={String(settings.idleAgentCleanupIntervalMs)}
            onValueChange={(v) => updateSettings({ idleAgentCleanupIntervalMs: Number(v) })}
          >
            <SelectTrigger size="sm" className="h-7 text-xs w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INTERVAL_OPTIONS_MS.map((ms) => (
                <SelectItem key={ms} value={String(ms)}>
                  {formatIntervalOptionLabel(ms)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SearchableSetting>
      )}

      <div className="space-y-2">
        <h4 className="text-sm font-medium">
          {translate('settings.idleAgentCleanup.recentActivityHeading', 'Recently Cleaned Up')}
        </h4>
        <IdleAgentCleanupRecentActivity entries={entries} />
      </div>
    </section>
  )
}
