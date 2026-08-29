// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  activeWorktreeId: 'wt-a' as string | null,
  worktreeMap: new Map<string, { id: string; repoId: string }>([
    ['wt-a', { id: 'wt-a', repoId: 'repo-1' }],
    ['wt-b', { id: 'wt-b', repoId: 'repo-1' }],
    ['wt-c', { id: 'wt-c', repoId: 'repo-2' }]
  ])
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (s: typeof state) => unknown) => selector(state)
}))

vi.mock('@/store/selectors', () => ({
  useWorktreeMap: () => state.worktreeMap
}))

const { useSourceControlViewWorktreeSelection } =
  await import('./use-source-control-view-worktree-selection')

function Harness(): React.JSX.Element {
  const { subjectWorktreeId, setViewWorktreeId } = useSourceControlViewWorktreeSelection()
  return (
    <div>
      <span data-testid="subject">{subjectWorktreeId ?? 'null'}</span>
      <button type="button" onClick={() => setViewWorktreeId('wt-b')}>
        pick-b
      </button>
    </div>
  )
}

afterEach(cleanup)

describe('useSourceControlViewWorktreeSelection', () => {
  it('defaults to the app-active worktree', () => {
    render(<Harness />)
    expect(screen.getByTestId('subject').textContent).toBe('wt-a')
  })

  it('pins the subject to the picked worktree', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('pick-b'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-b')
  })

  it('keeps the pin when the app-active worktree switches within the same repo', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('pick-b'))
    state.activeWorktreeId = 'wt-a2'
    state.worktreeMap.set('wt-a2', { id: 'wt-a2', repoId: 'repo-1' })
    // Why: the mocked store is a plain object; bump React with a sibling update
    // so the subscription re-reads the new active id.
    fireEvent.click(screen.getByText('pick-b'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-b')
  })

  it('follows the app-active worktree when the active repo changes', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('pick-b'))
    state.activeWorktreeId = 'wt-c'
    fireEvent.click(screen.getByText('pick-b'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-c')
  })

  it('falls back to the app-active worktree when the pinned one disappears', () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('pick-b'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-b')
    state.worktreeMap.delete('wt-b')
    state.activeWorktreeId = 'wt-a'
    fireEvent.click(screen.getByText('pick-b'))
    expect(screen.getByTestId('subject').textContent).toBe('wt-a')
  })
})
