// Why: no production consumer. The live-worktree pipeline moved to a general cwd-based approach
// (see later tasks in docs/superpowers/plans/2026-09-21-live-worktree-tab-sync.md) instead of
// calling this. Kept only as a reference for its PostToolUse-only gate pattern — do not re-wire
// it, doing so would re-narrow the live-worktree signal back to EnterWorktree/ExitWorktree by
// tool name, defeating the point of the cwd-based approach.
import { readString } from '../tool-input-preview'

const RESPONSE_KEY_BY_TOOL: Record<string, { fromInput: boolean; key: string }> = {
  EnterWorktree: { fromInput: true, key: 'path' },
  ExitWorktree: { fromInput: false, key: 'path' }
}

function asRecord(value: unknown): Record<string, unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: asRecord treats any truthy object as a record; readString safely handles lookups on the result even for an array.
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
