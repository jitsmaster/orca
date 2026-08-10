// @vitest-environment happy-dom
/**
 * Why a render test on top of shouldRevealWorktreeDeveloperMenu's unit tests:
 * the shipped bug was the submenu rendering unconditionally, i.e. a WIRING
 * defect. These assert the modifier actually reaches the reveal state through
 * the real right-click handler.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MouseEventHandler, PointerEventHandler, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/types'

const storeDoubles = vi.hoisted(() => {
  const deleteFolderWorkspace = vi.fn()
  const setActiveWorktree = vi.fn()
  return {
    deleteFolderWorkspace,
    setActiveWorktree,
    state: {
      activeWorktreeId: null as string | null,
      activeWorkspaceExecutionHostId: null as string | null,
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      browserTabsByWorktree: {},
      deleteStateByWorktreeId: {},
      worktreeLineageById: {},
      workspaceLineageByChildKey: {},
      workspaceStatuses: [],
      projectGroups: [],
      settings: null,
      updateWorktreeMeta: vi.fn(),
      setWorktreesPinnedAndReveal: vi.fn(),
      openModal: vi.fn(),
      createProjectGroup: vi.fn(),
      moveProjectToGroup: vi.fn(),
      deleteFolderWorkspace,
      setActiveWorktree
    }
  }
})

vi.mock('@/store', () => {
  return {
    useAppStore: Object.assign(
      (selector: (value: typeof storeDoubles.state) => unknown) => selector(storeDoubles.state),
      { getState: () => storeDoubles.state }
    )
  }
})

vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [],
  useRepoById: () => null,
  useRepoMap: () => new Map(),
  useWorktreeMap: () => new Map()
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

// Why: keep selection testable without Radix portal and layout behavior.
vi.mock('@/components/ui/dropdown-menu', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  const content = ({
    children,
    onClickCapture,
    onPointerDownCapture
  }: {
    children?: ReactNode
    onClickCapture?: MouseEventHandler<HTMLDivElement>
    onPointerDownCapture?: PointerEventHandler<HTMLDivElement>
  }) => (
    <div onClickCapture={onClickCapture} onPointerDownCapture={onPointerDownCapture}>
      {children}
    </div>
  )
  const item = ({
    children,
    disabled,
    onSelect
  }: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button type="button" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  )
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: content,
    DropdownMenuItem: item,
    DropdownMenuLabel: passthrough,
    DropdownMenuRadioGroup: passthrough,
    DropdownMenuRadioItem: passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: passthrough,
    DropdownMenuSubTrigger: passthrough,
    DropdownMenuTrigger: passthrough
  }
})

vi.mock('./WorktreeOpenInMenu', () => ({ WorktreeOpenInSubMenu: () => null }))
vi.mock('./ProjectGroupNameDialog', () => ({ ProjectGroupNameDialog: () => null }))
vi.mock('./WorktreeParentPickerPopover', () => ({ WorktreeParentPickerPopover: () => null }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('./delete-worktree-flow', () => ({
  runWorktreeBatchDelete: vi.fn(),
  runWorktreeDelete: vi.fn()
}))
vi.mock('./sleep-worktree-flow', () => ({ runSleepWorktrees: vi.fn() }))

const WorktreeContextMenu = (await import('./WorktreeContextMenu')).default

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/wt',
    repoId: 'repo-1',
    path: '/repo/wt',
    displayName: 'wt',
    branch: 'wt',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  } as Worktree
}

// Why: assert on text content — the passthrough menu mock renders each label as
// a bare text node beside its icon, which getByText's element matching skips.
function openContextMenu(altKey: boolean, worktree: Worktree = makeWorktree()): string {
  const { container } = render(
    <WorktreeContextMenu worktree={worktree}>
      <div data-testid="card">card</div>
    </WorktreeContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId('card'), { altKey })
  return container.textContent ?? ''
}

describe('Developer submenu reveal', () => {
  beforeEach(() => {
    storeDoubles.state.activeWorktreeId = null
    storeDoubles.state.activeWorkspaceExecutionHostId = null
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('hides the Developer submenu on a plain right-click', () => {
    const text = openContextMenu(false)

    expect(text).toContain('Sleep')
    expect(text).not.toContain('Developer')
    expect(text).not.toContain('Park terminal')
  })

  it('reveals the Developer submenu when Option/Alt is held', () => {
    const text = openContextMenu(true)

    expect(text).toContain('Developer')
    expect(text).toContain('Park terminal')
  })

  it('routes folder deletion to its owner and clears only that host selection', async () => {
    storeDoubles.deleteFolderWorkspace.mockResolvedValue(true)
    storeDoubles.state.activeWorktreeId = 'folder:folder-1'
    storeDoubles.state.activeWorkspaceExecutionHostId = 'runtime:env-b'
    openContextMenu(false, makeWorktree({ id: 'folder:folder-1', hostId: 'runtime:env-b' }))

    const deleteButton = screen.getByRole('button', { name: 'Remove Workspace' })
    fireEvent.pointerDown(deleteButton, { button: 0 })
    fireEvent.click(deleteButton)

    await waitFor(() => {
      expect(storeDoubles.deleteFolderWorkspace).toHaveBeenCalledWith('folder-1', {
        hostId: 'runtime:env-b'
      })
    })
    expect(storeDoubles.setActiveWorktree).toHaveBeenCalledWith(null)
  })
})
