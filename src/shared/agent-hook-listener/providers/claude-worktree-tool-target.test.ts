import { describe, expect, it } from 'vitest'
import { resolveClaudeWorktreeToolTarget } from './claude-worktree-tool-target'

describe('resolveClaudeWorktreeToolTarget', () => {
  it('reads the target path from a completed EnterWorktree call', () => {
    const result = resolveClaudeWorktreeToolTarget('PostToolUse', {
      tool_name: 'EnterWorktree',
      tool_input: { path: '/repo/worktrees/feature-x' },
      tool_response: { ok: true }
    })
    expect(result).toBe('/repo/worktrees/feature-x')
  })

  it('reads the returned-to path from a completed ExitWorktree call', () => {
    const result = resolveClaudeWorktreeToolTarget('PostToolUse', {
      tool_name: 'ExitWorktree',
      tool_input: {},
      tool_response: { path: '/repo/worktrees/main' }
    })
    expect(result).toBe('/repo/worktrees/main')
  })

  it('returns null for a PreToolUse EnterWorktree call (not resolved yet)', () => {
    const result = resolveClaudeWorktreeToolTarget('PreToolUse', {
      tool_name: 'EnterWorktree',
      tool_input: { path: '/repo/worktrees/feature-x' }
    })
    expect(result).toBeNull()
  })

  it('returns null for a failed EnterWorktree call', () => {
    const result = resolveClaudeWorktreeToolTarget('PostToolUseFailure', {
      tool_name: 'EnterWorktree',
      tool_input: { path: '/repo/worktrees/feature-x' }
    })
    expect(result).toBeNull()
  })

  it('returns null for an unrelated tool', () => {
    const result = resolveClaudeWorktreeToolTarget('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })
    expect(result).toBeNull()
  })

  it('returns null when the expected path field is missing or not a string', () => {
    const result = resolveClaudeWorktreeToolTarget('PostToolUse', {
      tool_name: 'EnterWorktree',
      tool_input: { path: 42 }
    })
    expect(result).toBeNull()
  })
})
