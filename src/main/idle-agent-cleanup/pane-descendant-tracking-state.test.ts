import { describe, expect, it } from 'vitest'
import {
  paneObservedDescendants,
  retainedClosedPaneDescendants
} from './pane-descendant-tracking-state'

describe('pane-descendant-tracking-state', () => {
  it('paneObservedDescendants starts as an empty Map on fresh import', () => {
    expect(paneObservedDescendants).toBeInstanceOf(Map)
    expect(paneObservedDescendants.size).toBe(0)
  })

  it('retainedClosedPaneDescendants starts as an empty Map on fresh import', () => {
    expect(retainedClosedPaneDescendants).toBeInstanceOf(Map)
    expect(retainedClosedPaneDescendants.size).toBe(0)
  })

  it('exports the same Map instances across separate imports (module singleton)', async () => {
    const first = await import('./pane-descendant-tracking-state')
    const second = await import('./pane-descendant-tracking-state')

    expect(first.paneObservedDescendants).toBe(second.paneObservedDescendants)
    expect(first.retainedClosedPaneDescendants).toBe(second.retainedClosedPaneDescendants)
    expect(first.paneObservedDescendants).toBe(paneObservedDescendants)
    expect(first.retainedClosedPaneDescendants).toBe(retainedClosedPaneDescendants)
  })
})
