import { useEffect, useState } from 'react'

// Why: keyed by tabId only, not paneKey — see main-window-source-control-live-worktree.ts.
export function useActiveTabLiveWorktreeId(tabId: string | null): string | undefined {
  const [worktreeIdByTabId, setWorktreeIdByTabId] = useState<Record<string, string>>({})
  useEffect(() => {
    return window.api.sourceControlLiveWorktree.onSet((event) => {
      setWorktreeIdByTabId((prev) =>
        prev[event.tabId] === event.worktreeId
          ? prev
          : { ...prev, [event.tabId]: event.worktreeId }
      )
    })
  }, [])
  return tabId ? worktreeIdByTabId[tabId] : undefined
}
