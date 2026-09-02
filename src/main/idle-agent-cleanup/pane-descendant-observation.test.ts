import { beforeEach, describe, expect, it } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  collectPaneDescendantPids,
  recordPaneDescendantObservation
} from './pane-descendant-observation'
import {
  paneObservedDescendants,
  retainedClosedPaneDescendants
} from './pane-descendant-tracking-state'

function row(pid: number, ppid: number, command: string): ProcessTableRow {
  return { pid, ppid, stat: 'S', command }
}

beforeEach(() => {
  paneObservedDescendants.clear()
  retainedClosedPaneDescendants.clear()
})

describe('collectPaneDescendantPids (Design Resolution B — shared descendant-walk helper)', () => {
  it('returns every descendant pid of the shell, excluding the shell itself', () => {
    const rows = [
      row(100, 1, 'bash -l'),
      row(101, 100, 'node childA'),
      row(102, 101, 'node grandchildB')
    ]
    expect(collectPaneDescendantPids(rows, 100)).toEqual([101, 102])
  })

  it('returns an empty array for a shellPid with no descendants', () => {
    const rows = [row(100, 1, 'bash -l')]
    expect(collectPaneDescendantPids(rows, 100)).toEqual([])
  })

  it('returns an empty array for a shellPid absent from rows', () => {
    const rows = [row(200, 1, 'zsh')]
    expect(collectPaneDescendantPids(rows, 100)).toEqual([])
  })
})

describe('recordPaneDescendantObservation — POSIX overload (paneId, shellPid, rows)', () => {
  it("records the descendant set and rootCommandLine equal to the shell row's command (spec §5a)", () => {
    const rows = [
      row(100, 1, 'bash -l'),
      row(101, 100, 'node childA'),
      row(102, 101, 'node grandchildB')
    ]

    recordPaneDescendantObservation('pane-1', 100, rows)

    const entry = paneObservedDescendants.get('pane-1')
    expect(entry?.rootCommandLine).toBe('bash -l')
    expect(entry?.shellPid).toBe(100)
    expect(entry?.descendantPids).toEqual(new Set([101, 102]))
  })

  it('records an empty set (not "no entry") when the shell has no descendants — an empty set is still evidence the pane was observed', () => {
    const rows = [row(100, 1, 'bash -l')]

    recordPaneDescendantObservation('pane-1', 100, rows)

    const entry = paneObservedDescendants.get('pane-1')
    expect(entry).toBeDefined()
    expect(entry?.descendantPids).toEqual(new Set())
  })

  // Design Resolution A/spec §5a's third TEST, interpreted (flagged as a genuine
  // ambiguity — the pseudocode gives no explicit staleness token to the function):
  // a pane already retained as closed must not be resurrected in
  // paneObservedDescendants by a late/stale observation call that resolves after
  // the pane's close was already processed.
  it('does not resurrect a paneObservedDescendants entry for a paneId already retained as closed', () => {
    retainedClosedPaneDescendants.set('pane-1', {
      paneId: 'pane-1',
      rootCommandLine: 'bash -l',
      shellPid: 100,
      descendantPids: new Set([101]),
      retainedAtMs: Date.now()
    })
    const rows = [row(100, 1, 'bash -l'), row(101, 100, 'node childA')]

    recordPaneDescendantObservation('pane-1', 100, rows)

    expect(paneObservedDescendants.has('pane-1')).toBe(false)
  })

  it('no-ops and leaves a previous observation untouched when shellPid itself is missing from rows (edge race)', () => {
    const priorRows = [row(100, 1, 'bash -l'), row(101, 100, 'node childA')]
    recordPaneDescendantObservation('pane-1', 100, priorRows)
    const before = paneObservedDescendants.get('pane-1')

    const staleRows = [row(200, 1, 'zsh')] // shellPid 100 absent from this snapshot
    recordPaneDescendantObservation('pane-1', 100, staleRows)

    expect(paneObservedDescendants.get('pane-1')).toEqual(before)
  })
})

describe('recordPaneDescendantObservation — Windows overload (paneId, shellPid, descendants, rootCommandLine)', () => {
  it('records the pre-filtered descendants and explicit root command line directly, with no shell-row lookup step', () => {
    const before = Date.now()

    recordPaneDescendantObservation(
      'pane-2',
      200,
      [{ pid: 201 }, { pid: 202 }],
      'cmd.exe /c claude'
    )

    const after = Date.now()
    const entry = paneObservedDescendants.get('pane-2')
    expect(entry?.paneId).toBe('pane-2')
    expect(entry?.rootCommandLine).toBe('cmd.exe /c claude')
    expect(entry?.shellPid).toBe(200)
    expect(entry?.descendantPids).toEqual(new Set([201, 202]))
    expect(entry?.observedAtMs).toBeGreaterThanOrEqual(before)
    expect(entry?.observedAtMs).toBeLessThanOrEqual(after)
  })

  it('records an entry with an empty set given an empty descendants array (same "empty set is still evidence" rule)', () => {
    recordPaneDescendantObservation('pane-2', 200, [], 'cmd.exe /c claude')

    const entry = paneObservedDescendants.get('pane-2')
    expect(entry).toBeDefined()
    expect(entry?.descendantPids).toEqual(new Set())
  })

  it('applies the same staleness/no-resurrection guard as the POSIX overload', () => {
    retainedClosedPaneDescendants.set('pane-2', {
      paneId: 'pane-2',
      rootCommandLine: 'cmd.exe /c claude',
      shellPid: 200,
      descendantPids: new Set([201]),
      retainedAtMs: Date.now()
    })

    recordPaneDescendantObservation('pane-2', 200, [{ pid: 201 }], 'cmd.exe /c claude')

    expect(paneObservedDescendants.has('pane-2')).toBe(false)
  })
})
