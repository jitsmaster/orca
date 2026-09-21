import { readString } from '../tool-input-preview'

const RESPONSE_KEY_BY_TOOL: Record<string, { fromInput: boolean; key: string }> = {
  EnterWorktree: { fromInput: true, key: 'path' },
  ExitWorktree: { fromInput: false, key: 'path' }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** Resolves the worktree path a completed EnterWorktree/ExitWorktree tool call switched to. */
export function resolveClaudeWorktreeToolTarget(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): string | null {
  if (eventName !== 'PostToolUse') {
    return null
  }
  const toolName = readString(hookPayload, 'tool_name')
  if (!toolName) {
    return null
  }
  const target = RESPONSE_KEY_BY_TOOL[toolName]
  if (!target) {
    return null
  }
  const source = asRecord(target.fromInput ? hookPayload.tool_input : hookPayload.tool_response)
  return readString(source, target.key) ?? null
}
