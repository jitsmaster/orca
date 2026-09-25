// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const setViewWorktreeId = vi.fn()
let subjectWorktreeId = 'wt-a'
let liveWorktreeId: string | undefined = 'wt-feature'

const storeState = {
  settings: {},
  getActiveTab: (worktreeId: string) => (worktreeId === 'wt-a' ? { id: 'tab-1' } : null)
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: typeof storeState) => unknown) => selector(storeState)
}))

vi.mock('../notes/use-diff-comment-notes', () => ({
  useSourceControlDiffCommentNotes: () => ({})
}))

vi.mock('../listing/use-store-actions', () => ({
  useSourceControlStoreActions: () => ({ updateSettings: vi.fn() })
}))

vi.mock('../listing/use-worktree-context', () => ({
  useSourceControlWorktreeContext: () => ({
    activeConnectionId: null,
    activeRepoSettings: null,
    activeWorktree: null,
    activeWorktreeId: 'wt-a',
    activeWorktreeInstanceId: undefined,
    appActiveWorktreeId: 'wt-a',
    branchSummary: null,
    conflictOperationsByWorktree: {},
    isBranchVisible: false,
    isFolder: false,
    repositoryHuge: undefined,
    worktreeMap: {},
    worktreePath: null
  })
}))

vi.mock('../sync/use-branch-line-total-gate', () => ({
  useSourceControlBranchLineTotalGate: () => undefined
}))

vi.mock('../sync/use-status-refresh', () => ({
  useSourceControlStatusRefresh: () => ({})
}))

vi.mock('./use-panel-view-state', () => ({
  useSourceControlPanelViewState: () => ({})
}))

vi.mock('./use-worktree-operation-state', () => ({
  useSourceControlWorktreeOperationState: () => ({})
}))

vi.mock('./use-source-control-view-worktree-selection', () => ({
  useSourceControlViewWorktreeSelection: () => ({
    subjectWorktreeId,
    setViewWorktreeId
  })
}))

vi.mock('./use-active-tab-live-worktree', () => ({
  useActiveTabLiveWorktreeId: () => liveWorktreeId
}))

const { useSourceControlPanelState } = await import('./use-panel-state')

function Harness(): React.JSX.Element {
  useSourceControlPanelState()
  return <span data-testid="rendered">ok</span>
}

afterEach(() => {
  cleanup()
  setViewWorktreeId.mockClear()
})

describe('useSourceControlPanelState worktree sync', () => {
  it("re-points the Source Control worktree picker to the active tab's live worktree", () => {
    subjectWorktreeId = 'wt-a'
    liveWorktreeId = 'wt-feature'
    render(<Harness />)
    expect(setViewWorktreeId).toHaveBeenCalledWith('wt-feature')
  })

  it('does nothing when the active tab has no live worktree override', () => {
    subjectWorktreeId = 'wt-a'
    liveWorktreeId = undefined
    render(<Harness />)
    expect(setViewWorktreeId).not.toHaveBeenCalled()
  })

  it('does nothing when the live worktree already matches the picker subject', () => {
    subjectWorktreeId = 'wt-feature'
    liveWorktreeId = 'wt-feature'
    render(<Harness />)
    expect(setViewWorktreeId).not.toHaveBeenCalled()
  })
})
