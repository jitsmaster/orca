export type IdleAgentCleanupSignature = {
  /** Display label used in the recently-cleaned log/UI, e.g. "Claude Code". */
  agentName: string
  /** Case-sensitive substrings; ANY match against a process's full command line qualifies it. */
  commandLineSubstrings: readonly string[]
}

export const IDLE_AGENT_CLEANUP_SIGNATURES: readonly IdleAgentCleanupSignature[] = [
  { agentName: 'Claude Code', commandLineSubstrings: ['claude', '.claude/', '.claude\\'] },
  { agentName: 'Codex', commandLineSubstrings: ['codex', '.codex/', '.codex\\'] },
  { agentName: 'Pi', commandLineSubstrings: ['.pi/', '.pi\\'] },
  { agentName: 'Prime Agent', commandLineSubstrings: ['prime-agent', '.prime-agent/'] }
  // Adding a future agent CLI = append one entry here. No other file changes needed
  // for detection (UI/registry-editing is explicitly out of scope).
]

export function matchIdleAgentCleanupSignature(
  commandLine: string
): IdleAgentCleanupSignature | null {
  for (const signature of IDLE_AGENT_CLEANUP_SIGNATURES) {
    if (signature.commandLineSubstrings.some((needle) => commandLine.includes(needle))) {
      return signature
    }
  }
  return null
}

/**
 * Pane-lineage fallback: a candidate whose own command line carries no agent
 * signature (e.g. `find.exe` spawned from a Claude Code shell) can still match
 * through the owning pane's root shell/agent command line.
 */
export function matchIdleAgentCleanupCandidate(
  candidateCommandLine: string,
  paneRootCommandLine: string
): IdleAgentCleanupSignature | null {
  return (
    matchIdleAgentCleanupSignature(candidateCommandLine) ??
    matchIdleAgentCleanupSignature(paneRootCommandLine)
  )
}
