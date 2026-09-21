import { describe, expect, it } from 'vitest'
import { _internals } from './server'
import { buildBody } from './server.test-fixtures'

describe('Claude cwd passthrough', () => {
  it('carries cwd from a PostToolUse payload onto the normalized event', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cd ../sibling-worktree' },
        tool_response: {},
        cwd: '/repo/worktrees/sibling-worktree'
      }),
      'production'
    )
    expect(result?.cwd).toBe('/repo/worktrees/sibling-worktree')
  })

  it('is undefined when the payload has no cwd field', () => {
    const result = _internals.normalizeHookPayload(
      'claude',
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: {}
      }),
      'production'
    )
    expect(result?.cwd).toBeUndefined()
  })

  it('is undefined for a non-Claude source', () => {
    const result = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'PostToolUse', cwd: '/repo/worktrees/sibling-worktree' }),
      'production'
    )
    expect(result?.cwd).toBeUndefined()
  })
})
