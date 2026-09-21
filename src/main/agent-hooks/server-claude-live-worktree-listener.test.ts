import { afterEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

describe('Claude live-worktree cwd listener', () => {
  let server: AgentHookServer

  afterEach(() => {
    server?.stop()
  })

  it('fires with paneKey/tabId/cwd on a completed PostToolUse event', async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
    const events: unknown[] = []
    server.setClaudeLiveWorktreeCwdListener((event) => events.push(event))

    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'cd ../sibling-worktree' },
        tool_response: {},
        cwd: '/repo/worktrees/sibling-worktree'
      })
    )

    expect(events).toEqual([
      { paneKey: expect.any(String), tabId: 'tab-1', cwd: '/repo/worktrees/sibling-worktree' }
    ])
  })

  it('does not fire for a non-PostToolUse Claude event', async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
    const events: unknown[] = []
    server.setClaudeLiveWorktreeCwdListener((event) => events.push(event))

    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'Stop', cwd: '/repo/worktrees/sibling-worktree' })
    )

    expect(events).toEqual([])
  })

  it('does not fire when the event carries no cwd', async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
    const events: unknown[] = []
    server.setClaudeLiveWorktreeCwdListener((event) => events.push(event))

    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: {}
      })
    )

    expect(events).toEqual([])
  })
})
