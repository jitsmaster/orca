import { useState } from 'react'
import { useAppStore } from '@/store'
import { useWorktreeMap } from '@/store/selectors'

/**
 * Owns which worktree the Source Control panel is showing. Defaults to the app-active worktree; the
 * user can pin another worktree of the same repo through the picker. The pin survives app-active
 * switches within the same repo (so a reviewed worktree stays in view while the user works
 * elsewhere), resets when the active repo changes, and falls back to the app-active worktree when
 * the pinned one disappears from the catalog.
 */
export function useSourceControlViewWorktreeSelection(): {
  subjectWorktreeId: string | null
  setViewWorktreeId: (worktreeId: string) => void
} {
  const appActiveWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreeMap = useWorktreeMap()
  const appActiveRepoId = worktreeMap.get(appActiveWorktreeId ?? '')?.repoId ?? null
  const [viewWorktreeId, setViewWorktreeId] = useState<string | null>(appActiveWorktreeId)
  // Why: reset during render instead of key-remounting on switch (which caused a Windows IPC storm).
  // Keyed to the repo so a same-repo app-active switch keeps the user's explicit pin.
  const [selectionRepoId, setSelectionRepoId] = useState(appActiveRepoId)
  if (selectionRepoId !== appActiveRepoId) {
    setSelectionRepoId(appActiveRepoId)
    setViewWorktreeId(appActiveWorktreeId)
  }
  const subjectWorktreeId =
    viewWorktreeId && worktreeMap.has(viewWorktreeId) ? viewWorktreeId : appActiveWorktreeId
  return { subjectWorktreeId, setViewWorktreeId }
}
